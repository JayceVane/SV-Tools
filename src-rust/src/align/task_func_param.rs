use regex::Regex;

use crate::config::FormatOptions;
use crate::parser::patterns::PORT_DIRS;

/// Align task/function/property/sequence/checker parameter declarations.
/// Input text is the full declaration from keyword to semicolon.
/// Returns (formatted_text, remaining_text_after_semicolon).
pub fn align_task_func_param(
    txt: &str,
    ilvl: usize,
    options: &FormatOptions,
    indent: &str,
) -> (String, String) {
    // Find the opening parenthesis of the parameter list
    let paren_start = match find_param_open_paren(txt) {
        Some(pos) => pos,
        None => return (txt.to_string(), String::new()),
    };

    let header = txt[..paren_start].trim_end();

    // Find matching closing parenthesis using balanced matching
    let mut depth = 1i32;
    let mut i = paren_start + 1;
    let bytes = txt.as_bytes();
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    let paren_end = i - 1;
    let args_content = &txt[paren_start + 1..paren_end];

    // Find semicolon after )
    let after_paren = &txt[paren_end + 1..];
    let semicolon_pos = after_paren.find(';');
    let remaining = match semicolon_pos {
        Some(pos) => after_paren[pos + 1..].to_string(),
        None => String::new(),
    };

    // Handle empty args
    let args_trimmed = args_content.trim();
    if args_trimmed.is_empty() {
        let mut txt_new = format!("{}();\n", header);
        txt_new.push_str(&remaining);
        return (txt_new, String::new());
    }

    // Use the same port alignment regex as align_module_port
    let re_port = Regex::new(
        r#"(?m)^[ \t]*(?P<dir>[\w\.]+)[ \t]+(?P<var>var|ref\b)?[ \t]*(?P<type>[\w\:]+\b)?[ \t]*(?P<sign>signed|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)[ \t]*(?P<ports>(?P<port1>\w+)(?:[ \t]*,[ \t]*\w+)*)[ \t]*(?P<comment>,?.*)"#,
    ).unwrap();

    // Split multi-direction lines (e.g., "input a, output b" → "input a,\n output b")
    let txt_port = Regex::new(r"[ \t]*,[ \t]*(input|output|inout|ref)\b[ \t]+")
        .unwrap()
        .replace_all(args_trimmed, |caps: &regex::Captures| {
            format!(",\n{} ", caps.get(1).unwrap().as_str())
        })
        .to_string();

    let decl: Vec<_> = re_port.captures_iter(&txt_port).collect();

    if decl.is_empty() {
        // Can't parse args, just output as-is with proper indentation
        let mut txt_new = format!("{} (\n", header);
        for arg_line in txt_port.split('\n') {
            let l = arg_line.trim();
            if !l.is_empty() {
                txt_new.push_str(&format!("{}{}\n", indent.repeat(ilvl + 1), l));
            }
        }
        txt_new.push_str(&format!("{})", indent.repeat(ilvl)));
        return (format!("{};\n", txt_new), remaining);
    }

    // Calculate column widths — same logic as align_module_port
    let port_dir_l: Vec<&str> = decl
        .iter()
        .filter_map(|d| d.name("dir").map(|x| x.as_str()))
        .filter(|x| PORT_DIRS.contains(x))
        .collect();
    let _port_if_l: Vec<&str> = decl
        .iter()
        .filter_map(|d| d.name("dir").map(|x| x.as_str()))
        .filter(|x| !PORT_DIRS.contains(x))
        .collect();

    let len_dir = port_dir_l.iter().map(|x| x.len()).max().unwrap_or(0);

    let mut len_bw_a: Vec<usize> = Vec::new();
    for d in &decl {
        if let Some(bw) = d.name("bw") {
            let bw_clean = Regex::new(r"\s*").unwrap().replace_all(bw.as_str(), "");
            for (bi, inner) in Regex::new(r"\[(.+?)\]")
                .unwrap()
                .find_iter(&bw_clean)
                .enumerate()
            {
                let content = &inner.as_str()[1..inner.as_str().len() - 1];
                if bi >= len_bw_a.len() {
                    len_bw_a.push(content.len());
                } else if len_bw_a[bi] < content.len() {
                    len_bw_a[bi] = content.len();
                }
            }
        }
    }
    let len_bw: usize = len_bw_a.iter().sum::<usize>() + 2 * len_bw_a.len();

    // Calculate column widths for var and type
    let mut len_var: usize = 0;
    let mut len_type: usize = 0;
    for d in &decl {
        if let Some(v) = d.name("var") {
            len_var = len_var.max(v.as_str().len());
        }
        let tp = d.name("type").map(|x| x.as_str().trim()).unwrap_or("");
        if !tp.is_empty() {
            len_type = len_type.max(tp.len());
        }
    }
    let has_var = len_var > 0;
    let has_type = len_type > 0;

    // Calculate max prefix length
    let mut max_prefix_len: usize = 0;
    for d in &decl {
        let dir = d.name("dir").unwrap().as_str();
        if !PORT_DIRS.contains(&dir) {
            max_prefix_len = max_prefix_len.max(dir.len());
            continue;
        }
        let tp = d.name("type").map(|x| x.as_str().trim()).unwrap_or("");
        let mut plen = len_dir;
        if has_var {
            plen += 1 + len_var;
        }
        if has_type {
            plen += 1 + len_type;
        } else if !tp.is_empty() {
            plen += 1 + tp.len();
        }
        let bw = d.name("bw").map(|x| x.as_str()).unwrap_or("");
        if !bw.is_empty() {
            let bw_clean = Regex::new(r"\s*").unwrap().replace_all(bw, "");
            plen += 1 + bw_clean.len();
        } else if len_bw > 0 {
            plen += 1 + len_bw;
        }
        max_prefix_len = max_prefix_len.max(plen);
    }

    // Round up to tab boundary
    let tab_size = options.nb_space();
    let max_prefix_len = if tab_size > 0 {
        max_prefix_len + (tab_size - max_prefix_len % tab_size)
    } else {
        max_prefix_len + 1
    };

    // Calculate port name column width
    let mut max_port_len: usize = 0;
    for d in &decl {
        let mut s = d.name("ports").unwrap().as_str().trim().to_string();
        if s.ends_with(',') {
            s = s[..s.len() - 1].trim().to_string();
        }
        if s.contains(',') {
            s = d.name("port1").unwrap().as_str().to_string();
        }
        max_port_len = max_port_len.max(s.len());
    }

    // Build output
    let mut txt_new = format!("{} (\n", header);
    let lines: Vec<&str> = txt_port.split('\n').collect();

    for (i, orig_line) in lines.iter().enumerate() {
        let l = orig_line.trim();
        if (i != lines.len() - 1 && i != 0 && (options.strip_empty_line() || !l.is_empty()))
            || !l.is_empty()
        {
            if let Some(m_port) = re_port.captures(l) {
                if options.reindent_only() {
                    txt_new.push_str(&format!("{}{}\n", indent.repeat(ilvl + 1), l));
                } else {
                    let mut l_new = format!("{}", indent.repeat(ilvl + 1));
                    let dir = m_port.name("dir").unwrap().as_str();

                    if PORT_DIRS.contains(&dir) {
                        l_new.push_str(&format!("{:<width$}", dir, width = len_dir));
                        let var = m_port.name("var").map(|x| x.as_str());
                        let tp = m_port.name("type").map(|x| x.as_str().trim()).unwrap_or("");
                        let bw_raw = m_port.name("bw").map(|x| x.as_str()).unwrap_or("");

                        if has_var {
                            if let Some(v) = var {
                                l_new.push_str(&format!(" {:<width$}", v, width = len_var));
                            } else {
                                l_new.push_str(&format!(" {:width$}", "", width = len_var));
                            }
                        }
                        if has_type || !tp.is_empty() {
                            if !tp.is_empty() {
                                l_new.push_str(&format!(
                                    " {:<width$}",
                                    tp,
                                    width = len_type.max(tp.len())
                                ));
                            } else if has_type {
                                l_new.push_str(&format!(" {:width$}", "", width = len_type));
                            }
                        }
                        if !bw_raw.is_empty() {
                            let bw_clean = Regex::new(r"\s*").unwrap().replace_all(bw_raw, "");
                            let mut bw_s = String::new();
                            for (bi, inner) in Regex::new(r"\[(.+?)\]")
                                .unwrap()
                                .find_iter(&bw_clean)
                                .enumerate()
                            {
                                let content = &inner.as_str()[1..inner.as_str().len() - 1];
                                let w = len_bw_a.get(bi).unwrap_or(&0);
                                bw_s.push_str(&format!("[{:>width$}]", content, width = w));
                            }
                            l_new.push_str(&format!(" {:<width$}", bw_s, width = len_bw));
                        } else if len_bw > 0 {
                            l_new.push_str(&format!(" {:width$}", "", width = len_bw));
                        }

                        // Pad to max_prefix_len
                        let current_len = l_new.len() - indent.repeat(ilvl + 1).len();
                        if current_len < max_prefix_len {
                            l_new.push_str(&format!(
                                "{:width$}",
                                "",
                                width = max_prefix_len - current_len
                            ));
                        }
                        l_new.push(' ');
                    } else {
                        // Non-direction (interface port style)
                        l_new.push_str(&format!("{:<width$}", dir, width = max_prefix_len + 1));
                    }

                    // Port name
                    let ports_raw = m_port.name("ports").unwrap().as_str();
                    let comment_raw = m_port.name("comment").map(|x| x.as_str()).unwrap_or("");
                    let has_trailing_comma = comment_raw.trim_start().starts_with(',');
                    let comment = if has_trailing_comma {
                        comment_raw
                            .trim_start()
                            .strip_prefix(',')
                            .unwrap_or(comment_raw)
                            .trim_start()
                    } else {
                        comment_raw
                    };
                    let port_name = m_port.name("port1").unwrap().as_str();
                    let ports_str = if ports_raw.contains(',') {
                        ports_raw
                            .split(',')
                            .map(|p| p.trim())
                            .collect::<Vec<_>>()
                            .join(", ")
                    } else {
                        port_name.to_string()
                    };

                    if has_trailing_comma {
                        if options.align_comma() {
                            l_new.push_str(&ports_str);
                            if ports_str.len() < max_port_len {
                                l_new.push_str(&format!(
                                    "{:width$}",
                                    "",
                                    width = max_port_len - ports_str.len()
                                ));
                            }
                        } else {
                            l_new.push_str(&ports_str);
                        }
                        if i != lines.len() - 1 {
                            l_new.push(',');
                        }
                    } else {
                        l_new.push_str(&ports_str);
                    }

                    if !comment.is_empty() {
                        l_new.push_str(&format!(" {}", comment));
                    }
                    txt_new.push_str(&format!(
                        "{}\n",
                        l_new.trim_end_matches(|c| c == ' ' || c == '\t')
                    ));
                }
            } else {
                txt_new.push_str(&format!("{}{}\n", indent.repeat(ilvl + 1), l));
            }
        }
    }

    txt_new.push_str(&format!("{})", indent.repeat(ilvl)));
    (format!("{};\n", txt_new), remaining)
}

/// Find the opening parenthesis for the parameter/argument list.
/// Skips any #(...) parameter declarations.
fn find_param_open_paren(txt: &str) -> Option<usize> {
    let bytes = txt.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' && i + 1 < bytes.len() && bytes[i + 1] == b'(' {
            // Skip this #(...) block
            let mut depth = 0i32;
            i += 1; // skip #
            while i < bytes.len() {
                if bytes[i] == b'(' {
                    depth += 1;
                } else if bytes[i] == b')' {
                    depth -= 1;
                    if depth == 0 {
                        i += 1;
                        break;
                    }
                }
                i += 1;
            }
        } else if bytes[i] == b'(' {
            return Some(i);
        } else {
            i += 1;
        }
    }
    None
}
