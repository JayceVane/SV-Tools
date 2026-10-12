use regex::Regex;
use std::sync::LazyLock;

static CASE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^[ \t]*(?P<scope>\w+\:\:)?(?P<name>[\w`'".\?]+)[ \t]*(\[(?P<bitslice>.*?)\])?[ \t]*(?P<op>\:)[ \t]*(?P<statement>.*)$"#).expect("valid assignment pattern")
});
static CONTINUOUS_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^[ \t]*(?P<scope>assign)\s+(?P<name>[\w`'"\.]+)[ \t]*(\[(?P<bitslice>.*?)\])?\s*(?P<op>=)\s*(?P<statement>.*)$"#).expect("valid assignment pattern")
});
static PROCEDURAL_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^[ \t]*(?P<scope>)(?P<name>[\w`'"\.]+)[ \t]*(\[(?P<bitslice>.*?)\])?\s*(?P<op>(<)?=)\s*(?P<statement>.*)$"#).expect("valid assignment pattern")
});
use std::collections::HashMap;

use crate::config::FormatOptions;
use crate::source_scan::{self, SegmentKind, SourceCaptures};

/// 此次对齐作用于哪一类赋值，调用方无需理解位掩码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssignmentKind {
    Case,
    Continuous,
    Procedural,
    All,
}
impl AssignmentKind {
    fn mask(self) -> u32 {
        match self {
            Self::Case => 1,
            Self::Continuous => 2,
            Self::Procedural => 4,
            Self::All => 7,
        }
    }
}

/// Align assignments: case/struct (`:`), continuous assign (`=`), blocking/non-blocking (`<=`/`=`).
/// Replicates Python `VerilogBeautifier.alignAssign()`.
pub fn align_assign(
    txt: &str,
    kind: AssignmentKind,
    options: &FormatOptions,
    indent: &str,
    indent_space: &str,
) -> String {
    let mask_op = kind.mask();
    let mut re_str_list: Vec<&Regex> = Vec::new();

    // case/structure: "word: statement"
    // 注：Rust regex 不支持 (?!\:) 前瞻；`::`（作用域）场景在重建时按
    // statement 是否以 ':' 开头过滤。
    if mask_op & 1 != 0 {
        re_str_list.push(&*CASE_PATTERN);
    }
    // Continuous assignment: "assign word = statement"
    if mask_op & 2 != 0 {
        re_str_list.push(&*CONTINUOUS_PATTERN);
    }
    // Assignment: "word <= statement"
    if mask_op & 4 != 0 {
        re_str_list.push(&*PROCEDURAL_PATTERN);
    }

    let mut txt_new = txt.to_string();

    for re_str in &re_str_list {
        let re = *re_str;

        let layout_mask = source_scan::mask_for_layout(&txt_new);
        let mut masked_lines: Vec<&str> = layout_mask.split('\n').collect();
        let mut lines: Vec<&str> = txt_new.split('\n').collect();
        // 尾部空元素是"以 \n 结尾"的终止符标记，不是内容行——不剥掉的话
        // 每趟正则都会多补一个换行（mask 7 三趟叠加出两个伪影空行）
        if txt_new.ends_with('\n') {
            lines.pop();
            masked_lines.pop();
        }
        let mut lines_match: Vec<(&str, Option<SourceCaptures<'_, '_>>, usize, isize, &str)> =
            Vec::new();
        let mut matched = false;
        let mut ilvl: isize = -1;
        let mut ilvl_prev: isize;
        let mut max_len: HashMap<isize, usize> = HashMap::new();
        let mut max_len_idx: isize = -1;

        let ilvl_glob = (mask_op & 1 != 0)
            && re_str.as_str().starts_with(r"^[ \t]*(?P<scope>\\w+")
            && txt.trim().ends_with(';')
            && !txt.trim().starts_with("always");

        for (l, masked) in lines.iter().zip(&masked_lines) {
            let m = source_scan::captures(re, l, masked);
            ilvl_prev = ilvl;
            // 空行透明：空行缩进按 0 计会把对齐组切断，且空行的增删
            // （如块内空行删除规则）会让两遍格式化算出不同组宽——
            // 空行不更新缩进，继承前一非空行，组判定只看代码行
            if !l.trim().is_empty() {
                ilvl = get_indent_level(l, options, indent, indent_space) as isize;
            }

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
                    let bs = source_scan::without_code_whitespace(bitslice.as_str());
                    len_c += bs.len() + 2;
                }
                if len_c > max_len[&idx] {
                    max_len.insert(idx, len_c);
                }
            }

            lines_match.push((l, m, ilvl as usize, idx, masked));
        }

        if matched {
            let mut txt_new_tmp = String::new();
            let mut any_changed = false;
            let is_case_group = mask_op & 1 != 0 && re.as_str() == CASE_PATTERN.as_str();
            // 紧凑保留模式：块内仍有同行多语句（如 "begin a<=0;b<=0; end"）时，
            // 说明用户写作风格是紧凑的，case 项保持原样；否则（一句一行）规范化
            // case 项内赋值运算符空格（ex1 保持紧凑 / ex1.1 规范化）。
            let compact_preserve = is_case_group
                && lines_match
                    .iter()
                    .any(|(_, _, _, _, masked)| count_depth0_semicolons(masked) >= 2);
            // 语句未写完判定（仅 assign 趟 mask==2）：上一条非空行不以 ';' 结尾
            // 时语句跨行（多行拼接/破行），其内部空行是格式化残留，丢弃。

            for (_, (line, caps, ilvl_val, len_idx, masked)) in lines_match.iter().enumerate() {
                if let Some(m) = caps {
                    if is_case_group {
                        // 紧凑 case 项（冒号后无空格，如 "4'd0:result<=x;"）：
                        // 保持 "name:statement" 形态，仅规范化语句内的赋值运算符空格；
                        // 冒号后有空格或 :: 作用域的行，以及紧凑保留模式保持原样。
                        let stmt = m.name("statement").unwrap();
                        let stmt_start = stmt.start();
                        let before_colon =
                            stmt_start > 0 && line.as_bytes()[stmt_start - 1] == b':';
                        let starts_scope = stmt.as_str().starts_with(':');
                        if before_colon
                            && !starts_scope
                            && !stmt.as_str().trim().is_empty()
                            && !compact_preserve
                        {
                            let scope = m.name("scope").map(|s| s.as_str()).unwrap_or("");
                            let norm = normalize_assign_spacing(stmt.as_str());
                            txt_new_tmp.push_str(&format!(
                                "{}{}{}:{}\n",
                                indent.repeat(*ilvl_val),
                                scope,
                                m.name("name").unwrap().as_str(),
                                norm
                            ));
                            any_changed = true;
                        } else {
                            txt_new_tmp
                                .push_str(&format!("{}\n", source_scan::trim_code_end(line)));
                        }

                        continue;
                    }
                    let mut l = String::new();
                    if let Some(scope) = m.name("scope") {
                        l.push_str(scope.as_str());
                        if scope.as_str() == "assign" {
                            l.push(' ');
                        }
                    }
                    l.push_str(m.name("name").unwrap().as_str());
                    if let Some(bitslice) = m.name("bitslice") {
                        let bs = source_scan::without_code_whitespace(bitslice.as_str());
                        l.push_str(&format!("[{}]", bs));
                    }
                    let ml = max_len.get(len_idx).unwrap_or(&0);
                    // statement trim_end：分号悬挂对齐移除后，输入残留的
                    // 手工空格（"addr ;"）不再被悬挂重排掩盖，须在此清理
                    l = format!(
                        "{}{:<width$} {} {}",
                        indent.repeat(*ilvl_val),
                        l,
                        m.name("op").unwrap().as_str(),
                        source_scan::trim_code_end(m.name("statement").unwrap().as_str()),
                        width = ml
                    );

                    txt_new_tmp.push_str(&format!("{}\n", source_scan::trim_code_end(&l)));
                } else {
                    // 用户空行原样传给最终空行 pass；对齐只负责列宽。
                    // 续行：代码区内连续空格压缩为单个（含错误对齐残留的宽空格），
                    // 行尾注释之前的手工对齐空格保留。
                    // 仅破行表达式的中间片段（以运算符结尾，如 "a == b   ||"）需要
                    // 压缩；完整行（赋值语句、端口连接、实例头、列表项）可能带对齐
                    // 填充，一律原样保留。
                    if masked.trim_start().starts_with('/') {
                        // 跨行保护区的原始行也不能被 trim_end 改写。
                        txt_new_tmp.push_str(&format!("{}\n", line));
                    } else if is_case_item_line(masked) || !ends_with_operator(masked) {
                        txt_new_tmp.push_str(&format!("{}\n", source_scan::trim_code_end(line)));
                    } else {
                        txt_new_tmp.push_str(&format!("{}\n", normalize_code_spaces(line)));
                    }
                }
            }

            // 分号悬挂（同缩进组对齐到最长行）已移除：语句（过程赋值）的分号
            // 应贴合表达式（用户语义：代码不是表格）；声明区的表格化悬挂
            // （decl 趟）不受影响。空行透明的组宽逻辑随之失效场景消失。

            // Don't remove trailing newline - blocks should end with newline
            // case 组无任何紧凑项时不重建（保持原文本，避免仅 trim 行尾的差异）
            if !is_case_group || any_changed {
                txt_new = txt_new_tmp;
            }
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
/// 统计一行中括号深度 0 处的语句分隔符 ';' 数量（注释/字符串/括号内不计）。
/// 同行多语句（≥2）表示紧凑写作风格。
fn count_depth0_semicolons(line: &str) -> usize {
    let chars: Vec<char> = line.chars().collect();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut count = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            if c == '\\' && i + 1 < chars.len() {
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            break;
        }
        if c == '"' {
            in_str = true;
            i += 1;
            continue;
        }
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ';' if depth == 0 => count += 1,
            _ => {}
        }
        i += 1;
    }
    count
}

/// 语句级赋值运算符（`<=`/`=`）对齐：按缩进分组，把简单赋值
/// （`name op rhs;`，name 为单一标识符）的操作符列对齐；其它行原样保留。
/// 用于 begin...end 语句块（如 for/if 体），不做分号填充、不改内部空格。
pub fn align_stmt_ops(txt: &str, options: &FormatOptions, indent: &str) -> String {
    let re = Regex::new(
        r"^(?P<indent>[ \t]*)(?P<name>[A-Za-z_]\w*)[ \t]*(?P<op><=|=)[ \t]*(?P<rhs>[^=].*)$",
    )
    .unwrap();
    let layout_mask = source_scan::mask_for_layout(txt);
    let mut masked_lines: Vec<&str> = layout_mask.split('\n').collect();
    let mut lines: Vec<&str> = txt.split('\n').collect();
    // 尾部空元素是终止符标记，不是内容行（否则文件末尾多补一个换行）
    if txt.ends_with('\n') {
        lines.pop();
        masked_lines.pop();
    }

    // 第一遍：分组（缩进变化分段），统计 name 最大宽度。
    // 空行透明：不重置缩进（空行增删不改变对齐组宽，保证幂等）
    let mut widths: HashMap<usize, usize> = HashMap::new();
    let mut group = 0usize;
    let mut prev_indent: Option<usize> = None;
    for (l, masked) in lines.iter().zip(&masked_lines) {
        if l.trim().is_empty() {
            continue;
        }
        let ilvl = get_indent_level(l, options, indent, indent);
        if prev_indent.map(|p| p != ilvl).unwrap_or(true) {
            group += 1;
            prev_indent = Some(ilvl);
        }
        if let Some(c) = source_scan::captures(&re, l, masked) {
            let n = c.name("name").unwrap().as_str().len();
            let e = widths.entry(group).or_insert(0);
            if n > *e {
                *e = n;
            }
        }
    }

    // 第二遍：重写匹配行（空行透明，见第一遍注释）
    let mut out = String::new();
    group = 0;
    prev_indent = None;
    for (l, masked) in lines.iter().zip(&masked_lines) {
        if l.trim().is_empty() {
            out.push_str(l);
            out.push('\n');
            continue;
        }
        let ilvl = get_indent_level(l, options, indent, indent);
        if prev_indent.map(|p| p != ilvl).unwrap_or(true) {
            group += 1;
            prev_indent = Some(ilvl);
        }
        if let Some(c) = source_scan::captures(&re, l, masked) {
            let w = *widths.get(&group).unwrap_or(&0);
            let name = c.name("name").unwrap().as_str();
            let op = c.name("op").unwrap().as_str();
            let rhs = source_scan::trim_code_end(c.name("rhs").unwrap().as_str());
            out.push_str(&format!(
                "{}{:<width$} {} {}",
                c.name("indent").unwrap().as_str(),
                name,
                op,
                rhs,
                width = w
            ));
            out.push('\n');
            continue;
        }
        out.push_str(l);
        out.push('\n');
    }
    if !txt.ends_with('\n') {
        out.pop();
    }
    out
}

/// 行尾悬空运算符判定（破行表达式续行的中间片段特征）。
fn ends_with_operator(line: &str) -> bool {
    crate::parser::patterns::RE_LINE_ENDS_WITH_OP.is_match(line.trim_end())
}

/// case 项形态判定：`NAME : statement`（冒号后有空格、非 `::`）。
/// 用于续行规范化时保护 case 项的既有列对齐。
fn is_case_item_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    // 名字部分：[\w`'".]+
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_alphanumeric() || c == '_' || c == '`' || c == '\'' || c == '.' {
            i += 1;
        } else {
            break;
        }
    }
    if i == 0 || i >= bytes.len() {
        return false;
    }
    let mut j = i;
    while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
        j += 1;
    }
    if j >= bytes.len() || bytes[j] != b':' {
        return false;
    }
    // 排除 `::` 作用域与 `:=`（罕见）
    if j + 1 < bytes.len() && bytes[j + 1] == b':' {
        return false;
    }
    true
}

/// 单条语句内的赋值运算符空格规范化：`result<=operand_a+operand_b;`
/// → `result <= operand_a+operand_b;`。仅给赋值运算符（=、<=）两侧补空格，
/// 不改动表达式内部（如 `a+b` 不加空格）。
pub fn normalize_assign_spacing(stmt: &str) -> String {
    let masked = source_scan::mask_non_code(stmt);
    let bytes = masked.as_bytes();
    let mut pos = 0;
    while pos < bytes.len() {
        let length = if bytes[pos] == b'<' && bytes.get(pos + 1) == Some(&b'=') {
            2
        } else if bytes[pos] == b'='
            && !matches!(
                pos.checked_sub(1).and_then(|before| bytes.get(before)),
                Some(b'=' | b'!' | b'<' | b'>')
            )
            && bytes.get(pos + 1) != Some(&b'=')
        {
            1
        } else {
            0
        };
        if length > 0 {
            return format!(
                "{} {} {}",
                source_scan::trim_code_end(&stmt[..pos]),
                &stmt[pos..pos + length],
                stmt[pos + length..].trim_start()
            );
        }
        pos += 1;
    }
    source_scan::trim_code_end(stmt).to_string()
}

/// 压缩代码区内的连续空格为单个；行尾注释（//）之前的手工对齐空格保留。
/// 用于 assign/表达式续行：输入中错位的多空格（如 "ST_CPWS   ||"）规范化为单空格。
pub fn normalize_code_spaces(line: &str) -> String {
    let indent_end = line.len() - line.trim_start().len();
    let mut out = line[..indent_end].to_string();
    for segment in source_scan::scan(&line[indent_end..]) {
        if segment.kind != SegmentKind::Code {
            out.push_str(segment.text);
            continue;
        }
        let mut previous_space = false;
        for ch in segment.text.chars() {
            if ch == ' ' || ch == '\t' {
                if !previous_space {
                    out.push(' ');
                }
                previous_space = true;
            } else {
                out.push(ch);
                previous_space = false;
            }
        }
    }
    source_scan::trim_code_end(&out).to_string()
}

#[cfg(test)]
mod protection_contract_tests {
    use super::*;

    #[test]
    fn operator_normalization_ignores_literals_and_comments() {
        let expression = r#"$display("a=b // c");"#;
        assert_eq!(normalize_assign_spacing(expression), expression);
        assert_eq!(
            normalize_assign_spacing(r#"q<= "a=b // c" /* x=y */; // tail  "#),
            r#"q <= "a=b // c" /* x=y */; // tail  "#
        );
        assert_eq!(
            normalize_code_spaces(r#"   f("a  b // c", x)   + //  保留  "#),
            r#"   f("a  b // c", x) + //  保留  "#
        );
    }

    #[test]
    fn continuous_alignment_preserves_literal_continuations_and_protected_blocks() {
        let comment = "/*\n  assign a=1;  \n  assign longer=2;\n*/";
        let macro_text = "`define APPLY \\\n  assign a=1; \\\n  assign longer=2;   \n";
        let input = format!(
            "{}\n{}assign x = cond ?\n f(\"a  b\") +\n c : d;\nassign longer_name = value;\n",
            comment, macro_text
        );
        let output = align_assign(
            &input,
            AssignmentKind::Continuous,
            &FormatOptions::default(),
            "    ",
            "    ",
        );
        assert!(output.contains(comment), "{}", output);
        assert!(output.contains(macro_text), "{}", output);
        assert!(output.contains("\"a  b\""), "{}", output);
        let columns: Vec<_> = output
            .lines()
            .filter(|line| line.starts_with("assign "))
            .map(|line| line.find('=').unwrap())
            .collect();
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0], columns[1]);
    }

    #[test]
    fn full_text_statement_alignment_ignores_macro_and_comment_pseudo_assignments() {
        let comment = "/*\n  a=1;\n  longname=2;\n*/";
        let macro_text = "`define INIT \\\n  a=1; \\\n  longname=2;\n";
        let input = format!("{}\n{}    a=1;\n    longname=2;\n", comment, macro_text);
        let output = align_stmt_ops(&input, &FormatOptions::default(), "    ");
        assert!(output.contains(comment), "{}", output);
        assert!(output.contains(macro_text), "{}", output);
        let code: Vec<_> = output
            .lines()
            .filter(|line| line.starts_with("    "))
            .collect();
        assert_eq!(code[0].find('='), code[1].find('='));
        assert_eq!(
            align_stmt_ops(&output, &FormatOptions::default(), "    "),
            output
        );
    }
}
