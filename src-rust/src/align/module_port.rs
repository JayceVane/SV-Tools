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
            eprintln!(
                "[DEBUG] align_module_port: regex failed to match: {:?}",
                txt
            );
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
        let re_param_str = r"^[ \t]*(?:(?P<parameter>parameter|localparam)\s+)?\
         (?P<type>[\w\:]+\b)?[ \t]*\
         (?P<sign>signed|unsigned\b)?[ \t]*\
         (?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)\
         [ \t]*(?P<param>\w+)\b\s*=\s*\
         (?P<value>[^\n]*?)(?P<comment>$|//.*?$)";
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
        r#"(?m)^[ \t]*(?P<dir>[\w\.]+)[ \t]+(?P<var>var|ref\b)?[ \t]*(?P<type>[\w\:]+\b)?[ \t]*(?P<sign>signed|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)[ \t]*(?P<ports>(?P<port1>\w+)[\w, \t\[\]\*\-\+\$\(\)\'\:\)]*)[ \t]*(?P<comment>.*)"#,
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

    // Determine type column widths
    let mut len_type: usize = 0;
    let mut len_type_user: usize = 0;
    let mut len_sign: usize = 0;
    let mut len_var: usize = 0;

    for d in &decl {
        let tp = d.name("type").map(|x| x.as_str().trim()).unwrap_or("");
        let sign = d.name("sign").map(|x| x.as_str()).unwrap_or("");
        let bw = d.name("bw").map(|x| x.as_str()).unwrap_or("");
        let var = d.name("var").map(|x| x.as_str()).unwrap_or("");

        if !var.is_empty() {
            len_var = 3;
        }

        if sign == "" && bw == "" && !["logic", "wire", "reg", "signed", "unsigned"].contains(&tp) {
            len_type_user = len_type_user.max(tp.len());
        } else {
            if tp != "signed" && tp != "unsigned" {
                len_type = len_type.max(tp.len());
            }
        }

        if ["signed", "unsigned"].contains(&tp) || ["signed", "unsigned"].contains(&sign) {
            len_sign = len_sign.max(tp.len()).max(sign.len());
        }
    }

    let len_type_full = len_type
        + if len_var > 0 { 1 + len_var } else { 0 }
        + if len_bw > 0 { 1 + len_bw } else { 0 }
        + if len_sign > 0 { 1 + len_sign } else { 0 };

    let max_len = if len_type_user < len_type_full {
        len_type_full
    } else {
        len_type_user
    };
    let len_type_user = if len_if < max_len + len_dir + 1 {
        max_len
    } else {
        len_if - len_dir - 1
    };
    let len_if = len_if.max(max_len + len_dir + 1);
    let len_type_user = if len_var > 0 {
        len_type_user.saturating_sub(len_var + 1)
    } else {
        len_type_user
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

    // Rewrite each port line with alignment
    let lines: Vec<&str> = txt_port.split('\n').collect();
    for (i, orig_line) in lines.iter().enumerate() {
        let l = orig_line.trim();

        if options.ignore_tick() && l.starts_with('`') {
            txt_new.push_str(&format!("{}\n", orig_line));
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
                        l_new.push_str(&format!("{:<width$}", dir, width = len_dir));
                        if len_var > 0 {
                            if let Some(v) = m_port.name("var") {
                                l_new.push_str(&format!(" {}", v.as_str()));
                            } else {
                                l_new.push_str(&format!("{:width$}", "", width = len_var + 1));
                            }
                        }

                        let tp = m_port.name("type").map(|x| x.as_str().trim()).unwrap_or("");
                        let sign = m_port.name("sign").map(|x| x.as_str().trim()).unwrap_or("");
                        let bw = m_port.name("bw").map(|x| x.as_str()).unwrap_or("");

                        if !sign.is_empty()
                            || !bw.is_empty()
                            || ["logic", "wire", "reg", "signed", "unsigned"].contains(&tp)
                        {
                            if len_type > 0 {
                                if !tp.is_empty() {
                                    if tp != "signed" && tp != "unsigned" {
                                        l_new.push_str(&format!(
                                            " {:<width$}",
                                            tp,
                                            width = len_type
                                        ));
                                    } else {
                                        l_new.push_str(&format!(
                                            "{:width$}",
                                            "",
                                            width = len_type + 1
                                        ));
                                        l_new.push_str(&format!(
                                            " {:<width$}",
                                            tp,
                                            width = len_sign
                                        ));
                                    }
                                } else {
                                    l_new.push_str(&format!("{:width$}", "", width = len_type + 1));
                                }
                                if len_sign > 0 {
                                    if !sign.is_empty() {
                                        l_new.push_str(&format!(
                                            " {:<width$}",
                                            sign,
                                            width = len_sign
                                        ));
                                    } else if !["signed", "unsigned"].contains(&tp) {
                                        l_new.push_str(&format!(
                                            "{:width$}",
                                            "",
                                            width = len_sign + 1
                                        ));
                                    }
                                }
                            } else if len_sign > 0 {
                                if ["signed", "unsigned"].contains(&tp) {
                                    l_new.push_str(&format!(" {:<width$}", tp, width = len_sign));
                                } else if !sign.is_empty() {
                                    l_new.push_str(&format!(" {:<width$}", sign, width = len_sign));
                                } else {
                                    l_new.push_str(&format!("{:width$}", "", width = len_sign + 1));
                                }
                            }

                            if len_bw > 1 {
                                let s = if !bw.is_empty() {
                                    let bw_clean = Regex::new(r"\s*").unwrap().replace_all(bw, "");
                                    let mut s = " ".to_string();
                                    for (bi, inner) in Regex::new(r"\[(.+?)\]")
                                        .unwrap()
                                        .find_iter(&bw_clean)
                                        .enumerate()
                                    {
                                        let content = &inner.as_str()[1..inner.as_str().len() - 1];
                                        let w = len_bw_a.get(bi).unwrap_or(&0);
                                        s.push_str(&format!("[{:>width$}]", content, width = w));
                                    }
                                    s
                                } else {
                                    String::new()
                                };
                                l_new.push_str(&format!("{:<width$}", s, width = len_bw + 1));
                            }

                            if max_len > len_type_full {
                                l_new.push_str(&format!(
                                    "{:width$}",
                                    "",
                                    width = max_len - len_type_full
                                ));
                            }
                        } else if !tp.is_empty() {
                            l_new.push_str(&format!(" {:<width$}", tp, width = len_type_user));
                        } else if len_type_user > 0 {
                            l_new.push_str(&format!("{:width$}", "", width = len_type_user + 1));
                        }
                    } else {
                        // Interface port
                        l_new.push_str(&format!("{:<width$}", dir, width = len_if));
                    }

                    // Port list
                    let ports_raw = m_port.name("ports").unwrap().as_str();
                    let has_trailing_comma = ports_raw.trim_end().ends_with(',');
                    let ports = Regex::new(r"\s*,\s*")
                        .unwrap()
                        .replace_all(ports_raw.trim_end_matches(','), ", ");
                    let ports_str = ports.to_string();
                    l_new.push(' ');

                    if has_trailing_comma {
                        // Port has trailing comma - align and add comma if not last line
                        if options.align_comma() {
                            l_new.push_str(&format!(
                                "{:<width$}",
                                &ports_str,
                                width = max_port_len
                            ));
                        } else {
                            l_new.push_str(&ports_str);
                        }
                        if i != lines.len() - 1 {
                            l_new.push(',');
                        }
                    } else {
                        l_new.push_str(&format!(
                            "{:<width$} ",
                            ports_str.trim_end_matches(','),
                            width = max_port_len
                        ));
                    }

                    if let Some(comment) = m_port.name("comment") {
                        if !comment.as_str().is_empty() {
                            l_new.push_str(&format!(" {}", comment.as_str()));
                        }
                    }
                    txt_new.push_str(&format!(
                        "{}\n",
                        l_new.trim_end_matches(|c| c == ' ' || c == '\t')
                    ));
                }
            } else {
                // No port match
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
