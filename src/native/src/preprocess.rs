use regex::Regex;

use crate::source_scan::{self, SegmentKind};

/// Preprocess text: if using 1tbs style, merge standalone 'begin' to previous line.
///
/// This replicates `FormatterDaemon::preprocess_text` from daemon.py.
pub fn preprocess_text(text: &str, indent_style: &str, inline_compact: bool) -> String {
    // 行尾归一：CRLF/CR → LF。残留的 \r 会被语句拆分当作行内剩余内容，
    // 在每条语句后插入伪空行，破坏后续对齐分组（同一文件 LF/CRLF 结果不一致）。
    let text = text.replace("\r\n", "\n").replace('\r', "\n");

    // 语句拆行（一行一句；对齐/缩进的基础）——先于 begin 合并
    let text = split_statements(&text);
    // for 头/内联体运算符空格规范化（inlineCompact；关闭则保持原有空格）
    let text = if inline_compact {
        normalize_inline_for(&text)
    } else {
        text
    };
    // modport 列表按方向拆行（`output a,b,input c` → 两行）
    let text = expand_modport(&text);
    // property/sequence 体多余空格归一化（spec §9.5）
    let text = if inline_compact {
        normalize_prop_seq_bodies(&text)
    } else {
        text
    };
    // 单行语句紧凑：用户未自行换行的整语句，词间空白折叠、括号/逗号/分号
    // 紧邻空格删除（spec §7.1 单行对齐逻辑）；多行语句交给列对齐逻辑
    let text = if inline_compact {
        compact_single_line_stmts(&text)
    } else {
        text
    };

    if indent_style != "1tbs" {
        return text;
    }

    let start_keywords = [
        r"\bfork\b",
        r"\brepeat\b",
        r"\bwhile\b",
        r"\bdo\b",
        r"\bforeach\b",
        r"\balways(?:_(?:ff|comb|latch))?\b",
        r"\bif\b",
        r"\belse\b",
        r"\belse\s+if\b",
        r"\bcase\b",
        r"\bfor\b",
        r"\bforever\b",
        r"\btask\b",
        r"\bfunction\b",
        r"\binterface\b",
        r"\bmodule\b",
        r"\bclass\b",
        r"\bpackage\b",
        r"\bprogram\b",
        r"\bclocking\b",
        r"\bblock\b",
        r"\bgenerate\b",
        r"\bspecify\b",
        r"\bproperty\b",
        r"\bsequence\b",
        r"\bcovergroup\b",
        r"\binitial\b",
        r"\bfinal\b",
    ];

    let patterns: Vec<Regex> = start_keywords
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect();

    let lines: Vec<&str> = text.split('\n').collect();
    let code_mask = source_scan::mask_non_code(&text);
    let code_lines: Vec<&str> = code_mask.split('\n').collect();
    let mut processed = Vec::with_capacity(lines.len());
    let mut i = 0;

    while i < lines.len() {
        let current_line = lines[i].trim_end();
        let next_line = if i + 1 < lines.len() {
            lines[i + 1].trim_end()
        } else {
            ""
        };

        let has_line_comment = source_scan::scan(current_line)
            .iter()
            .any(|segment| segment.kind == SegmentKind::LineComment);
        if next_line.trim() == "begin" && !has_line_comment {
            let mut should_merge = false;
            for pat in &patterns {
                if pat.is_match(code_lines[i]) {
                    should_merge = true;
                    break;
                }
            }
            if should_merge {
                processed.push(format!("{} begin", current_line));
                i += 2;
                continue;
            }
        }

        processed.push(lines[i].to_string());
        i += 1;
    }

    processed.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_preprocess_1tbs_merge_begin() {
        let input = "module foo\nbegin\nendmodule";
        let result = preprocess_text(input, "1tbs", true);
        assert_eq!(result, "module foo begin\nendmodule");
    }

    #[test]
    fn test_preprocess_1tbs_no_merge() {
        let input = "assign x = 1;\nbegin";
        let result = preprocess_text(input, "1tbs", true);
        assert_eq!(result, "assign x = 1;\nbegin");
    }

    #[test]
    fn test_preprocess_gnu_noop() {
        let input = "module foo\nbegin\nendmodule";
        let result = preprocess_text(input, "gnu", true);
        assert_eq!(result, input);
    }

    #[test]
    fn test_preprocess_crlf_normalized() {
        let input = "module foo (\r\ninput a\r\n);\r\nendmodule";
        let result = preprocess_text(input, "1tbs", true);
        assert!(!result.contains('\r'), "CR must be stripped: {:?}", result);
    }

    #[test]
    fn test_prop_seq_spacing_normalized() {
        let input = "property   p_stable;\n    @(posedge clk) $rose(valid  ) |=>   wdata   ==      $past(  wdata  );\nendproperty";
        let result = preprocess_text(input, "1tbs", true);
        assert!(
            result.contains("property p_stable;"),
            "header collapsed: {:?}",
            result
        );
        assert!(
            result.contains("@(posedge clk) $rose(valid) |=> wdata == $past(wdata);"),
            "body collapsed: {:?}",
            result
        );
    }

    #[test]
    fn test_prop_seq_spacing_string_comment_kept() {
        let input = "property p;\n    $display(\"a  b\");   // keep   me\nendproperty";
        let result = preprocess_text(input, "1tbs", true);
        assert!(result.contains("\"a  b\""), "string kept: {:?}", result);
        assert!(
            result.contains("// keep   me"),
            "comment kept: {:?}",
            result
        );
    }
}

/// 语句拆行：一行一句。
///  - 代码区（括号深度 0、非字符串/注释）的 `;` 之后若同行还有非注释内容，断行；
///  - 单行 `begin ... end`（整块闭合在同一行）视为紧凑写法，整行保持原样；
///  - `begin` 之后若同行还有语句且本行没有闭合的 `end`，在 begin（含标签）后断行；
///  - 关闭关键字（end/endcase/...）之前若已有内容则断行（"end end" → 两行）。
fn split_statements(text: &str) -> String {
    let masked = source_scan::mask_non_code(text);
    let inline_block = Regex::new(r"\bbegin\b.*\bend\b").unwrap();
    let mut out = Vec::new();
    let mut paren = 0i32;
    let mut brace = 0i32;
    for (line, code) in text.split('\n').zip(masked.split('\n')) {
        if line.trim_end().ends_with('\\') || inline_block.is_match(code) {
            out.push(line.to_string());
            continue;
        }
        let mut start = 0;
        let mut pos = 0;
        let mut split_count = 0;
        while pos < code.len() {
            let ch = code[pos..].chars().next().unwrap();
            if ch.is_alphanumeric() || ch == '_' {
                let end = code[pos..]
                    .find(|c: char| !c.is_alphanumeric() && c != '_')
                    .map_or(code.len(), |offset| pos + offset);
                let word = &code[pos..end];
                if word == "begin" {
                    let mut split_at = end;
                    let mut next = end;
                    while matches!(code.as_bytes().get(next), Some(b' ' | b'\t')) {
                        next += 1;
                    }
                    if code.as_bytes().get(next) == Some(&b':') {
                        next += 1;
                        while matches!(code.as_bytes().get(next), Some(b' ' | b'\t')) {
                            next += 1;
                        }
                        split_at = code[next..]
                            .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
                            .map_or(code.len(), |offset| next + offset);
                    }
                    if !line[split_at..].trim().is_empty() {
                        out.push(line[start..split_at].trim_end().to_string());
                        split_count += 1;
                        start = split_at;
                    }
                    pos = split_at;
                    continue;
                }
                if trailing_close_kw(word) == Some(0) && !code[start..pos].trim().is_empty() {
                    out.push(line[start..pos].trim_end().to_string());
                    split_count += 1;
                    start = pos;
                }
                pos = end;
                continue;
            }
            match ch {
                '(' => paren += 1,
                ')' => paren -= 1,
                '{' => brace += 1,
                '}' => brace -= 1,
                _ => {}
            }
            let end = pos + ch.len_utf8();
            if ch == ';' && paren == 0 && brace == 0 {
                let next = line[end..].trim_start();
                if !next.is_empty() && !next.starts_with('/') {
                    out.push(line[start..end].to_string());
                    split_count += 1;
                    start = line.len() - next.len();
                    pos = start;
                    continue;
                }
            }
            pos = end;
        }
        if !line[start..].trim().is_empty() || split_count == 0 {
            out.push(line[start..].to_string());
        }
    }
    out.join("\n")
}

/// 若 `cur` 以关闭关键字（end/endcase/endmodule/...）结尾且关键字前是词边界，
/// 返回关键字在 cur 中的起始位置。
fn trailing_close_kw(cur: &str) -> Option<usize> {
    const KWS: &[&str] = &[
        "endmodule",
        "endinterface",
        "endfunction",
        "endgenerate",
        "endpackage",
        "endclocking",
        "endprimitive",
        "endprogram",
        "endchecker",
        "endproperty",
        "endsequence",
        "endspecify",
        "endtask",
        "endcase",
        "endclass",
        "endgroup",
        "join_none",
        "join_any",
        "end",
        "join",
    ];
    for kw in KWS {
        if let Some(pos) = cur.len().checked_sub(kw.len()) {
            if cur.ends_with(kw) {
                let before_ok = pos == 0 || {
                    let b = cur.as_bytes()[pos - 1];
                    !b.is_ascii_alphanumeric() && b != b'_'
                };
                if before_ok {
                    return Some(pos);
                }
            }
        }
    }
    None
}

/// 单行 for（for 头 + 内联单条语句，无 begin）运算符空格规范化：
/// `for(int i=0;i<len;i++) sum+=data[i];` → `for(int i = 0; i < len; i++) sum += data[i];`
/// 带 begin 的多行 for 头保持原样。
fn normalize_inline_for(text: &str) -> String {
    let masked = source_scan::mask_non_code(text);
    text.split('\n')
        .zip(masked.split('\n'))
        .map(|(line, code)| {
            if code.trim_start().starts_with("for") {
                normalize_for_line(line)
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_for_line(line: &str) -> String {
    let trimmed = line.trim_start();
    let indent_len = line.len() - trimmed.len();
    let rest = match trimmed.strip_prefix("for") {
        Some(rest) if rest.trim_start().starts_with('(') => rest.trim_start(),
        _ => return line.to_string(),
    };
    let end_idx = match source_scan::find_matching(rest, 0) {
        Some(end) => end,
        None => return line.to_string(),
    };
    let header_norm = normalize_code_fragment(&rest[1..end_idx]);
    let body = rest[end_idx + 1..].trim_start();
    if body.is_empty() {
        return format!("{}for({})", &line[..indent_len], header_norm);
    }
    let body_norm = if body.starts_with("begin") {
        body.to_string()
    } else {
        normalize_code_fragment(body)
    };
    format!("{}for({}) {}", &line[..indent_len], header_norm, body_norm)
}

/// 只在代码区规范运算符空格，保护区按原文切片写回。

fn normalize_code_fragment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for segment in source_scan::scan(s) {
        if segment.kind == SegmentKind::Code {
            out.push_str(&respace_ops(segment.text));
        } else {
            out.push_str(segment.text);
        }
    }
    out.trim().to_string()
}

fn respace_ops(s: &str) -> String {
    let re_op = Regex::new(r"\s*(==|!=|<=|>=|<<|>>|\+=|-=|\*=|/=|%=|=|<|>)\s*").unwrap();
    let out = re_op.replace_all(s, " $1 ");
    let out = Regex::new(r"[ \t]+").unwrap().replace_all(&out, " ");
    let re_sc = Regex::new(r"\s*;\s*").unwrap();
    re_sc.replace_all(&out, "; ").into_owned()
}

/// property/sequence 体内多余空格归一化（spec §9.5）：
/// - 块头 `property   p;` → `property p;`（词间空格折叠）
/// - 体行 `@(posedge clk) $rose(valid  ) |=>   wdata == $past(  wdata  );`
///   → `@(posedge clk) $rose(valid) |=> wdata == $past(wdata);`
/// 仅删多余空格（折叠为单个 + 删括号/逗号/分号紧邻空格），不补缺失的
/// 运算符空格。字符串字面量与行尾注释不动；含块注释的行保守跳过。
fn normalize_prop_seq_bodies(text: &str) -> String {
    let re_head = Regex::new(r"^\s*(property|sequence)\b").unwrap();
    let re_end = Regex::new(r"^\s*(endproperty|endsequence)\b").unwrap();
    let masked = source_scan::mask_non_code(text);
    let mut in_body = false;
    text.split('\n')
        .zip(masked.split('\n'))
        .map(|(line, code)| {
            if re_end.is_match(code) {
                in_body = false;
                line.to_string()
            } else {
                if re_head.is_match(code) {
                    in_body = true;
                }
                if in_body && !code.trim().is_empty() {
                    normalize_expr_line(line)
                } else {
                    line.to_string()
                }
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 表达式空格归一化；字符串、注释和转义标识符保留 UTF-8 原文。

fn normalize_expr_line(line: &str) -> String {
    let segments = source_scan::scan(line);
    if segments
        .iter()
        .any(|segment| segment.kind == SegmentKind::BlockComment)
    {
        return line.to_string();
    }
    let comment_start = segments
        .iter()
        .find(|segment| segment.kind == SegmentKind::LineComment)
        .map_or(line.len(), |segment| segment.range.start);
    let (code, comment) = line.split_at(comment_start);
    let mut out = String::with_capacity(line.len());
    let mut pos = code.len() - code.trim_start().len();
    let mut after_escaped_identifier = false;
    while pos < code.len() {
        if let Some(end) = source_scan::protected_end(code, pos) {
            after_escaped_identifier = code.as_bytes()[pos] == b'\\';
            out.push_str(&code[pos..end]);
            pos = end;
            continue;
        }
        let ch = code[pos..].chars().next().unwrap();
        if ch == ' ' || ch == '\t' {
            let mut end = pos;
            while matches!(code.as_bytes().get(end), Some(b' ' | b'\t')) {
                end += 1;
            }
            let next = code[end..].chars().next();
            let previous = out.chars().next_back();
            if after_escaped_identifier
                || (next.is_some()
                    && !matches!(next, Some(')' | ']' | ',' | ';'))
                    && !matches!(previous, Some('(' | '[' | '!')))
            {
                out.push(' ');
            }
            after_escaped_identifier = false;
            pos = end;
        } else {
            after_escaped_identifier = false;
            out.push(ch);
            pos += ch.len_utf8();
        }
    }
    let mut result = out.trim_end().to_string();
    if !comment.is_empty() && !result.is_empty() {
        result.push(' ');
    }
    result.push_str(comment);
    result
}

/// 单行完整语句参与空格紧凑，多行续行交给布局模块。

fn compact_single_line_stmts(text: &str) -> String {
    let masked = source_scan::mask_non_code(text);
    text.split('\n')
        .zip(masked.split('\n'))
        .map(|(line, code)| {
            if !code.trim().is_empty() && is_single_line_stmt(line) {
                normalize_expr_line(line)
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 仅代码区的分号和括号决定单行语句形态。

fn is_single_line_stmt(line: &str) -> bool {
    let code = source_scan::mask_non_code(line);
    let trimmed = code.trim();
    if trimmed.is_empty()
        || trimmed.starts_with(char::from(96))
        || !trimmed.ends_with(';')
        || source_scan::scan(line)
            .iter()
            .any(|segment| segment.kind == SegmentKind::BlockComment)
    {
        return false;
    }
    let mut depth = 0i32;
    for ch in trimmed.chars() {
        match ch {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

/// modport 列表按方向拆行；布局仍独立于共享词法事实。

fn expand_modport(text: &str) -> String {
    let re_head = Regex::new(r"^([ \t]*modport[ \t]+\w+[ \t]*)\((.*)\)[ \t]*;?[ \t]*$").unwrap();
    let re_dir = Regex::new(r"\b(?:input|output|inout|ref)\b").unwrap();

    let lines: Vec<&str> = text.split('\n').collect();
    let masked = source_scan::mask_non_code(text);
    let code_lines: Vec<&str> = masked.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if !code_lines[i].trim_start().starts_with("modport") {
            out.push(line.to_string());
            i += 1;
            continue;
        }
        // 收集可能跨行的 modport 声明（到 ';' 或 ')' 为止）
        let mut stmt = line.to_string();
        let mut consumed = 1;
        if re_dir.is_match(line) {
            while !stmt.contains(')') || !stmt.trim_end().ends_with(';') {
                if i + consumed >= lines.len() || consumed > 20 {
                    break;
                }
                // 括号未闭合或缺少分号时继续收集
                let closed = source_scan::find_code_char(&stmt, 0, '(')
                    .and_then(|open| source_scan::find_matching(&stmt, open));
                if closed.is_none() || !stmt.trim_end().ends_with(';') {
                    stmt.push('\n');
                    stmt.push_str(lines[i + consumed]);
                    consumed += 1;
                } else {
                    break;
                }
            }
        }
        if source_scan::scan(&stmt)
            .iter()
            .any(|segment| segment.kind != SegmentKind::Code)
        {
            out.push(line.to_string());
            i += 1;
            continue;
        }
        let joined: String = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
        let joined = joined
            .replace(" (", " (")
            .replace("( ", "(")
            .replace(" )", ")");

        if let Some(caps) = re_head.captures(&joined) {
            let head = caps.get(1).unwrap().as_str().trim();
            let inner = caps.get(2).unwrap().as_str().trim();
            // 找方向关键字（保留字，不会出现在变量名里）作为分段起点
            let dirs: Vec<(usize, &str)> = re_dir
                .find_iter(inner)
                .map(|m| (m.start(), m.as_str()))
                .collect();
            if dirs.len() >= 2 {
                let has_semi = stmt.trim_end().ends_with(';');
                out.push(format!("{} (", head));
                for (k, (start, _)) in dirs.iter().enumerate() {
                    let seg_end = dirs.get(k + 1).map(|(s, _)| *s).unwrap_or(inner.len());
                    let seg = inner[*start..seg_end]
                        .trim()
                        .trim_end_matches(',')
                        .trim_end();
                    // 方向后名字列表：逗号 + 空格规范化
                    let mut parts = seg.splitn(2, char::is_whitespace);
                    let dir = parts.next().unwrap_or("");
                    let names_raw = parts.next().unwrap_or("");
                    let names = source_scan::split_top_level(names_raw, ',')
                        .into_iter()
                        .map(|v| v.trim())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                        .join(", ");
                    let comma = if k + 1 < dirs.len() { "," } else { "" };
                    out.push(format!("{} {}{}", dir, names, comma));
                }
                out.push(format!("){}", if has_semi { ";" } else { "" }));
                i += consumed;
                continue;
            }
        }
        out.push(line.to_string());
        i += 1;
    }
    out.join("\n")
}

// ── `pragma protect 加密区切分 ─────────────────────────────────
// Xilinx/Synopsys 加密 IP 的 BASE64 载荷行长（如 line_length=76）是编码
// 规范的一部分，重排/删空格会破坏解密；且长串无 `;`/关键字的行会让
// 对齐器以二次方变慢（万行加密文件需数十分钟）。整区原样透传。

pub enum ProtectSegment {
    Code(String),
    Protected(String),
}

/// 把文本切成交替的普通代码段与 `` `pragma protect `` 加密区（含起止行）。
/// 未闭合的加密区余下全部透传——宁可不格式化也不损坏载荷。
pub fn split_protected_regions(text: &str) -> Vec<ProtectSegment> {
    let re_begin = Regex::new(r"^[ \t]*`(?:pragma[ \t]+)?protect[ \t]+begin_protected").unwrap();
    let re_end = Regex::new(r"^[ \t]*`(?:pragma[ \t]+)?protect[ \t]+end_protected").unwrap();

    let mut segments = Vec::new();
    let mut code_start = 0usize;
    let mut region_start: Option<usize> = None;
    let bytes = text.as_bytes();
    let mut pos = 0usize;
    while pos < bytes.len() {
        let line_end = text[pos..]
            .find('\n')
            .map(|i| pos + i + 1)
            .unwrap_or(bytes.len());
        let line = &text[pos..line_end];
        if region_start.is_none() && re_begin.is_match(line) {
            if pos > code_start {
                segments.push(ProtectSegment::Code(text[code_start..pos].to_string()));
            }
            region_start = Some(pos);
        } else if region_start.is_some() && re_end.is_match(line) {
            segments.push(ProtectSegment::Protected(
                text[region_start.unwrap()..line_end].to_string(),
            ));
            region_start = None;
            code_start = line_end;
        }
        pos = line_end;
    }
    if let Some(rs) = region_start {
        segments.push(ProtectSegment::Protected(text[rs..].to_string()));
    } else if code_start < bytes.len() {
        // 纯空白尾段直接透传，避免空段走管线丢失换行
        if text[code_start..].trim().is_empty() {
            segments.push(ProtectSegment::Protected(text[code_start..].to_string()));
        } else {
            segments.push(ProtectSegment::Code(text[code_start..].to_string()));
        }
    }
    segments
}

#[cfg(test)]
mod protect_tests {
    use super::*;

    #[test]
    fn test_fully_wrapped_passthrough() {
        let txt = "`pragma protect begin_protected\n`pragma protect data_block\nABcd+/12\n`pragma protect end_protected\n";
        let segs = split_protected_regions(txt);
        assert_eq!(segs.len(), 1);
        match &segs[0] {
            ProtectSegment::Protected(s) => assert_eq!(s, txt),
            _ => panic!("expected Protected"),
        }
    }

    #[test]
    fn test_code_around_region() {
        let txt = "module a;\nendmodule\n`protect begin_protected\nZZZZ\n`protect end_protected\nmodule b;\nendmodule\n";
        let segs = split_protected_regions(txt);
        assert_eq!(segs.len(), 3);
        match &segs[0] {
            ProtectSegment::Code(s) => assert!(s.contains("module a")),
            _ => panic!("expected Code"),
        }
        match &segs[1] {
            ProtectSegment::Protected(s) => {
                assert!(s.starts_with("`protect begin_protected"));
                assert!(s.ends_with("end_protected\n"));
            }
            _ => panic!("expected Protected"),
        }
        match &segs[2] {
            ProtectSegment::Code(s) => assert!(s.contains("module b")),
            _ => panic!("expected Code"),
        }
    }

    #[test]
    fn test_unclosed_region_tail_passthrough() {
        let txt = "module a;\nendmodule\n`pragma protect begin_protected\nQQQQ\n";
        let segs = split_protected_regions(txt);
        assert_eq!(segs.len(), 2);
        match &segs[1] {
            ProtectSegment::Protected(s) => assert!(s.contains("QQQQ")),
            _ => panic!("expected Protected"),
        }
    }

    #[test]
    fn test_no_region_single_code() {
        let txt = "module a;\nendmodule\n";
        let segs = split_protected_regions(txt);
        assert_eq!(segs.len(), 1);
        matches!(segs[0], ProtectSegment::Code(_));
    }
}

#[cfg(test)]
mod for_norm_tests {
    use super::*;

    #[test]
    fn test_for_header_block_form() {
        // 块状 for 头归一化（用户报：task 内 for(...) begin 不删多余空格）
        let out = normalize_for_line("        for(int   i=0;i    <  iter;i++) begin");
        assert_eq!(out, "        for(int i = 0; i < iter; i++) begin");
    }

    #[test]
    fn test_for_header_inline_body() {
        let out = normalize_for_line("    for(int   i    = 0; i    <  len;   i++) sum += data[i];");
        assert_eq!(out, "    for(int i = 0; i < len; i++) sum += data[i];");
    }

    #[test]
    fn test_for_body_string_literal_protected() {
        // 字符串字面量内的 = 与空格逐字节保留（既有 bug：respace 曾把
        // "a=b  c" 改成 "a = b  c"）
        let out = normalize_for_line("        for(i=0;i<2;i++) $display(\"a=b  c\");");
        assert_eq!(out, "        for(i = 0; i < 2; i++) $display(\"a=b  c\");");
    }

    #[test]
    fn test_for_header_string_literal() {
        // 头内字符串：括号扫描跳过字符串，字面量内容不动
        let out = normalize_for_line("for(string s=\"x)y\";s!=\"\";s=s.next) begin");
        assert_eq!(out, "for(string s = \"x)y\"; s != \"\"; s = s.next) begin");
    }

    #[test]
    fn test_for_multiline_header_untouched() {
        // 头跨行（用户显式换行）不处理
        let line = "        for(int i = 0;";
        assert_eq!(normalize_for_line(line), line);
    }

    #[test]
    fn test_for_shift_op() {
        let out = normalize_for_line("for(i=0;i<64;i=i<<1) begin");
        assert_eq!(out, "for(i = 0; i < 64; i = i << 1) begin");
    }
}

#[cfg(test)]
mod protect_crlf_tests {
    use super::*;

    #[test]
    fn test_crlf_input_keeps_blank_between_segments() {
        // CRLF 输入：段间空行不得丢失（\r 曾使空行判定失效）
        let txt = "module a;\r\nendmodule\r\n\r\n`pragma protect begin_protected\r\nZZZZ\r\n`pragma protect end_protected\r\n\r\nmodule b;\r\nendmodule\r\n";
        let segs = split_protected_regions(&txt.replace("\r\n", "\n"));
        assert_eq!(segs.len(), 3);
        match &segs[0] {
            ProtectSegment::Code(s) => assert!(s.ends_with("endmodule\n\n")),
            _ => panic!("expected Code"),
        }
        match &segs[2] {
            ProtectSegment::Code(s) => assert!(s.starts_with("\nmodule b")),
            _ => panic!("expected Code"),
        }
    }
}

#[cfg(test)]
mod lexical_contract_tests {
    use super::*;

    #[test]
    fn compact_preserves_utf8_and_escaped_quotes() {
        let literal = r#""中文  (a,b)\" // 仍是字符串""#;
        let input = format!("initial   $display( {} );", literal);
        assert_eq!(
            preprocess_text(&input, "1tbs", true),
            format!("initial $display({});", literal)
        );
    }

    #[test]
    fn comment_keyword_cannot_swallow_begin() {
        let input = "initial\n// if example 中文\nbegin\nx = 1;\nend";
        assert_eq!(preprocess_text(input, "1tbs", true), input);
        let with_line_comment = "if(x) // 中文\nbegin\nx = 1;\nend";
        assert_eq!(
            preprocess_text(with_line_comment, "1tbs", true),
            with_line_comment
        );
        assert!(
            preprocess_text("if(x)\nbegin\nx=1;\nend", "1tbs", true).starts_with("if(x) begin\n")
        );
    }

    #[test]
    fn escaped_identifier_keeps_terminating_whitespace() {
        assert_eq!(
            normalize_expr_line(r"wire \data.if[0] ;"),
            r"wire \data.if[0] ;"
        );
    }

    #[test]
    fn multiline_comments_keep_internal_text() {
        let input = "property p;\n/* begin if (\n  中文  end;\n*/\na;\nendproperty";
        assert!(preprocess_text(input, "1tbs", true).contains("/* begin if (\n  中文  end;\n*/"));
    }

    #[test]
    fn unclosed_literal_is_not_compacted() {
        let input = "initial $display(\"中文  未闭合";
        assert_eq!(preprocess_text(input, "1tbs", true), input);
    }
}

#[cfg(test)]
mod directive_contract_tests {
    use super::*;

    #[test]
    fn macro_body_is_not_preprocessed() {
        let text =
            "`define LOOP \\\n  for(i=0;i<2;i++) a+=b; \\\n  modport m(output a,b,input c);\n";
        assert_eq!(preprocess_text(text, "1tbs", true), text);
    }

    #[test]
    fn modport_with_comments_is_conservatively_preserved() {
        let text = "modport m(output a /* input ) 中文 */,input b);";
        assert_eq!(preprocess_text(text, "1tbs", true), text);
    }
}
