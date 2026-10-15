use regex::Regex;
use std::sync::LazyLock;

static DECLARATION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^[ \t]*(?P<attr>(?:\(\*.*?\*\)[ \t]*)*)(?:(?P<param>localparam|parameter|local|protected)\s+)?(?P<scope>\w+\:\:)?(?P<type>[A-Za-z_]\w*)[ \t]+(?P<sign>signed\b|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)[ \t]*(?P<name>[A-Za-z_]\w*)[ \t]*(?P<array>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)(=\s*(?P<init>[^;]+))?(?P<sig_list>,[\w, \t]*)?;[ \t]*(?P<comment>.*)"#,
    )
    .expect("valid declaration pattern")
});

use crate::config::FormatOptions;
use crate::source_scan::{self, SegmentKind, SourceCaptures};

/// Align signal declarations: `[scope::]type [signed|unsigned] [bitwidth] signal list`
/// Replicates Python `VerilogBeautifier.alignDecl()`.
pub fn align_decl(txt: &str, options: &FormatOptions, indent: &str, indent_space: &str) -> String {
    let re_decl = &*DECLARATION_PATTERN;

    let original_mask = source_scan::mask_for_layout(txt);
    let lines: Vec<String> = txt
        .split('\n')
        .zip(original_mask.split('\n'))
        .map(|(line, masked)| {
            if crate::parser::patterns::RE_DECL_COMPACT.is_match(masked) {
                crate::parser::patterns::normalize_compact_decl(line)
            } else {
                line.to_string()
            }
        })
        .collect();
    let normalized = lines.join("\n");
    let layout_mask = source_scan::mask_for_layout(&normalized);
    let masked_lines: Vec<&str> = layout_mask.split('\n').collect();
    let lines: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    // Group by (indent_level, blank_seg, attribute_prefix) for proper alignment.
    // blank_seg：空行分隔的段号——空行是用户的分组排版语义，两组声明不应
    // 共用列宽跨组对齐（位宽补位/分号悬挂会拉到别组的列上）
    let mut lines_match: Vec<(&str, Option<SourceCaptures<'_, '_>>, usize, usize, String)> =
        Vec::new();
    let mut len_max: HashMap<(usize, usize, String), DeclWidths> = HashMap::new();
    let one_decl_per_line = options.one_decl_per_line();
    let mut blank_seg: usize = 0;

    // First pass: collect matches and calculate column widths
    for (l, masked) in lines.iter().zip(&masked_lines) {
        if l.trim().is_empty() {
            blank_seg += 1;
        }
        if let Some(m) = source_scan::captures(re_decl, l, masked) {
            let ilvl = get_indent_level(l, options, indent, indent_space);
            let attr = m
                .name("attr")
                .map(|a| a.as_str().trim().to_string())
                .unwrap_or_default();
            let key = (ilvl, blank_seg, attr.clone());
            let widths = len_max.entry(key.clone()).or_insert_with(DeclWidths::new);

            for column in [
                "param", "scope", "type", "sign", "bw", "name", "array", "init", "comment",
            ] {
                let val = m.name(column);
                if let Some(v) = val {
                    let w = v.as_str().trim();
                    match column {
                        "param" => widths.param = widths.param.max(w.len()),
                        "scope" => widths.scope = widths.scope.max(w.len()),
                        "type" => {
                            let t = w;
                            let is_standard =
                                ["logic", "wire", "reg", "bit", "int", "integer"].contains(&t);
                            if is_standard {
                                widths.type_col = widths.type_col.max(t.len());
                            } else if m.name("bw").is_some() {
                                widths.type_user_pa = widths.type_user_pa.max(t.len());
                            } else {
                                widths.type_user = widths.type_user.max(t.len());
                            }
                            // 限定类型（`pkg::type`）的列宽须含 scope 前缀，
                            // 否则重建时 t 比列宽长、名字与类型粘连（pkt_tq）
                            let scope_len = m.name("scope").map(|s| s.as_str().len()).unwrap_or(0);
                            widths.type_full = widths.type_full.max(scope_len + t.len());
                        }
                        "sign" => widths.sign = widths.sign.max(w.len()),
                        "bw" => {
                            // Bitwidth - per dimension
                            let bw_clean = source_scan::without_code_whitespace(w);
                            for (i, content) in
                                dimension_contents(&bw_clean).into_iter().enumerate()
                            {
                                if i >= widths.bw.len() {
                                    widths.bw.push(content.len());
                                } else {
                                    widths.bw[i] = widths.bw[i].max(content.len());
                                }
                            }
                        }
                        "name" => {
                            widths.name = widths.name.max(w.len());
                            // 带数组维度的行单独记名宽（array 列对齐基准）
                            if m.name("array")
                                .map(|a| !a.as_str().trim().is_empty())
                                .unwrap_or(false)
                            {
                                widths.name_arr = widths.name_arr.max(w.len());
                            }
                        }
                        "array" => {
                            let arr_clean = source_scan::without_code_whitespace(w);
                            for (i, content) in
                                dimension_contents(&arr_clean).into_iter().enumerate()
                            {
                                if i >= widths.array.len() {
                                    widths.array.push(content.len());
                                } else {
                                    widths.array[i] = widths.array[i].max(content.len());
                                }
                            }
                        }
                        "init" => widths.init = widths.init.max(w.trim().len()),
                        "comment" => widths.comment = widths.comment.max(w.trim().len()),
                        _ => {}
                    }
                }
            }

            // Handle sig_list for one_decl_per_line
            if let Some(sl) = m.name("sig_list") {
                if one_decl_per_line {
                    for s in sl.as_str().split(',') {
                        let s = s.trim();
                        if !s.is_empty() {
                            widths.name = widths.name.max(s.len());
                        }
                    }
                }
            }

            lines_match.push((l, Some(m), ilvl, blank_seg, attr));
        } else {
            lines_match.push((l, None, 0, 0, String::new()));
        }
    }

    // Compute sums
    for (_, widths) in len_max.iter_mut() {
        widths.bw_sum = widths.bw.iter().map(|x| x + 2).sum();
        widths.array_sum = widths.array.iter().map(|x| x + 2).sum();
        if widths.type_user_pa > widths.type_col {
            widths.type_col = widths.type_user_pa;
        }
    }

    // Second pass: generate formatted lines and calculate max line length
    let mut formatted_lines: Vec<(String, Option<String>, usize, bool)> = Vec::new(); // (line, comment, ilvl, is_decl)
    for (line, caps, ilvl, seg, attr) in &lines_match {
        if let Some(m) = caps {
            let key = (*ilvl, *seg, attr.clone());
            let widths = &len_max[&key];
            let mut l = indent.repeat(*ilvl);
            // Prepend attribute prefix if present
            if !attr.is_empty() {
                l.push_str(attr);
                l.push(' ');
            }
            let tp = m.name("type").unwrap().as_str().trim();
            let is_usertype = !["logic", "wire", "reg", "bit", "int", "integer"].contains(&tp);

            let mut len_type_full = widths.type_full + 1;
            let mut len_type = widths.type_col + 1;
            let mut t = String::new();

            // param
            if let Some(p) = m.name("param") {
                t.push_str(&format!("{:<width$}", p.as_str(), width = widths.param + 1));
                len_type_full += widths.param + 1;
            } else if widths.param != 0 {
                len_type += widths.param + 1;
            }

            if is_usertype {
                if let Some(scope) = m.name("scope") {
                    t.push_str(&format!("{}{}", scope.as_str(), tp));
                } else {
                    t.push_str(tp);
                }
                // bw 组可为空匹配（is_some 但内容为空）：空时不得走填充路径，
                // 否则多补一个空格（class c / property p / bins b 等无位宽声明）
                if m.name("bw")
                    .map(|b| !b.as_str().trim().is_empty())
                    .unwrap_or(false)
                {
                    t = format!("{:<width$}", t, width = len_type);
                    let bw_clean =
                        source_scan::without_code_whitespace(m.name("bw").unwrap().as_str());
                    let mut s = String::new();
                    for (i, content) in dimension_contents(&bw_clean).into_iter().enumerate() {
                        let w = widths.bw.get(i).unwrap_or(&0);
                        s.push_str(&format!("[{:>width$}]", content, width = w));
                    }
                    t.push_str(&format!("{:<width$}", s, width = widths.bw_sum + 1));
                }
            } else {
                t.push_str(&format!("{:<width$}", tp, width = len_type));
                if widths.sign > 0 {
                    if let Some(sign) = m.name("sign") {
                        t.push_str(&format!(
                            "{:<width$}",
                            sign.as_str(),
                            width = widths.sign + 1
                        ));
                    } else {
                        t.push_str(&format!("{:width$}", "", width = widths.sign + 1));
                    }
                }
                if widths.bw_sum > 0 {
                    let s = if let Some(bw) = m.name("bw") {
                        let bw_clean = source_scan::without_code_whitespace(bw.as_str());
                        let mut s = String::new();
                        for (i, content) in dimension_contents(&bw_clean).into_iter().enumerate() {
                            let w = widths.bw.get(i).unwrap_or(&0);
                            s.push_str(&format!("[{:>width$}]", content, width = w));
                        }
                        s
                    } else {
                        String::new()
                    };
                    t.push_str(&format!("{:<width$}", s, width = widths.bw_sum + 1));
                }
            }

            // 重建列宽下限：t（含 scope 前缀）去掉尾部既有填充后至少留一个
            // 空格再接名字。直接用 t.len()+1 会给本就带尾随空格的 t（标准类型
            // 的 len_type 填充、bw_sum+1 填充）多补一列
            let pad_to = std::cmp::max(len_type_full, t.trim_end().len() + 1);
            l.push_str(&format!("{:<width$}", t, width = pad_to));
            let d = l.clone(); // save for signal list repetition

            if let Some(sl) = m.name("sig_list") {
                // Signal list
                l.push_str(m.name("name").unwrap().as_str());
                if let Some(arr) = m.name("array") {
                    l.push_str(&source_scan::without_code_whitespace(arr.as_str()));
                }
                if let Some(init) = m.name("init") {
                    l.push_str(&format!(
                        " = {:<width$}",
                        init.as_str().trim(),
                        width = widths.init
                    ));
                }
                if one_decl_per_line {
                    for s in sl.as_str().split(',') {
                        let s = s.trim();
                        if !s.is_empty() {
                            if options.align_comma() {
                                l.push_str(&format!(";\n{}{:<width$}", d, s, width = widths.name));
                            } else {
                                l.push_str(&format!(";\n{}{}", d, s));
                            }
                        }
                    }
                } else {
                    l.push_str(sl.as_str().trim());
                }
            } else {
                // 有数组维度的行：name 只对齐到「带维度行」的名宽（+1 保底空格），
                // 不被无维度行的 name 列宽推远；无维度行照旧用全组名宽
                let has_arr = m
                    .name("array")
                    .map(|a| !a.as_str().trim().is_empty())
                    .unwrap_or(false);
                let name_w = if has_arr {
                    std::cmp::max(widths.name_arr, m.name("name").unwrap().as_str().len() + 1)
                } else {
                    widths.name
                };
                l.push_str(&format!(
                    "{:<width$}",
                    m.name("name").unwrap().as_str(),
                    width = name_w
                ));
                if widths.array_sum > 0 {
                    let s = if let Some(arr) = m.name("array") {
                        let arr_clean = source_scan::without_code_whitespace(arr.as_str());
                        let mut s = String::new();
                        for (i, content) in dimension_contents(&arr_clean).into_iter().enumerate() {
                            let w = widths.array.get(i).unwrap_or(&0);
                            s.push_str(&format!("[{:>width$}]", content, width = w));
                        }
                        s
                    } else {
                        String::new()
                    };
                    l.push_str(&format!("{:<width$}", s, width = widths.array_sum));
                }
                if widths.init > 0 {
                    if let Some(init) = m.name("init") {
                        l.push_str(&format!(
                            " = {:<width$}",
                            init.as_str().trim(),
                            width = widths.init
                        ));
                    } else {
                        l.push_str(&format!("{:width$}", "", width = widths.init + 3));
                    }
                }
            }

            // Get comment
            let comment = m
                .name("comment")
                .map(|c| c.as_str().trim_start().to_string());
            formatted_lines.push((l, comment, *ilvl, true));
        } else {
            formatted_lines.push((line.to_string(), None, 0, false));
        }
    }

    // Calculate max line length per (indent level, attr) for semicolon alignment
    if options.align_comma() {
        for (index, (line, _comment, level, is_decl)) in formatted_lines.iter().enumerate() {
            if !is_decl {
                continue;
            }
            if let Some((_original, _captures, _original_level, segment, attribute)) =
                lines_match.get(index)
            {
                let key = (*level, *segment, attribute.clone());
                if let Some(widths) = len_max.get_mut(&key) {
                    widths.semi_col = widths.semi_col.max(line.trim_end().len());
                }
            }
        }
    }

    // Third pass: add semicolons and comments
    let mut txt_new = String::new();
    let mut idx = 0;
    for (l, comment, ilvl, is_decl) in &formatted_lines {
        let l = if *is_decl {
            // Find attr from original lines_match
            let (attr, seg) = lines_match
                .get(idx)
                .map(|(_, _, _, s, a)| (a.clone(), *s))
                .unwrap_or_default();
            let key = (*ilvl, seg, attr);
            let widths = &len_max[&key];
            let mut l = l.clone();

            if options.align_comma() {
                // Align semicolon to max column
                let l_tmp = source_scan::trim_code_end(&l);
                let needs_separator = source_scan::scan(l_tmp)
                    .last()
                    .is_some_and(|segment| segment.kind == SegmentKind::EscapedIdentifier);
                let pad = widths
                    .semi_col
                    .saturating_sub(l_tmp.len())
                    .max(usize::from(needs_separator));
                l = format!("{}{:width$};", l_tmp, "", width = pad);
            } else {
                let mut l_tmp = source_scan::trim_code_end(&l).to_string();
                if source_scan::scan(&l_tmp)
                    .last()
                    .is_some_and(|segment| segment.kind == SegmentKind::EscapedIdentifier)
                {
                    l_tmp.push(' ');
                }
                let nb_pad = l.len().saturating_sub(l_tmp.len());
                l = format!("{};{:width$}", l_tmp, "", width = nb_pad);
            }

            if let Some(c) = comment {
                if !c.is_empty() {
                    l.push_str(&format!(" {}", c));
                }
            }
            l
        } else {
            l.clone()
        };

        txt_new.push_str(&l);
        txt_new.push('\n');
        idx += 1;
    }

    // 输入以 \n 结尾时输出保留单个终止符（split 尾空元素曾被当作空行多补
    // 一个换行——块间伪影空行的来源之一，现由 blank_rules 统一裁决）
    if txt.ends_with('\n') {
        txt_new.pop();
    }
    txt_new
}

/// 数组维度由共享括号事实切分，字面量里的方括号不参与匹配。
fn dimension_contents(text: &str) -> Vec<&str> {
    let mut dimensions = Vec::new();
    let mut pos = 0;
    while let Some(open) = source_scan::find_code_char(text, pos, '[') {
        let Some(close) = source_scan::find_matching(text, open) else {
            break;
        };
        dimensions.push(&text[open + 1..close]);
        pos = close + 1;
    }
    dimensions
}

use std::collections::HashMap;

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

struct DeclWidths {
    param: usize,
    scope: usize,
    type_col: usize,
    type_full: usize,
    type_user: usize,
    type_user_pa: usize,
    sign: usize,
    bw: Vec<usize>,
    bw_sum: usize,
    name: usize,
    /// 组内「带数组维度行」的名字最大宽——array 前的列只在这类行之间对齐
    /// （无维度的行把 name 填充到全组宽是为 init/分号列服务，混用会把
    /// 维度推离名字，mirror_q [$] 莫名多出空格的根因）
    name_arr: usize,
    array: Vec<usize>,
    array_sum: usize,
    init: usize,
    comment: usize,
    semi_col: usize, // Position for semicolon alignment
}

impl DeclWidths {
    fn new() -> Self {
        Self {
            param: 0,
            scope: 0,
            type_col: 0,
            type_full: 0,
            type_user: 0,
            type_user_pa: 0,
            sign: 0,
            bw: Vec::new(),
            bw_sum: 0,
            name: 0,
            name_arr: 0,
            array: Vec::new(),
            array_sum: 0,
            init: 0,
            comment: 0,
            semi_col: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decl_regex_basic() {
        let re = Regex::new(
            r#"^[ \t]*(?P<attr>(?:\(\*.*?\*\)[ \t]*)*)(?:(?P<param>localparam|parameter|local|protected)\s+)?(?P<scope>\w+\:\:)?(?P<type>[A-Za-z_]\w*)[ \t]+(?P<sign>signed\b|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)[ \t]*(?P<name>[A-Za-z_]\w*)[ \t]*(?P<array>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)(=\s*(?P<init>[^;]+))?(?P<sig_list>,[\w, \t]*)?;[ \t]*(?P<comment>.*)"#,
        ).unwrap();

        let test_cases = vec![
            "logic [31:0] data_a;",
            "reg [31:0] dbg_rfu_wreg0;",
            "reg        dbg_rfu_wreg1;",
            "(* mark_debug = true *) reg [31:0] dbg_rfu_wreg0;",
        ];

        for tc in &test_cases {
            if let Some(m) = re.captures(tc) {
                println!("Input: {}", tc);
                println!("  type: {:?}", m.name("type").map(|x| x.as_str()));
                println!("  bw:   {:?}", m.name("bw").map(|x| x.as_str()));
                println!("  name: {:?}", m.name("name").map(|x| x.as_str()));
                println!("  attr: {:?}", m.name("attr").map(|x| x.as_str()));
                assert!(m.name("type").is_some(), "type missing for: {}", tc);
                assert!(m.name("name").is_some(), "name missing for: {}", tc);
            } else {
                panic!("No match for: {}", tc);
            }
        }
    }

    #[test]
    fn test_align_decl_basic() {
        let options = FormatOptions::default();
        let indent = "    ";
        let indent_space = "    ";

        let txt = "logic [31:0] data_a;\nlogic [7:0]  data_b;\nlogic        data_c;\n";
        let result = align_decl(txt, &options, indent, indent_space);
        assert!(
            result.contains("31:0"),
            "31:0 missing in output: {}",
            result
        );
        assert!(result.contains("7:0"), "7:0 missing in output");

        // 空行切断对齐组：两组声明不共用列宽（位宽补位/分号悬挂不跨组）
        let txt2 = "reg  [ADDR_WIDTH:0] wr_ptr;\nreg  [ADDR_WIDTH:0] rd_ptr;\n\nreg  [DATA_WIDTH-1:0] mem [0:DEPTH-1];\n";
        let out2 = align_decl(txt2, &options, indent, indent_space);
        let l1 = out2.lines().next().unwrap_or("");
        assert!(
            !l1.contains("  ADDR_WIDTH:0]"),
            "空行分组后 wr_ptr 行不应再按别组位宽补位: {}",
            out2
        );
        assert!(
            !l1.trim_end().ends_with(" ;"),
            "空行分组后分号悬挂不应拉到别组列: {}",
            out2
        );
    }

    #[test]
    fn test_align_decl_attribute() {
        let options = FormatOptions::default();
        let indent = "    ";
        let indent_space = "    ";

        let txt = "(* mark_debug = true *) reg [31:0] dbg_rfu_wreg0;\n(* mark_debug = true *) reg        dbg_rfu_wreg1;\n(* mark_debug = true *) reg [15:0] dbg_rfu_wreg2;\n";
        let result = align_decl(txt, &options, indent, indent_space);
        assert!(result.contains("31:0"), "31:0 missing in output");
        assert!(result.contains("15:0"), "15:0 missing in output");
        assert!(result.contains("mark_debug"), "attribute missing in output");
    }
}

#[cfg(test)]
mod dbgdecl {
    use super::*;
    use crate::config::FormatOptions;

    #[test]
    fn dbg_align_decl_spaces() {
        let options = FormatOptions::default();
        let txt = "    class c;\n";
        println!(
            "=== class ===\n{}",
            align_decl(txt, &options, "    ", "    ")
        );
        let txt2 = "    property p_valid_ready;\n";
        println!(
            "=== property ===\n{}",
            align_decl(txt2, &options, "    ", "    ")
        );
        let txt3 = "    bins low = {[0:127]};\n";
        println!(
            "=== bins ===\n{}",
            align_decl(txt3, &options, "    ", "    ")
        );
    }
}

#[cfg(test)]
mod protection_contract_tests {
    use super::*;

    #[test]
    fn initialized_string_semicolons_are_not_declaration_terminators() {
        let input = "string s = \"a;b\";\nstring longer = \"中; 文\"; // keep  trailing  \n";
        let output = align_decl(input, &FormatOptions::default(), "    ", "    ");
        assert!(output.contains("\"a;b\""), "{}", output);
        assert!(output.contains("\"中; 文\""), "{}", output);
        assert!(output.contains("// keep  trailing  \n"), "{}", output);
        assert_eq!(
            align_decl(&output, &FormatOptions::default(), "    ", "    "),
            output
        );
    }

    #[test]
    fn pseudo_declarations_in_comments_and_macros_stay_original() {
        let comment = "/*\n  wire a;\n  wire[7:0] longname;\n*/";
        let macro_text = "`define DECLS \\\n  wire a; \\\n  wire[7:0] longname;\n";
        let input = format!("{}\n{}logic a;\nlogic longname;\n", comment, macro_text);
        let output = align_decl(&input, &FormatOptions::default(), "    ", "    ");
        assert!(output.contains(comment), "{}", output);
        assert!(output.contains(macro_text), "{}", output);
        let columns: Vec<_> = output
            .lines()
            .filter(|line| line.starts_with("logic "))
            .map(|line| line.find(';').unwrap())
            .collect();
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0], columns[1]);
    }

    #[test]
    fn comment_closing_prefixes_and_interleaved_comments_survive() {
        let input = "/*\n  preserved  body\n*/ logic x;\nwire /* preserve  this */ y;\nlogic a;\nlogic longname;\n";
        let output = align_decl(input, &FormatOptions::default(), "    ", "    ");
        assert!(
            output.contains("/*\n  preserved  body\n*/ logic x;\n"),
            "{}",
            output
        );
        assert!(
            output.contains("wire /* preserve  this */ y;"),
            "{}",
            output
        );
    }

    #[test]
    fn dimension_literals_and_escaped_name_terminators_survive() {
        let input = "logic [fnc(\"a]  b\"):0] value;\nwire \\name[0] ;\n";
        let output = align_decl(input, &FormatOptions::default(), "    ", "    ");
        assert!(output.contains("\"a]  b\""), "{}", output);
        assert!(output.contains("\\name[0] ;"), "{}", output);
    }
}
