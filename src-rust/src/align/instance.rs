use regex::Regex;

use crate::config::FormatOptions;

/// Align module instance port bindings.
/// Replicates Python `VerilogBeautifier.alignInstance()` and `alignInstanceBinding()`.
pub fn align_instance(
    txt: &str,
    ilvl: usize,
    options: &FormatOptions,
    indent: &str,
    indent_space: &str,
) -> String {
    // Handle leading newlines
    let mut leading_newlines = String::new();
    let mut txt_work = txt.to_string();
    while txt_work.trim_start().starts_with('\n') {
        leading_newlines.push('\n');
        let trimmed = txt_work.trim_start();
        txt_work = trimmed[1..].trim_start().to_string();
    }

    // Find module type
    let txt_clean = crate::parser::comments::clean_comment(&txt_work);
    let m_type = match Regex::new(r"^[ \t]*\n?(?P<mtype>(?:(?:bind\s+[\w\.]+\s+)?[ \t]*)?\w+)")
        .unwrap()
        .captures(&txt_clean)
    {
        Some(c) => c,
        None => return String::new(),
    };
    let mtype = m_type.name("mtype").unwrap().as_str().trim();

    let m_type_orig = match Regex::new(r"^[ \t]*\n?\s*\w+").unwrap().captures(&txt_work) {
        Some(c) => c,
        None => return String::new(),
    };
    let mut pos = m_type_orig.get(0).unwrap().end();

    // Helper closures
    let find_next_nonspace = |text: &str, start: usize| -> usize {
        let bytes = text.as_bytes();
        let mut i = start;
        while i < bytes.len() {
            match bytes[i] {
                b' ' | b'\t' | b'\r' | b'\n' => i += 1,
                b'/' if i + 1 < bytes.len() && (bytes[i + 1] == b'/' || bytes[i + 1] == b'*') => {
                    i = skip_comment_or_string(text, i);
                }
                b'"' => return i,
                _ => return i,
            }
        }
        text.len()
    };

    let find_matching_paren = |text: &str, start: usize| -> usize {
        let mut depth = 0i32;
        let mut i = start;
        let bytes = text.as_bytes();
        while i < bytes.len() {
            match bytes[i] {
                b'/' if i + 1 < bytes.len() && (bytes[i + 1] == b'/' || bytes[i + 1] == b'*') => {
                    i = skip_comment_or_string(text, i);
                    continue;
                }
                b'"' => {
                    i = skip_comment_or_string(text, i);
                    continue;
                }
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return i;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        usize::MAX
    };

    let find_char = |text: &str, start: usize, ch: u8| -> usize {
        let mut i = start;
        let bytes = text.as_bytes();
        while i < bytes.len() {
            match bytes[i] {
                b'/' if i + 1 < bytes.len() && (bytes[i + 1] == b'/' || bytes[i + 1] == b'*') => {
                    i = skip_comment_or_string(text, i);
                    continue;
                }
                b'"' => {
                    i = skip_comment_or_string(text, i);
                    continue;
                }
                b if b == ch => return i,
                _ => {}
            }
            i += 1;
        }
        usize::MAX
    };

    // Parse parameters
    let mut params: Option<String> = None;
    let nxt = find_next_nonspace(&txt_work, pos);
    if nxt < txt_work.len() && txt_work.as_bytes()[nxt] == b'#' {
        let paren_pos = find_char(&txt_work, nxt, b'(');
        if paren_pos == usize::MAX {
            return String::new();
        }
        let end_paren = find_matching_paren(&txt_work, paren_pos);
        if end_paren == usize::MAX {
            return String::new();
        }
        params = Some(txt_work[paren_pos + 1..end_paren].to_string());
        pos = end_paren + 1;
    }

    // Parse instance name
    let nxt = find_next_nonspace(&txt_work, pos);
    let m_name = match Regex::new(r"\w+").unwrap().find(&txt_work[nxt..]) {
        Some(m) => m.as_str().to_string(),
        None => return String::new(),
    };
    pos = nxt + m_name.len();

    // Parse ports
    let mut ports: Option<String> = None;
    let nxt = find_next_nonspace(&txt_work, pos);
    if nxt < txt_work.len() && txt_work.as_bytes()[nxt] == b'(' {
        let end_paren = find_matching_paren(&txt_work, nxt);
        if end_paren == usize::MAX {
            return String::new();
        }
        ports = Some(txt_work[nxt + 1..end_paren].to_string());
        pos = end_paren + 1;
    }

    // Parse trailing comment
    let nxt = find_next_nonspace(&txt_work, pos);
    let comment = if nxt < txt_work.len() && txt_work.as_bytes()[nxt] == b';' {
        let nxt2 = find_next_nonspace(&txt_work, nxt + 1);
        if nxt2 < txt_work.len() {
            txt_work[nxt2..].trim().to_string()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    // Build output
    let mut txt_new = format!("{}{}", indent.repeat(ilvl), mtype);

    // Parameters
    if let Some(ref p) = params {
        txt_new.push_str(" #(");
        let p_trimmed = p.trim();
        if p_trimmed.contains('\n') || !options.param_one_line() {
            txt_new.push('\n');
            txt_new.push_str(&align_instance_binding(p, ilvl + 1, options, indent));
            txt_new.push_str(indent);
        } else {
            let p_clean = Regex::new(r"\s+").unwrap().replace_all(p_trimmed, "");
            let p_clean = Regex::new(r"\),").unwrap().replace_all(&p_clean, "), ");
            txt_new.push_str(&p_clean);
        }
        txt_new.push(')');
    }

    // Instance name and ports
    txt_new.push_str(&format!(" {} (", m_name));
    if let Some(ref p) = ports {
        if !p.trim().starts_with(".*") && p.trim().contains('\n') {
            txt_new.push('\n');
        }
        if p.trim().contains('\n') {
            txt_new.push_str(&align_instance_binding(p, ilvl + 1, options, indent));
            txt_new.push_str(indent);
        } else {
            let p_clean = Regex::new(r"\s+").unwrap().replace_all(p.trim(), "");
            let p_clean = Regex::new(r"\),").unwrap().replace_all(&p_clean, "), ");
            txt_new.push_str(&p_clean);
        }
    }
    txt_new.push_str(");");
    if !comment.is_empty() {
        txt_new.push_str(&format!(" {}", comment));
    }

    format!("{}{}", leading_newlines, txt_new)
}

/// Align instance port bindings (one per line, aligned).
/// Replicates Python `VerilogBeautifier.alignInstanceBinding()`.
fn align_instance_binding(txt: &str, ilvl: usize, options: &FormatOptions, indent: &str) -> String {
    let mut txt = txt.to_string();

    // Insert line breaks for one binding per line
    if options.one_bind_per_line() {
        txt = Regex::new(r"\)[ \t]*,[ \t]*\.")
            .unwrap()
            .replace_all(&txt, "), \n.")
            .to_string();
    }

    let re_bind_port = r"^[ \t]*(?P<lcomma>,)?[ \t]*\.\s*(?P<port>\w+)\s*\(\s*";
    let re_bind_sig = r"(?P<signal>.*?)\s*\)\s*(?P<comma>,)?\s*(?P<comment>//.*?|/\*.*?)?$";

    let full_re = Regex::new(&format!("{}{}", re_bind_port, re_bind_sig)).unwrap();
    let binds: Vec<_> = full_re.captures_iter(&txt).collect();

    let max_port_len = if options.inst_align_port() && !binds.is_empty() {
        binds
            .iter()
            .map(|b| b.name("port").unwrap().as_str().len())
            .max()
            .unwrap_or(0)
    } else {
        0
    };
    let max_sig_len = if options.inst_align_port() && !binds.is_empty() {
        binds
            .iter()
            .map(|b| {
                b.name("signal")
                    .map(|s| s.as_str().trim().len())
                    .unwrap_or(0)
            })
            .max()
            .unwrap_or(0)
    } else {
        0
    };

    let lines: Vec<&str> = txt.trim().split('\n').collect();
    let mut txt_new = String::new();

    for (i, line) in lines.iter().enumerate() {
        let l = line.trim();
        if (i != lines.len() - 1 && i != 0) || !l.is_empty() {
            if let Some(m) = full_re.captures(l) {
                txt_new.push_str(&indent.repeat(ilvl));
                txt_new.push('.');
                txt_new.push_str(&format!(
                    "{:<width$}",
                    m.name("port").unwrap().as_str(),
                    width = max_port_len
                ));
                txt_new.push('(');

                if let Some(sig) = m.name("signal") {
                    txt_new.push_str(&format!(
                        "{:<width$}",
                        sig.as_str().trim(),
                        width = max_sig_len
                    ));
                    txt_new.push(')');
                } else if max_sig_len > 0 && i != lines.len() - 1 {
                    txt_new.push_str(&format!("{:width$})", "", width = max_sig_len));
                }

                if i != lines.len() - 1 {
                    txt_new.push(',');
                }
                if let Some(comment) = m.name("comment") {
                    if !comment.as_str().is_empty() {
                        if !txt_new.ends_with(',') {
                            txt_new.push(' ');
                        }
                        txt_new.push(' ');
                        txt_new.push_str(comment.as_str());
                    }
                }
            } else {
                txt_new.push_str(&indent.repeat(ilvl));
                txt_new.push_str(l);
            }
            txt_new.push('\n');
        }
    }

    txt_new
}

fn skip_comment_or_string(text: &str, pos: usize) -> usize {
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
