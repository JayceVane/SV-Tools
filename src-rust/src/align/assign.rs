use regex::Regex;
use std::collections::HashMap;

use crate::config::FormatOptions;

/// Align assignments: case/struct (`:`), continuous assign (`=`), blocking/non-blocking (`<=`/`=`).
/// Replicates Python `VerilogBeautifier.alignAssign()`.
pub fn align_assign(
    txt: &str,
    mask_op: u32,
    options: &FormatOptions,
    indent: &str,
    indent_space: &str,
) -> String {
    let mut re_str_list: Vec<String> = Vec::new();

    // case/structure: "word: statement"
    if mask_op & 1 != 0 {
        re_str_list.push(
            r#"^[ \t]*(?P<scope>\w+\:\:)?(?P<name>[\w`'".\?]+)[ \t]*(\[(?P<bitslice>.*?)\])?\s*(?P<op>\:(?!\:))\s*(?P<statement>.*)$"#
                .to_string()
        );
    }
    // Continuous assignment: "assign word = statement"
    if mask_op & 2 != 0 {
        re_str_list.push(
            r#"^[ \t]*(?P<scope>assign)\s+(?P<name>[\w`'"\.]+)[ \t]*(\[(?P<bitslice>.*?)\])?\s*(?P<op>=)\s*(?P<statement>.*)$"#
                .to_string()
        );
    }
    // Assignment: "word <= statement"
    if mask_op & 4 != 0 {
        re_str_list.push(
            r#"^[ \t]*(?P<scope>)(?P<name>[\w`'"\.]+)[ \t]*(\[(?P<bitslice>.*?)\])?\s*(?P<op>(<)?=)\s*(?P<statement>.*)$"#
                .to_string()
        );
    }

    let mut txt_new = txt.to_string();

    for re_str in &re_str_list {
        let re = match Regex::new(re_str) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let lines: Vec<&str> = txt_new.split('\n').collect();
        let mut lines_match: Vec<(&str, Option<regex::Captures>, usize, isize)> = Vec::new();
        let mut matched = false;
        let mut ilvl: isize = -1;
        let mut ilvl_prev: isize = -1;
        let mut max_len: HashMap<isize, usize> = HashMap::new();
        let mut max_len_idx: isize = -1;

        let ilvl_glob = (mask_op & 1 != 0)
            && re_str.starts_with(r"^[ \t]*(?P<scope>\\w+")
            && txt.trim().ends_with(';')
            && !txt.trim().starts_with("always");

        for l in &lines {
            let m = re.captures(l);
            ilvl_prev = ilvl;
            ilvl = get_indent_level(l, options, indent, indent_space) as isize;

            let idx = if ilvl_glob {
                ilvl
            } else if ilvl != ilvl_prev {
                max_len_idx += 1;
                max_len_idx
            } else {
                max_len_idx
            };

            max_len.entry(idx).or_insert(0);

            if let Some(ref caps) = m {
                matched = true;
                let mut len_c = caps.name("name").unwrap().as_str().len();
                if let Some(scope) = caps.name("scope") {
                    len_c += scope.as_str().len();
                    if scope.as_str() == "assign" {
                        len_c += 1;
                    }
                }
                if let Some(bitslice) = caps.name("bitslice") {
                    let bs = Regex::new(r"\s*")
                        .unwrap()
                        .replace_all(bitslice.as_str(), "");
                    len_c += bs.len() + 2;
                }
                if len_c > max_len[&idx] {
                    max_len.insert(idx, len_c);
                }
            }

            lines_match.push((l, m, ilvl as usize, idx));
        }

        if matched {
            let mut txt_new_tmp = String::new();
            for (_, (line, caps, ilvl_val, len_idx)) in lines_match.iter().enumerate() {
                if let Some(m) = caps {
                    let mut l = String::new();
                    if let Some(scope) = m.name("scope") {
                        l.push_str(scope.as_str());
                        if scope.as_str() == "assign" {
                            l.push(' ');
                        }
                    }
                    l.push_str(m.name("name").unwrap().as_str());
                    if let Some(bitslice) = m.name("bitslice") {
                        let bs = Regex::new(r"\s*")
                            .unwrap()
                            .replace_all(bitslice.as_str(), "");
                        l.push_str(&format!("[{}]", bs));
                    }
                    let ml = max_len.get(len_idx).unwrap_or(&0);
                    l = format!(
                        "{}{:<width$} {} {}",
                        indent.repeat(*ilvl_val),
                        l,
                        m.name("op").unwrap().as_str(),
                        m.name("statement").unwrap().as_str(),
                        width = ml
                    );
                    txt_new_tmp.push_str(&format!("{}\n", l.trim_end()));
                } else {
                    txt_new_tmp.push_str(&format!("{}\n", line));
                }
            }

            // Semicolon alignment: for always block assignments (mask_op & 4),
            // align semicolons within the same indent level group
            if mask_op & 4 != 0 && options.align_comma() {
                txt_new_tmp = align_semicolons(&txt_new_tmp);
            }

            // Don't remove trailing newline - blocks should end with newline
            txt_new = txt_new_tmp;
        }
    }

    txt_new
}

fn get_indent_level(
    line: &str,
    options: &FormatOptions,
    _indent: &str,
    indent_space: &str,
) -> usize {
    let line = if options.use_tab() {
        line.replace(indent_space, "\t")
    } else {
        line.replace('\t', indent_space)
    };
    let cnt = line.len() - line.trim_start().len();
    if options.use_tab() {
        cnt
    } else {
        cnt / options.nb_space()
    }
}

/// Align semicolons in assignment lines within the same indent level group.
/// Finds the max line length (excluding the semicolon) per indent group,
/// then pads shorter lines so all semicolons line up vertically.
fn align_semicolons(txt: &str) -> String {
    let lines: Vec<&str> = txt.split('\n').collect();
    let mut max_semi_pos: HashMap<usize, usize> = HashMap::new();

    // First pass: calculate indent level groups and find max content length (before semicolon)
    let mut current_group: usize = 0;
    let mut prev_indent: usize = 0;
    for l in &lines {
        let trimmed = l.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let indent = l.len() - l.trim_start().len();
        if indent != prev_indent {
            current_group += 1;
            prev_indent = indent;
        }
        if trimmed.ends_with(';') {
            // Content before semicolon, trimmed of trailing spaces
            let before_semi = trimmed[..trimmed.len() - 1].trim_end();
            let content_len = before_semi.len();
            let entry = max_semi_pos.entry(current_group).or_insert(0);
            if content_len > *entry {
                *entry = content_len;
            }
        }
    }

    // Second pass: pad lines to align semicolons
    let mut result = String::new();
    current_group = 0;
    prev_indent = 0;
    for l in &lines {
        let trimmed = l.trim_end();
        if trimmed.is_empty() {
            result.push_str(l);
            result.push('\n');
            continue;
        }
        let indent = l.len() - l.trim_start().len();
        if indent != prev_indent {
            current_group += 1;
            prev_indent = indent;
        }
        if trimmed.ends_with(';') {
            if let Some(&max_pos) = max_semi_pos.get(&current_group) {
                // Content before semicolon (trimmed of trailing spaces)
                let before_semi = trimmed[..trimmed.len() - 1].trim_end();
                let spaces_needed = max_pos.saturating_sub(before_semi.len());

                // Reconstruct: indent + content + padding + semicolon
                result.push_str(&format!(
                    "{}{}{};\n",
                    &l[..indent],
                    before_semi.trim_start(),
                    " ".repeat(spaces_needed)
                ));
                continue;
            }
        }
        result.push_str(l);
        result.push('\n');
    }

    result
}
