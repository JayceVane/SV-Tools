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
    // 注：Rust regex 不支持 (?!\:) 前瞻；`::`（作用域）场景在重建时按
    // statement 是否以 ':' 开头过滤。
    if mask_op & 1 != 0 {
        re_str_list.push(
            r#"^[ \t]*(?P<scope>\w+\:\:)?(?P<name>[\w`'".\?]+)[ \t]*(\[(?P<bitslice>.*?)\])?[ \t]*(?P<op>\:)[ \t]*(?P<statement>.*)$"#
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
            let mut any_changed = false;
            let is_case_group = mask_op & 1 != 0 && re_str == &re_str_list[0];
            // 紧凑保留模式：块内仍有同行多语句（如 "begin a<=0;b<=0; end"）时，
            // 说明用户写作风格是紧凑的，case 项保持原样；否则（一句一行）规范化
            // case 项内赋值运算符空格（ex1 保持紧凑 / ex1.1 规范化）。
            let compact_preserve = is_case_group
                && lines_match
                    .iter()
                    .any(|(l, _, _, _)| count_depth0_semicolons(l) >= 2);
            for (_, (line, caps, ilvl_val, len_idx)) in lines_match.iter().enumerate() {
                if let Some(m) = caps {
                    if is_case_group {
                        // 紧凑 case 项（冒号后无空格，如 "4'd0:result<=x;"）：
                        // 保持 "name:statement" 形态，仅规范化语句内的赋值运算符空格；
                        // 冒号后有空格或 :: 作用域的行，以及紧凑保留模式保持原样。
                        let stmt = m.name("statement").unwrap();
                        let stmt_start = stmt.start();
                        let before_colon = stmt_start > 0 && line.as_bytes()[stmt_start - 1] == b':';
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
                            txt_new_tmp.push_str(&format!("{}\n", line.trim_end()));
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
                    // 续行：代码区内连续空格压缩为单个（含错误对齐残留的宽空格），
                    // 行尾注释之前的手工对齐空格保留。
                    // 仅破行表达式的中间片段（以运算符结尾，如 "a == b   ||"）需要
                    // 压缩；完整行（赋值语句、端口连接、实例头、列表项）可能带对齐
                    // 填充，一律原样保留。
                    if is_case_item_line(line) || !ends_with_operator(line) {
                        txt_new_tmp.push_str(&format!("{}\n", line.trim_end()));
                    } else {
                        txt_new_tmp.push_str(&format!("{}\n", normalize_code_spaces(line)));
                    }
                }
            }

            // Semicolon alignment: for always block assignments (mask_op & 4),
            // align semicolons within the same indent level group
            if mask_op & 4 != 0 && options.align_comma() {
                txt_new_tmp = align_semicolons(&txt_new_tmp);
            }

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
fn align_semicolons(txt: &str) -> String {
    let lines: Vec<&str> = txt.split('\n').collect();
    let mut max_semi_pos: HashMap<usize, usize> = HashMap::new();

    // First pass: calculate indent level groups and find max content length (before semicolon)
    let mut current_group: usize = 0;
    let mut prev_indent: usize = 0;
    for l in &lines {
        let trimmed = l.trim_end();
        if trimmed.is_empty() {
            current_group += 1; // blank lines separate alignment groups
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
            current_group += 1; // blank lines separate alignment groups
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
    let re = Regex::new(r"^(?P<indent>[ \t]*)(?P<name>[A-Za-z_]\w*)[ \t]*(?P<op><=|=)[ \t]*(?P<rhs>[^=].*)$")
        .unwrap();
    let lines: Vec<&str> = txt.split('\n').collect();

    // 第一遍：分组（缩进变化或空行分段），统计 name 最大宽度
    let mut widths: HashMap<usize, usize> = HashMap::new();
    let mut group = 0usize;
    let mut prev_indent: Option<usize> = None;
    for l in &lines {
        if l.trim().is_empty() {
            prev_indent = None;
            continue;
        }
        let ilvl = get_indent_level(l, options, indent, indent);
        if prev_indent.map(|p| p != ilvl).unwrap_or(true) {
            group += 1;
            prev_indent = Some(ilvl);
        }
        if let Some(c) = re.captures(l) {
            let n = c.name("name").unwrap().as_str().len();
            let e = widths.entry(group).or_insert(0);
            if n > *e {
                *e = n;
            }
        }
    }

    // 第二遍：重写匹配行
    let mut out = String::new();
    group = 0;
    prev_indent = None;
    for l in &lines {
        if l.trim().is_empty() {
            prev_indent = None;
            out.push_str(l);
            out.push('\n');
            continue;
        }
        let ilvl = get_indent_level(l, options, indent, indent);
        if prev_indent.map(|p| p != ilvl).unwrap_or(true) {
            group += 1;
            prev_indent = Some(ilvl);
        }
        if let Some(c) = re.captures(l) {
            let w = *widths.get(&group).unwrap_or(&0);
            let name = c.name("name").unwrap().as_str();
            let op = c.name("op").unwrap().as_str();
            let rhs = c.name("rhs").unwrap().as_str().trim_end();
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
    // 行尾注释之前的部分才是代码
    let bytes = stmt.as_bytes();
    let mut comment_start = stmt.len();
    for i in 0..bytes.len().saturating_sub(1) {
        if bytes[i] == b'/' && bytes[i + 1] == b'/' {
            comment_start = i;
            break;
        }
    }
    let (code, comment) = stmt.split_at(comment_start);
    let trimmed = code.trim_end();

    // 找赋值运算符：优先 <=，其次 =（排除 ==、!=、>=、<= 之外的比较）
    let mut op_pos: Option<(usize, usize)> = None; // (位置, 长度)
    let cb = trimmed.as_bytes();
    let mut i = 0;
    while i < cb.len() {
        if cb[i] == b'<' && i + 1 < cb.len() && cb[i + 1] == b'=' {
            op_pos = Some((i, 2));
            break;
        }
        if cb[i] == b'=' {
            let prev = if i > 0 { cb[i - 1] } else { b' ' };
            let next = if i + 1 < cb.len() { cb[i + 1] } else { b' ' };
            if prev != b'=' && prev != b'!' && prev != b'<' && prev != b'>' && next != b'=' {
                op_pos = Some((i, 1));
                break;
            }
        }
        i += 1;
    }

    let out = match op_pos {
        Some((pos, len)) => {
            let lhs = trimmed[..pos].trim_end();
            let rhs = trimmed[pos + len..].trim_start();
            format!("{} {} {}", lhs, &trimmed[pos..pos + len], rhs)
        }
        None => trimmed.to_string(),
    };
    format!("{}{}", out, comment)
}

/// 压缩代码区内的连续空格为单个；行尾注释（//）之前的手工对齐空格保留。
/// 用于 assign/表达式续行：输入中错位的多空格（如 "ST_CPWS   ||"）规范化为单空格。
pub fn normalize_code_spaces(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut comment_start = line.len();
    for i in 0..bytes.len().saturating_sub(1) {
        if bytes[i] == b'/' && bytes[i + 1] == b'/' {
            comment_start = i;
            break;
        }
    }
    let (code, comment) = line.split_at(comment_start);
    // 前导缩进原样保留（从首个非空白字符起压缩）
    let lead = code.len() - code.trim_start().len();
    let (indent_part, rest) = code.split_at(lead);
    let mut out = String::from(indent_part);
    let mut in_space = false;
    for c in rest.chars() {
        if c == ' ' || c == '\t' {
            if !in_space {
                out.push(' ');
                in_space = true;
            }
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out.push_str(comment);
    out.trim_end().to_string()
}
