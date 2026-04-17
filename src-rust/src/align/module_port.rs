use regex::Regex;

use crate::config::FormatOptions;
use crate::parser::comments::clean_comment;
use crate::parser::patterns::*;

/// Split text on comma respecting parenthesis nesting.
/// Replicates Python `split_on_comma()`.
pub fn split_on_comma(txt: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut s = String::new();
    let mut lvl = 0i32;

    for c in txt.chars() {
        if c == ',' && lvl == 0 {
            result.push(s.clone());
            s.clear();
        } else {
            s.push(c);
            if c == '(' {
                lvl += 1;
            } else if c == ')' && lvl > 0 {
                lvl -= 1;
            }
        }
    }
    let trimmed = s.trim().to_string();
    if !trimmed.is_empty() {
        result.push(trimmed);
    }
    result
}

/// Align ANSI-style module/interface port declarations.
/// Replicates Python `VerilogBeautifier.alignModulePort()`.
/// Returns (formatted_text, remaining_text_after_semicolon) on success.
pub fn align_module_port(
    txt: &str,
    ilvl: usize,
    options: &FormatOptions,
    indent: &str,
    indent_space: &str,
) -> (String, String) {
    // Extract module/interface header - match up to opening parenthesis of ports
    let re_module = Regex::new(concat!(
        r"(?s)(?P<module>^[ \t]*(?:module|interface))\s*(?P<mname>\w+)",
        r"(?P<import>\s+import\s+.*?;)?\s*",
        r"(?P<paramsfull>#\s*\(\s*(?P<params>.*?)\s*\))?",
        r"\s*\("
    ))
    .unwrap();

    let m = match re_module.captures(txt) {
        Some(caps) => caps,
        None => {
            return (String::new(), String::new());
        }
    };

    // Find the position after the opening parenthesis
    let paren_start = m.get(0).unwrap().end();

    // Find matching closing parenthesis using balanced matching
    let mut depth = 1i32;
    let mut i = paren_start;
    let bytes = txt.as_bytes();
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'/' if i + 1 < bytes.len() && (bytes[i + 1] == b'/' || bytes[i + 1] == b'*') => {
                i = skip_comment(txt, i);
                continue;
            }
            b'"' => {
                i = skip_comment(txt, i);
                continue;
            }
            _ => {}
        }
        i += 1;
    }

    let ports_end = if depth == 0 { i - 1 } else { txt.len() };
    let ports_content = &txt[paren_start..ports_end];

    // Find semicolon after ports
    let after_ports = &txt[ports_end + 1..];
    let semicolon_pos = after_ports.find(';');
    let remaining = match semicolon_pos {
        Some(pos) => after_ports[pos + 1..].to_string(),
        None => String::new(),
    };

    let module_kw = m.name("module").unwrap().as_str().trim();
    let mname = m.name("mname").unwrap().as_str().trim();

    let mut txt_new = format!("{}{} {}", indent.repeat(ilvl), module_kw, mname);

    // Add optional import declaration
    if let Some(import_match) = m.name("import") {
        let imports: Vec<&str> = import_match.as_str().trim().split('\n').collect();
        if imports.len() == 1 && options.import_same_line() {
            txt_new = format!("{} {} ", txt_new, imports[0].trim());
        } else {
            txt_new.push('\n');
            for imp in imports {
                txt_new.push_str(&format!("{}{}\n", indent.repeat(ilvl + 1), imp.trim()));
            }
        }
    }

    // Add optional parameter declaration
    if let Some(params_match) = m.name("params") {
        let param_txt = params_match.as_str().trim();
        let re_param_str = r"(?m)^[ \t]*(?:(?P<parameter>parameter|localparam)\s+)?(?P<type>[\w\:]+\b)?[ \t]*(?P<sign>signed|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)[ \t]*(?P<param>\w+)\b\s*=\s*(?P<value>[^\n]*?)(?P<comment>$|//.*?$)";
        let re_param = Regex::new(re_param_str).unwrap();

        let decl: Vec<_> = re_param.captures_iter(param_txt).collect();

        if m.name("import").is_some() {
            txt_new.push_str(&format!("{}#(", indent.repeat(ilvl)));
        } else {
            txt_new.push_str(" #(");
        }

        if !decl.is_empty() {
            // Calculate column widths
            let len_kw: usize = decl
                .iter()
                .map(|d| d.name("parameter").map(|x| x.as_str().len()).unwrap_or(0))
                .max()
                .unwrap_or(0);
            let len_type: usize = decl
                .iter()
                .filter(|d| {
                    let t = d.name("type").map(|x| x.as_str().trim()).unwrap_or("");
                    t != "signed" && t != "unsigned"
                })
                .map(|d| d.name("type").map(|x| x.as_str().len()).unwrap_or(0))
                .max()
                .unwrap_or(0);
            let len_sign: usize = decl
                .iter()
                .map(|d| d.name("sign").map(|x| x.as_str().len()).unwrap_or(0))
                .max()
                .unwrap_or(0);
            let len_param: usize = decl
                .iter()
                .map(|d| d.name("param").unwrap().as_str().len())
                .max()
                .unwrap_or(0);

            let values: Vec<String> = decl
                .iter()
                .map(|d| {
                    let val_str = d.name("value").unwrap().as_str();
                    clean_comment(&split_on_comma(val_str)[0])
                        .trim()
                        .to_string()
                })
                .collect();
            let len_value: usize = values.iter().map(|v| v.len()).max().unwrap_or(0);

            let has_param_list: Vec<&str> = decl
                .iter()
                .filter_map(|d| d.name("parameter").map(|x| x.as_str()))
                .collect();
            let has_param_all = has_param_list.len() == decl.len();
            let has_param = !has_param_list.is_empty();
            let last_param = has_param_list.first().unwrap_or(&"parameter");

            if has_param && !has_param_all {
                txt_new.push_str(last_param);
            }

            // If multi-line or paramOneLine is off, format parameter alignment
            if param_txt.contains('\n') || !options.param_one_line() {
                txt_new.push('\n');
                let lines: Vec<&str> = param_txt.split('\n').collect();
                let mut last_kw = last_param.to_string();

                for (i, line) in lines.iter().enumerate() {
                    let l = line.trim();
                    if i == 0 && l == last_kw {
                        continue;
                    }
                    let mut l_new = format!("{}", indent.repeat(ilvl + 1));
                    if let Some(m_param) = re_param.captures(l) {
                        if !options.reindent_only() {
                            if let Some(p) = m_param.name("parameter") {
                                last_kw = p.as_str().to_string();
                            }
                            if has_param_all {
                                l_new.push_str(&format!("{:<width$}", last_kw, width = len_kw + 1));
                            }
                            if len_type > 0 {
                                if let Some(t) = m_param.name("type") {
                                    if t.as_str().trim() != "signed"
                                        && t.as_str().trim() != "unsigned"
                                    {
                                        l_new.push_str(&format!(
                                            "{:<width$}",
                                            t.as_str().trim(),
                                            width = len_type + 1
                                        ));
                                    } else {
                                        l_new.push_str(&format!(
                                            "{:width$}",
                                            "",
                                            width = len_type + 1
                                        ));
                                        l_new.push_str(&format!(
                                            "{:<width$}",
                                            t.as_str().trim(),
                                            width = len_sign + 1
                                        ));
                                    }
                                } else {
                                    l_new.push_str(&format!("{:width$}", "", width = len_type + 1));
                                }
                            }
                            if len_sign > 0 {
                                if let Some(s) = m_param.name("sign") {
                                    l_new.push_str(&format!(
                                        "{:<width$}",
                                        s.as_str().trim(),
                                        width = len_sign + 1
                                    ));
                                } else if m_param.name("type").map(|x| x.as_str().trim())
                                    != Some("signed")
                                    && m_param.name("type").map(|x| x.as_str().trim())
                                        != Some("unsigned")
                                {
                                    l_new.push_str(&format!("{:width$}", "", width = len_sign + 1));
                                }
                            }
                            l_new.push_str(&format!(
                                "{:<width$}",
                                m_param.name("param").unwrap().as_str(),
                                width = len_param
                            ));
                            l_new.push_str(&format!(
                                " = {:<width$}",
                                values[i].clone().min(
                                    values[values.len().min(i)..]
                                        .first()
                                        .map(|s| s.as_str())
                                        .unwrap_or("")
                                        .to_string()
                                ),
                                width = len_value
                            ));

                            if let Some(comment) = m_param.name("comment") {
                                if !comment.as_str().is_empty() {
                                    l_new.push_str(&format!(" {}", comment.as_str()));
                                }
                            }

                            // Add trailing comma if original line had one
                            let l_trimmed = l.trim_end();
                            if l_trimmed.ends_with(',') && !l_new.trim_end().ends_with(',') {
                                l_new.push(',');
                            }
                        } else {
                            l_new.push_str(l);
                        }
                    } else {
                        l_new.push_str(l);
                    }

                    if !options.strip_empty_line() || !l_new.trim().is_empty() {
                        txt_new.push_str(&format!("{}\n", l_new.trim_end()));
                    }
                }
            } else {
                if has_param && !has_param_all {
                    txt_new.push(' ');
                }
                txt_new.push_str(param_txt);
                txt_new.push_str(&format!("\n{}", indent.repeat(ilvl)));
            }
        } else {
            // No parameters parsed, just indent
            txt_new.push('\n');
            txt_new.push_str(&format!("{}{}", indent.repeat(ilvl + 1), param_txt));
            txt_new.push_str(&format!("\n{}", indent.repeat(ilvl)));
        }

        txt_new.push(')');
    }

    // Handle no ports (empty or whitespace only)
    let ports_trimmed = ports_content.trim();
    if ports_trimmed.is_empty() {
        if !options.reindent_only() {
            txt_new.push_str(" ()");
        }
        return (format!("{};\n", txt_new), remaining);
    }

    // Add port list
    if !txt_new.ends_with('\n') {
        txt_new.push(' ');
    }
    txt_new.push_str("(\n");

    let ports_txt = ports_trimmed;
    let re_port = Regex::new(
        r#"(?m)^[ \t]*(?P<dir>[\w\.]+)[ \t]+(?P<var>var|ref\b)?[ \t]*(?P<type>[\w\:]+\b)?[ \t]*(?P<sign>signed|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)[ \t]*(?P<ports>(?P<port1>\w+)(?:[ \t]*,[ \t]*\w+)*)[ \t]*(?P<comment>,?.*)"#,
    )
    .unwrap();

    // Split multi-direction lines
    let txt_port = Regex::new(r"[ \t]*,[ \t]*(input|output|inout)\b[ \t]+")
        .unwrap()
        .replace_all(ports_txt, |caps: &regex::Captures| {
            format!(",\n{} ", caps.get(1).unwrap().as_str())
        })
        .to_string();

    let decl: Vec<_> = re_port.captures_iter(&txt_port).collect();

    // Calculate column widths
    let port_dir_l: Vec<&str> = decl
        .iter()
        .filter_map(|d| d.name("dir").map(|x| x.as_str()))
        .filter(|x| PORT_DIRS.contains(x))
        .collect();
    let port_if_l: Vec<&str> = decl
        .iter()
        .filter_map(|d| d.name("dir").map(|x| x.as_str()))
        .filter(|x| !PORT_DIRS.contains(x))
        .collect();

    let len_dir = port_dir_l.iter().map(|x| x.len()).max().unwrap_or(0);
    let len_if = port_if_l.iter().map(|x| x.len()).max().unwrap_or(0);

    let mut len_bw_a: Vec<usize> = Vec::new();
    for d in &decl {
        if let Some(bw) = d.name("bw") {
            let bw_clean = Regex::new(r"\s*").unwrap().replace_all(bw.as_str(), "");
            for (i, inner) in Regex::new(r"\[(.+?)\]")
                .unwrap()
                .find_iter(&bw_clean)
                .enumerate()
            {
                let content = &inner.as_str()[1..inner.as_str().len() - 1];
                if i >= len_bw_a.len() {
                    len_bw_a.push(content.len());
                } else if len_bw_a[i] < content.len() {
                    len_bw_a[i] = content.len();
                }
            }
        }
    }
    let len_bw: usize = len_bw_a.iter().sum::<usize>() + 2 * len_bw_a.len();

    // Python-style alignment: calculate prefix length for each declaration
    // prefix = dir [+ var] [+ type] [+ sign] [+ range]
    // Then pad all prefixes to the same length
    let mut max_prefix_len: usize = 0;

    for d in &decl {
        let dir = d.name("dir").unwrap().as_str();
        if !PORT_DIRS.contains(&dir) {
            max_prefix_len = max_prefix_len.max(dir.len());
            continue;
        }

        let var = d.name("var").map(|x| x.as_str());
        let tp = d.name("type").map(|x| x.as_str().trim()).unwrap_or("");
        let sign = d.name("sign").map(|x| x.as_str().trim()).unwrap_or("");
        let bw = d.name("bw").map(|x| x.as_str()).unwrap_or("");

        // Calculate prefix length: dir [+ ' ' + var] [+ ' ' + type] [+ ' ' + sign] [+ ' ' + bw]
        let mut plen = dir.len();
        if let Some(v) = var {
            plen += 1 + v.len();
        }
        if !tp.is_empty() {
            plen += 1 + tp.len();
        }
        if !sign.is_empty() {
            plen += 1 + sign.len();
        }
        if !bw.is_empty() {
            let bw_clean = Regex::new(r"\s*").unwrap().replace_all(bw, "");
            plen += 1 + bw_clean.len();
        }

        max_prefix_len = max_prefix_len.max(plen);
    }

    // Round up max_prefix_len to tab boundary for clean alignment
    let tab_size = options.nb_space();
    let max_prefix_len = if tab_size > 0 {
        let aligned = max_prefix_len + (tab_size - max_prefix_len % tab_size);
        aligned
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

    // Python-style alignment with dedicated columns for var/type/sign/bw
    // Each column has a fixed width; lines without content in a column still reserve the space.
    let mut len_var: usize = 0; // "var" keyword width
    let mut len_type: usize = 0; // type (reg/wire/logic/user-defined) width

    for d in &decl {
        if let Some(v) = d.name("var") {
            len_var = len_var.max(v.as_str().len());
        }
        let tp = d.name("type").map(|x| x.as_str().trim()).unwrap_or("");
        // Only count standard types (reg/wire/logic) for the type column
        // User-defined types are handled separately
        if ["reg", "wire", "logic"].contains(&tp) {
            len_type = len_type.max(tp.len());
        }
    }

    // Calculate prefix length for each declaration
    // prefix = len_dir [+ 1+len_var] [+ 1+len_type] [+ 1+len_sign] [+ 1+len_bw]
    // All lines use the same column widths regardless of whether they have content
    let has_var = len_var > 0;
    let has_type = len_type > 0;

    let mut max_prefix_len: usize = 0;

    for d in &decl {
        let dir = d.name("dir").unwrap().as_str();
        if !PORT_DIRS.contains(&dir) {
            continue;
        }

        let tp = d.name("type").map(|x| x.as_str().trim()).unwrap_or("");
        let is_standard_type = ["reg", "wire", "logic"].contains(&tp);

        let mut plen = len_dir; // fixed direction column

        // Var column: always reserve space if any line has var
        if has_var {
            plen += 1 + len_var;
        }
        // Type column: always reserve space if any line has standard type
        if has_type {
            plen += 1 + len_type;
        }
        // If this line has a user-defined type (not reg/wire/logic), it goes in type column
        // but we need to ensure the column is wide enough
        if !is_standard_type && !tp.is_empty() {
            // User-defined type - needs its own column width
            // For now, include in type column but ensure width
            plen = plen.max(len_dir + (if has_var { 1 + len_var } else { 0 }) + 1 + tp.len());
        }

        let bw = d.name("bw").map(|x| x.as_str()).unwrap_or("");
        if !bw.is_empty() {
            let bw_clean = Regex::new(r"\s*").unwrap().replace_all(bw, "");
            plen += 1 + bw_clean.len();
        } else if len_bw > 0 {
            // Reserve space for bw column even if this line doesn't have it
            plen += 1 + len_bw;
        }

        max_prefix_len = max_prefix_len.max(plen);
    }

    // Round up max_prefix_len to tab boundary for clean alignment
    let tab_size = options.nb_space();
    let max_prefix_len = if tab_size > 0 {
        let aligned = max_prefix_len + (tab_size - max_prefix_len % tab_size);
        aligned
    } else {
        max_prefix_len + 1
    };

    // Rewrite each port line with alignment
    let lines: Vec<&str> = txt_port.split('\n').collect();

    for (i, orig_line) in lines.iter().enumerate() {
        let l = orig_line.trim();

        if options.ignore_tick() && l.starts_with('`') {
            txt_new.push_str(&format!("{}{}\n", indent.repeat(ilvl + 1), l));
        } else if (i != lines.len() - 1 && i != 0 && (options.strip_empty_line() || !l.is_empty()))
            || !l.is_empty()
        {
            if let Some(m_port) = re_port.captures(l) {
                if options.reindent_only() {
                    txt_new.push_str(&format!("{}{}\n", indent.repeat(ilvl + 1), l));
                } else {
                    let mut l_new = format!("{}", indent.repeat(ilvl + 1));
                    let dir = m_port.name("dir").unwrap().as_str();

                    if PORT_DIRS.contains(&dir) {
                        // Build prefix with fixed column widths
                        l_new.push_str(&format!("{:<width$}", dir, width = len_dir));

                        let var = m_port.name("var").map(|x| x.as_str());
                        let tp = m_port.name("type").map(|x| x.as_str().trim()).unwrap_or("");
                        let sign = m_port.name("sign").map(|x| x.as_str().trim()).unwrap_or("");
                        let bw_raw = m_port.name("bw").map(|x| x.as_str()).unwrap_or("");

                        // Var column: fixed width if any line has var
                        if has_var {
                            if let Some(v) = var {
                                l_new.push_str(&format!(" {:<width$}", v, width = len_var));
                            } else {
                                l_new.push_str(&format!(" {:width$}", "", width = len_var));
                            }
                        }

                        // Type column: fixed width if any line has standard type
                        if has_type {
                            if ["reg", "wire", "logic"].contains(&tp) {
                                l_new.push_str(&format!(" {:<width$}", tp, width = len_type));
                            } else if !tp.is_empty() {
                                // User-defined type - put in same column
                                l_new.push_str(&format!(" {:<width$}", tp, width = len_type));
                            } else {
                                l_new.push_str(&format!(" {:width$}", "", width = len_type));
                            }
                        }

                        // Sign if present
                        if !sign.is_empty() {
                            l_new.push_str(&format!(" {}", sign));
                        }

                        // Bit-width: fixed width for aligned brackets
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
                            // Reserve space for bw column
                            l_new.push_str(&format!(" {:width$}", "", width = len_bw));
                        }

                        // Pad to max_prefix_len + 1 space before port name
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
                        // Interface port
                        l_new.push_str(&format!("{:<width$}", dir, width = max_prefix_len + 1));
                    }

                    // Port list
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
                    if has_trailing_comma && i != lines.len() - 1 {
                        txt_new.push_str(&format!("{}\n", l_new));
                    } else {
                        txt_new.push_str(&format!(
                            "{}\n",
                            l_new.trim_end_matches(|c| c == ' ' || c == '\t')
                        ));
                    }
                }
            } else {
                let l_new = format!("{}{}", indent.repeat(ilvl + 1), l);
                txt_new.push_str(&format!("{}\n", l_new.trim_end()));
            }
        }
    }

    txt_new.push_str(&format!("{})", indent.repeat(ilvl)));
    (format!("{};\n", txt_new), remaining)
}

/// Skip over a comment or string literal starting at the given position.
/// Returns the position after the comment/string.
fn skip_comment(text: &str, pos: usize) -> usize {
    let bytes = text.as_bytes();
    if pos >= bytes.len() {
        return pos;
    }

    match bytes[pos] {
        b'"' => {
            let mut i = pos + 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'"' {
                    return i + 1;
                }
                i += 1;
            }
            i
        }
        b'/' if pos + 1 < bytes.len() && bytes[pos + 1] == b'/' => {
            let mut i = pos + 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            i
        }
        b'/' if pos + 1 < bytes.len() && bytes[pos + 1] == b'*' => {
            let mut i = pos + 2;
            while i + 1 < bytes.len() {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    return i + 2;
                }
                i += 1;
            }
            text.len()
        }
        _ => pos,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_on_comma() {
        let result = split_on_comma("a, b, c");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_split_on_comma_nested() {
        let result = split_on_comma("a(x, y), b");
        assert_eq!(result, vec!["a(x, y)", "b"]);
    }
}
