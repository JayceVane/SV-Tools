use regex::Regex;

use crate::config::FormatOptions;
use crate::parser::comments::clean_comment;
use crate::parser::patterns::*;
use crate::source_scan;

/// Split text on comma respecting parenthesis nesting.
/// Replicates Python `split_on_comma()`.
pub fn split_on_comma(txt: &str) -> Vec<String> {
    let mut result: Vec<_> = source_scan::split_top_level(txt, ',')
        .into_iter()
        .map(|part| part.trim().to_string())
        .collect();
    if result.last().is_some_and(|part| part.is_empty()) {
        result.pop();
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
    _indent_space: &str,
) -> (String, String) {
    // 头部识别只抽取名称/import；参数和端口范围来自共享括号扫描。
    let re_module = Regex::new(concat!(
        r"(?s)(?P<module>^[ \t]*(?:module|interface))\s*(?P<mname>\w+)",
        r"(?P<import>\s+import\s+.*?;)?\s*"
    ))
    .unwrap();
    let m = match re_module.captures(txt) {
        Some(caps) => caps,
        None => return (String::new(), String::new()),
    };
    let mut pos = source_scan::next_code_offset(txt, m.get(0).unwrap().end());
    let mut params_content = None;
    if txt.as_bytes().get(pos) == Some(&b'#') {
        let open = source_scan::next_code_offset(txt, pos + 1);
        let close = match source_scan::find_matching(txt, open) {
            Some(close) => close,
            None => return (txt.to_string(), String::new()),
        };
        params_content = Some(&txt[open + 1..close]);
        pos = source_scan::next_code_offset(txt, close + 1);
    }
    if txt.as_bytes().get(pos) != Some(&b'(') {
        return (String::new(), String::new());
    }
    let paren_start = pos + 1;
    let ports_end = match source_scan::find_matching(txt, pos) {
        Some(close) => close,
        None => return (txt.to_string(), String::new()),
    };
    let ports_content = &txt[paren_start..ports_end];
    let remaining = source_scan::find_code_char(txt, ports_end + 1, ';')
        .map_or_else(String::new, |semicolon| txt[semicolon + 1..].to_string());

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
    if let Some(params_content) = params_content {
        // 规范化：同行多个 parameter（"parameter A=1,parameter B=2"）拆成独立行，
        // 否则行首锚定的参数正则每行只识别第一个，其余参数在重建时丢失
        let param_txt = split_before_keywords(params_content.trim(), &["parameter", "localparam"]);
        let param_txt = param_txt.as_str();
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
                let mut param_idx: usize = 0;
                // 组内是否存在带尾逗号的参数行（无逗号行据此补占位空格对齐注释列）
                let any_comma_in_group = lines
                    .iter()
                    .any(|l| clean_comment(l).trim_end().ends_with(','));

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
                                values.get(param_idx).cloned().unwrap_or_default(),
                                width = len_value
                            ));
                            param_idx += 1;

                            // 尾逗号：注释可能跟在逗号后（"16 ,// note"），须用去注释
                            // 文本判定，且要插在注释之前而不是行尾；无逗号的行补一个
                            // 占位空格，使整组注释起点列对齐
                            let had_comma = clean_comment(l).trim_end().ends_with(',');
                            if had_comma {
                                l_new.push(',');
                            } else if any_comma_in_group {
                                l_new.push(' ');
                            }

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
        r#"(?m)^[ \t]*(?P<dir>[\w\.]+)[ \t]+(?P<var>var|ref\b)?[ \t]*(?P<type>[\w\:]+\b)?[ \t]*(?P<sign>signed|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)[ \t]*(?P<ports>(?P<port1>\w+)(?:[ \t]*,[ \t]*\w+)*)[ \t]*(?P<comment>,?.*)"#,
    )
    .unwrap();

    // Split multi-direction lines
    let txt_port = split_before_keywords(ports_txt, PORT_DIRS);

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
    let _len_if = port_if_l.iter().map(|x| x.len()).max().unwrap_or(0);

    let mut len_bw_a: Vec<usize> = Vec::new();
    for d in &decl {
        if let Some(bw) = d.name("bw") {
            let bw_clean = crate::source_scan::without_code_whitespace(bw.as_str());
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
            let bw_clean = crate::source_scan::without_code_whitespace(bw);
            plen += 1 + bw_clean.len();
        } else if len_bw > 0 {
            // Reserve space for bw column even if this line doesn't have it
            plen += 1 + len_bw;
        }

        max_prefix_len = max_prefix_len.max(plen);
    }

    // 名称列与最宽前缀之间的空格数可配置（portNameGap，默认 2；spec §9.13）。
    // 原实现把前缀列宽向上取整到缩进宽度的倍数（18→20），名称列间隙随组宽
    // 在 2..5 间漂移，恰好落在边界上时还会多出一整格
    let max_prefix_len = max_prefix_len + options.port_name_gap() - 1;

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
                            let bw_clean = crate::source_scan::without_code_whitespace(bw_raw);
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
                        // Interface port（如 `axi_if.master axi`）：类型与端口名之间
                        // 至少保留一个空格；同一列表中若有方向端口，则对齐到其前缀列。
                        let width = (max_prefix_len + 1).max(dir.len() + 1);
                        l_new.push_str(&format!("{:<width$}", dir, width = width));
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

/// 布局层仅把顶层逗号后出现的方向/parameter 头换行，不碰表达式内部。
fn split_before_keywords(text: &str, keywords: &[&str]) -> String {
    let parts = source_scan::split_top_level(text, ',');
    let mut out = parts[0].to_string();
    for part in parts.into_iter().skip(1) {
        // 逗号后的同行注释属于前一参数，不能先屏蔽注释再把它搬到新行。
        let first = part
            .trim_start()
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .next()
            .unwrap_or("");
        if keywords.contains(&first) {
            out.push_str(",\n");
            out.push_str(part.trim_start());
        } else {
            out.push(',');
            out.push_str(part);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::FormatOptions;

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

    fn port_txt() -> &'static str {
        "module m (\ninput wire [7:0] a,\noutput wire [63:0] dout\n);\nendmodule\n"
    }

    fn name_gap_of(output: &str, marker: &str) -> usize {
        // 统计 marker（如 "[63:0]"）之后到端口名之间的空格数
        let line = output
            .lines()
            .find(|l| l.contains(marker))
            .unwrap_or_else(|| panic!("no {} in output:\n{}", marker, output));
        let after = line.split(marker).nth(1).unwrap();
        after.len() - after.trim_start().len()
    }

    #[test]
    fn test_port_name_gap_config() {
        // 默认 2：最宽前缀（output wire [63:0]）与名称列之间恰好 2 空格
        let out2 = align_module_port(port_txt(), 0, &FormatOptions::default(), "    ", "    ").0;
        assert_eq!(name_gap_of(&out2, "[63:0]"), 2, "default gap:\n{}", out2);

        // gap=1：紧凑单空格
        let mut opt1 = FormatOptions::default();
        opt1.port_name_gap = Some(1);
        let out1 = align_module_port(port_txt(), 0, &opt1, "    ", "    ").0;
        assert_eq!(name_gap_of(&out1, "[63:0]"), 1, "gap=1:\n{}", out1);

        // gap=4：加宽
        let mut opt4 = FormatOptions::default();
        opt4.port_name_gap = Some(4);
        let out4 = align_module_port(port_txt(), 0, &opt4, "    ", "    ").0;
        assert_eq!(name_gap_of(&out4, "[63:0]"), 4, "gap=4:\n{}", out4);

        // 越界钳位到 [1,8]：0 → 1
        let mut opt0 = FormatOptions::default();
        opt0.port_name_gap = Some(0);
        let out0 = align_module_port(port_txt(), 0, &opt0, "    ", "    ").0;
        assert_eq!(name_gap_of(&out0, "[63:0]"), 1, "gap=0 clamped:\n{}", out0);
    }
}

#[cfg(test)]
mod lexical_contract_tests {
    use super::*;

    #[test]
    fn comma_split_preserves_strings_and_aggregate_expressions() {
        assert_eq!(
            split_on_comma(r#""中文, (x)", calc(2,3), '{4,5}"#),
            vec![r#""中文, (x)""#, "calc(2,3)", "'{4,5}"]
        );
    }

    #[test]
    fn module_parameter_strings_and_nested_calls_survive() {
        let text = r#"module demo #(parameter string LABEL = "中文, (x)", parameter int SIZE = calc(2, 3)) (input logic a, output logic z);"#;
        let output = align_module_port(text, 0, &FormatOptions::default(), "    ", "    ").0;
        assert!(output.contains(r#""中文, (x)""#), "{}", output);
        assert!(output.contains("calc(2, 3)"), "{}", output);
        assert!(
            output.contains("LABEL") && output.contains("SIZE"),
            "{}",
            output
        );
    }

    #[test]
    fn incomplete_header_returns_original_without_panicking() {
        let text = "module demo(input logic a";
        assert_eq!(
            align_module_port(text, 0, &FormatOptions::default(), "    ", "    "),
            (text.to_string(), String::new())
        );
    }
}

#[cfg(test)]
mod parameter_comment_tests {
    use super::*;

    #[test]
    fn comma_comments_stay_with_the_previous_parameter_and_are_stable() {
        let input = "module m #(\nparameter A = 1, // A bus width\nparameter B = 2, // B bus width\nparameter C = 3 // C bus width\n) (input wire x);";
        let options = FormatOptions::default();
        let output = align_module_port(input, 0, &options, "    ", "    ").0;
        for (name, comment) in [
            ("A", "// A bus width"),
            ("B", "// B bus width"),
            ("C", "// C bus width"),
        ] {
            let parameter = output
                .lines()
                .find(|line| line.contains(&format!("parameter {}", name)))
                .unwrap();
            assert!(
                parameter.contains(comment),
                "参数 {} 注释被移动: {}",
                name,
                output
            );
        }
        assert_eq!(
            align_module_port(&output, 0, &options, "    ", "    ").0,
            output
        );
    }
}
