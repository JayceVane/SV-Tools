use regex::Regex;

use crate::config::FormatOptions;
use crate::parser::patterns::PORT_DIRS;
use crate::source_scan;

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

    let paren_end = match source_scan::find_matching(txt, paren_start) {
        Some(end) => end,
        None => return (txt.to_string(), String::new()),
    };
    let args_content = &txt[paren_start + 1..paren_end];
    let remaining = source_scan::find_code_char(txt, paren_end + 1, ';')
        .map_or_else(String::new, |semicolon| txt[semicolon + 1..].to_string());

    // Handle empty args
    let args_trimmed = args_content.trim();
    if args_trimmed.is_empty() {
        let mut txt_new = format!("{}();\n", header);
        txt_new.push_str(&remaining);
        return (txt_new, String::new());
    }

    // 单行参数列表保持单行：源码未换行的 `function new(bit [7:0] a = 0);`
    // 不拆成多行对齐（用户显式换行的多行列表才走对齐展开）
    if !args_content.contains('\n') {
        let txt_new = format!("{}({});\n", header, args_trimmed);
        return (txt_new, remaining);
    }

    // Use the same port alignment regex as align_module_port
    let re_port = Regex::new(
        r#"(?m)^[ \t]*(?P<dir>[\w\.]+)[ \t]+(?P<var>var|ref\b)?[ \t]*(?P<type>[\w\:]+\b)?[ \t]*(?P<sign>signed|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)[ \t]*(?P<ports>(?P<port1>\w+)(?:[ \t]*,[ \t]*\w+)*)[ \t]*(?P<comment>,?.*)"#,
    ).unwrap();

    // Split multi-direction lines (e.g., "input a, output b" → "input a,\n output b")
    let parts = source_scan::split_top_level(args_trimmed, ',');
    let mut txt_port = parts[0].to_string();
    for part in parts.into_iter().skip(1) {
        // 保留逗号后同行注释的原始位置；仅原文直接以方向词开头时换行。
        let first = part.trim_start().split_whitespace().next().unwrap_or("");
        if PORT_DIRS.contains(&first) {
            txt_port.push_str(",\n");
            txt_port.push_str(part.trim_start());
        } else {
            txt_port.push(',');
            txt_port.push_str(part);
        }
    }

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

    // 名称列与最宽前缀之间的空格数可配置（portNameGap，默认 2；spec §9.13，
    // 与 align_module_port 一致）。原实现按缩进宽度向上取整，列距随组宽漂移
    let max_prefix_len = max_prefix_len + options.port_name_gap() - 1;

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
                        // 非方向参数（类构造器 "type [bw] name = default"、
                        // 接口句柄等）：位宽必须保留（原实现只输出 dir，
                        // `bit [7:0] a = 0` 的 `[7:0]` 被吞）
                        l_new.push_str(dir);
                        let bw_raw = m_port.name("bw").map(|x| x.as_str()).unwrap_or("");
                        if !bw_raw.trim().is_empty() {
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
                            l_new.push_str(&format!(" {}", bw_s));
                        }
                        let current_len = l_new.len() - indent.repeat(ilvl + 1).len();
                        let target = (max_prefix_len + 1).max(current_len + 1);
                        if current_len < target {
                            l_new.push_str(&format!("{:width$}", "", width = target - current_len));
                        }
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
    let masked = source_scan::mask_non_code(txt);
    let mut pos = 0;
    while let Some(offset) = masked[pos..].find(['#', '(']) {
        pos += offset;
        if masked.as_bytes()[pos] == b'(' {
            return Some(pos);
        }
        let open = source_scan::next_code_offset(txt, pos + 1);
        if txt.as_bytes().get(open) == Some(&b'(') {
            pos = source_scan::find_matching(txt, open)? + 1;
        } else {
            pos += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::FormatOptions;

    fn param_txt() -> &'static str {
        "function automatic f (\ninput wire [7:0] a,\noutput wire [63:0] dout\n);"
    }

    fn name_gap_of(output: &str, marker: &str) -> usize {
        let line = output
            .lines()
            .find(|l| l.contains(marker))
            .unwrap_or_else(|| panic!("no {} in output:\n{}", marker, output));
        let after = line.split(marker).nth(1).unwrap();
        after.len() - after.trim_start().len()
    }

    #[test]
    fn test_port_name_gap_config() {
        // 默认 2
        let out2 = align_task_func_param(param_txt(), 1, &FormatOptions::default(), "    ").0;
        assert_eq!(name_gap_of(&out2, "[63:0]"), 2, "default gap:\n{}", out2);

        // gap=1
        let mut opt1 = FormatOptions::default();
        opt1.port_name_gap = Some(1);
        let out1 = align_task_func_param(param_txt(), 1, &opt1, "    ").0;
        assert_eq!(name_gap_of(&out1, "[63:0]"), 1, "gap=1:\n{}", out1);

        // gap=4
        let mut opt4 = FormatOptions::default();
        opt4.port_name_gap = Some(4);
        let out4 = align_task_func_param(param_txt(), 1, &opt4, "    ").0;
        assert_eq!(name_gap_of(&out4, "[63:0]"), 4, "gap=4:\n{}", out4);
    }
}

#[cfg(test)]
mod lexical_contract_tests {
    use super::*;

    #[test]
    fn argument_matching_ignores_literal_and_comment_parentheses() {
        let text = r#"function f(input string msg = "中文, (x)");logic tail;"#;
        let (output, remaining) = align_task_func_param(text, 0, &FormatOptions::default(), "    ");
        assert!(output.contains(r#""中文, (x)""#), "{}", output);
        assert_eq!(remaining, "logic tail;");
        let text = "function f(input int x /* ) */);";
        assert!(
            align_task_func_param(text, 0, &FormatOptions::default(), "    ")
                .0
                .contains("/* ) */")
        );
    }

    #[test]
    fn incomplete_arguments_are_passthrough() {
        let text = "function f(input string msg = \"未闭合)";
        assert_eq!(
            align_task_func_param(text, 0, &FormatOptions::default(), "    "),
            (text.to_string(), String::new())
        );
    }
}

#[cfg(test)]
mod argument_comment_tests {
    use super::*;

    #[test]
    fn comma_comment_stays_with_its_argument() {
        let input = "task t(\ninput int a, // first argument\ninput int b\n);";
        let output = align_task_func_param(input, 0, &FormatOptions::default(), "    ").0;
        assert!(
            output
                .lines()
                .any(|line| line.contains(" a") && line.contains("// first argument")),
            "{}",
            output
        );
    }
}
