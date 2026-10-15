use regex::Regex;

use crate::config::FormatOptions;
use crate::source_scan::{self, SegmentKind};

/// Align module instance port bindings.
/// Replicates Python `VerilogBeautifier.alignInstance()` and `alignInstanceBinding()`.
/// Returns original text if parsing fails (for graceful degradation).
pub fn align_instance(
    txt: &str,
    ilvl: usize,
    options: &FormatOptions,
    indent: &str,
    _indent_space: &str,
) -> String {
    // Store original for fallback
    let original_txt = txt.to_string();

    // Handle leading newlines - keep at most one for blank line separation
    let mut leading_newlines = String::new();
    let mut txt_work = txt.to_string();
    let mut newline_count = 0;
    let mut chars = txt_work.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c == '\n' || c == ' ' || c == '\t' {
            if c == '\n' {
                newline_count += 1;
            }
            chars.next();
        } else {
            break;
        }
    }
    // Keep only one blank line (two newlines: one from previous content, one for blank)
    if newline_count > 1 {
        leading_newlines.push('\n');
    }
    txt_work = chars.collect();

    // 单行例化保持单行（spec §8.3 / §7.1 单行对齐逻辑）：整条实例语句
    // 在单行内（用户未自行换行）时不展开多行对齐，仅享受 preprocess 的
    // 空格紧凑；行内紧凑关闭时原样返回。行首空白已被上面的循环吃掉，
    // 需按当前层级重新补缩进。modport 不在此列——走实例对齐路径展开
    // 多行（ex9 golden 形态）
    if !txt_work.contains('\n')
        && txt_work.trim_end().ends_with(';')
        && !txt_work.trim_start().starts_with("modport")
    {
        return format!("{}{}{}", leading_newlines, indent.repeat(ilvl), txt_work);
    }

    // Find module type
    let txt_clean = crate::parser::comments::clean_comment(&txt_work);
    let m_type = match Regex::new(r"^[ \t]*\n?(?P<mtype>(?:(?:bind\s+[\w\.]+\s+)?[ \t]*)?\w+)")
        .unwrap()
        .captures(&txt_clean)
    {
        Some(c) => c,
        None => return original_txt,
    };
    let mtype = m_type.name("mtype").unwrap().as_str().trim();

    let m_type_orig = match Regex::new(r"^[ \t]*\n?\s*\w+").unwrap().captures(&txt_work) {
        Some(c) => c,
        None => return original_txt, // Return original on parse failure
    };
    let mut pos = m_type_orig.get(0).unwrap().end();

    let find_next_nonspace = source_scan::next_code_offset;
    let find_matching_paren =
        |text: &str, start: usize| source_scan::find_matching(text, start).unwrap_or(usize::MAX);
    let find_char = |text: &str, start: usize, ch: u8| {
        source_scan::find_code_char(text, start, char::from(ch)).unwrap_or(usize::MAX)
    };

    // Parse parameters
    let mut params: Option<String> = None;
    let nxt = find_next_nonspace(&txt_work, pos);
    if nxt < txt_work.len() && txt_work.as_bytes()[nxt] == b'#' {
        let paren_pos = find_char(&txt_work, nxt, b'(');
        if paren_pos == usize::MAX {
            return original_txt;
        }
        let end_paren = find_matching_paren(&txt_work, paren_pos);
        if end_paren == usize::MAX {
            return original_txt;
        }
        params = Some(txt_work[paren_pos + 1..end_paren].to_string());
        pos = end_paren + 1;
    }

    // Parse instance name
    let nxt = find_next_nonspace(&txt_work, pos);
    let m_name = match Regex::new(r"\w+").unwrap().find(&txt_work[nxt..]) {
        Some(m) => m.as_str().to_string(),
        None => return original_txt,
    };
    pos = nxt + m_name.len();

    // Parse ports and trailing comment
    let mut ports: Option<String> = None;
    let nxt = find_next_nonspace(&txt_work, pos);
    let (has_ports, _has_semicolon, comment) =
        if nxt < txt_work.len() && txt_work.as_bytes()[nxt] == b'(' {
            // Has port connections
            let end_paren = find_matching_paren(&txt_work, nxt);
            if end_paren == usize::MAX {
                return original_txt;
            }
            ports = Some(txt_work[nxt + 1..end_paren].to_string());
            let nxt2 = find_next_nonspace(&txt_work, end_paren + 1);
            if nxt2 < txt_work.len() && txt_work.as_bytes()[nxt2] == b';' {
                let nxt3 = find_next_nonspace(&txt_work, nxt2 + 1);
                let cmt = if nxt3 < txt_work.len() {
                    txt_work[nxt3..].trim().to_string()
                } else {
                    String::new()
                };
                (true, true, cmt)
            } else {
                (true, false, String::new())
            }
        } else if nxt < txt_work.len() && txt_work.as_bytes()[nxt] == b';' {
            // No ports, just semicolon
            let nxt2 = find_next_nonspace(&txt_work, nxt + 1);
            let cmt = if nxt2 < txt_work.len() {
                txt_work[nxt2..].trim().to_string()
            } else {
                String::new()
            };
            (false, true, cmt)
        } else {
            // Missing semicolon
            (false, false, String::new())
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
            txt_new.push_str(&indent.repeat(ilvl));
        } else {
            for segment in source_scan::scan(p_trimmed) {
                if segment.kind == SegmentKind::Code {
                    let compact = segment.text.split_whitespace().collect::<String>();
                    txt_new.push_str(&compact.replace("),", "), "));
                } else {
                    txt_new.push_str(segment.text);
                }
            }
        }
        txt_new.push(')');
    }

    // Instance name and ports
    if has_ports {
        txt_new.push_str(&format!(" {} (", m_name));
        if let Some(ref p) = ports {
            let p_trimmed = p.trim();
            if !p_trimmed.is_empty() {
                // Always use align_instance_binding for proper alignment
                txt_new.push('\n');
                txt_new.push_str(&align_instance_binding(p, ilvl + 1, options, indent));
                txt_new.push_str(&indent.repeat(ilvl));
            }
        }
        txt_new.push(')');
    } else {
        txt_new.push_str(&format!(" {}", m_name));
    }
    txt_new.push(';');
    if !comment.is_empty() {
        txt_new.push_str(&format!(" {}", comment));
    }
    // Ensure trailing newline for proper formatting
    txt_new.push('\n');

    format!("{}{}", leading_newlines, txt_new)
}

/// Align instance port bindings (one per line, aligned).
/// Replicates Python `VerilogBeautifier.alignInstanceBinding()`.
fn align_instance_binding(txt: &str, ilvl: usize, options: &FormatOptions, indent: &str) -> String {
    let mut txt = txt.to_string();

    if options.one_bind_per_line() {
        let parts = source_scan::split_top_level(&txt, ',');
        let mut separated = parts[0].to_string();
        for part in parts.into_iter().skip(1) {
            separated.push(',');
            if part.trim_start().starts_with('.') {
                separated.push('\n');
                separated.push_str(part.trim_start());
            } else {
                separated.push_str(part);
            }
        }
        txt = separated;
    }

    let re_bind_port = r"(?m)^[ \t]*(?P<lcomma>,)?[ \t]*\.\s*(?P<port>\w+)\s*\(\s*";
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

                if m.name("comma").is_some() {
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

#[cfg(test)]
mod lexical_contract_tests {
    use super::*;

    #[test]
    fn instance_parameters_and_nested_bindings_preserve_literals() {
        let text = "child #(.NAME(\"中文, (a,b)\"), .WIDTH(calc(1, 2))) u_child(\n.data({a, fnc(b,c)}),\n.valid(gate(a,b))\n);";
        let output = align_instance(text, 0, &FormatOptions::default(), "    ", "    ");
        assert!(output.contains("\"中文, (a,b)\""), "{}", output);
        assert!(output.contains("calc(1,2)"), "{}", output);
        assert!(output.contains("{a, fnc(b,c)}"), "{}", output);
        assert!(output.contains("gate(a,b)"), "{}", output);
    }

    #[test]
    fn incomplete_instance_is_passthrough() {
        let text = "child u_child(\n.NAME(\"未闭合)";
        assert_eq!(
            align_instance(text, 0, &FormatOptions::default(), "    ", "    "),
            text
        );
    }
}
