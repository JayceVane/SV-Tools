use regex::Regex;

/// Preprocess text: if using 1tbs style, merge standalone 'begin' to previous line.
///
/// This replicates `FormatterDaemon::preprocess_text` from daemon.py.
pub fn preprocess_text(text: &str, indent_style: &str) -> String {
    // 行尾归一：CRLF/CR → LF。残留的 \r 会被语句拆分当作行内剩余内容，
    // 在每条语句后插入伪空行，破坏后续对齐分组（同一文件 LF/CRLF 结果不一致）。
    let text = text.replace("\r\n", "\n").replace('\r', "\n");

    // 语句拆行（一行一句；对齐/缩进的基础）——先于 begin 合并
    let text = split_statements(&text);
    // 单行 for（for 头 + 内联单条语句）运算符空格规范化
    let text = normalize_inline_for(&text);
    // modport 列表按方向拆行（`output a,b,input c` → 两行）
    let text = expand_modport(&text);
    // property/sequence 体多余空格归一化（spec §9.5）
    let text = normalize_prop_seq_bodies(&text);

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
    let mut processed = Vec::with_capacity(lines.len());
    let mut i = 0;

    while i < lines.len() {
        let current_line = lines[i].trim_end();
        let next_line = if i + 1 < lines.len() {
            lines[i + 1].trim_end()
        } else {
            ""
        };

        if next_line.trim() == "begin" {
            let mut should_merge = false;
            for pat in &patterns {
                if pat.is_match(current_line) {
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
        let result = preprocess_text(input, "1tbs");
        assert_eq!(result, "module foo begin\nendmodule");
    }

    #[test]
    fn test_preprocess_1tbs_no_merge() {
        let input = "assign x = 1;\nbegin";
        let result = preprocess_text(input, "1tbs");
        assert_eq!(result, "assign x = 1;\nbegin");
    }

    #[test]
    fn test_preprocess_gnu_noop() {
        let input = "module foo\nbegin\nendmodule";
        let result = preprocess_text(input, "gnu");
        assert_eq!(result, input);
    }

    #[test]
    fn test_preprocess_crlf_normalized() {
        let input = "module foo (\r\ninput a\r\n);\r\nendmodule";
        let result = preprocess_text(input, "1tbs");
        assert!(!result.contains('\r'), "CR must be stripped: {:?}", result);
    }

    #[test]
    fn test_prop_seq_spacing_normalized() {
        let input = "property   p_stable;\n    @(posedge clk) $rose(valid  ) |=>   wdata   ==      $past(  wdata  );\nendproperty";
        let result = preprocess_text(input, "1tbs");
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
        let result = preprocess_text(input, "1tbs");
        assert!(result.contains("\"a  b\""), "string kept: {:?}", result);
        assert!(result.contains("// keep   me"), "comment kept: {:?}", result);
    }
}

/// 语句拆行：一行一句。
///  - 代码区（括号深度 0、非字符串/注释）的 `;` 之后若同行还有非注释内容，断行；
///  - 单行 `begin ... end`（整块闭合在同一行）视为紧凑写法，整行保持原样；
///  - `begin` 之后若同行还有语句且本行没有闭合的 `end`，在 begin（含标签）后断行；
///  - 关闭关键字（end/endcase/...）之前若已有内容则断行（"end end" → 两行）。
fn split_statements(text: &str) -> String {
    let mut out_lines: Vec<String> = Vec::new();
    let mut in_block_comment = false;
    // 花括号深度跨行持续（constraint / struct 块体可能跨行；
    // 圆括号深度逐行重置即可——括号内 `;` 属 for 头，跨行表达式
    // 的 `;` 只会出现在行尾）
    let mut brace_depth: i32 = 0;
    for line in text.split('\n') {
        // 行续接（`\` 结尾，常用于宏/断言多行语句）：整行原样保留
        if line.trim_end().ends_with('\\') {
            out_lines.push(line.to_string());
            continue;
        }
        let (block_closed, in_block_out) = scan_line_flags(line, in_block_comment);
        if block_closed {
            out_lines.push(line.to_string());
            in_block_comment = in_block_out;
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut cur = String::new();
        let mut depth: i32 = 0;
        let mut in_str = false;
        let mut pushed = 0usize; // 本行已断行次数（末尾空白行抑制）
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if in_block_comment {
                cur.push(c);
                if c == '*' && i + 1 < chars.len() && chars[i + 1] == '/' {
                    cur.push(chars[i + 1]);
                    i += 2;
                    in_block_comment = false;
                    continue;
                }
                i += 1;
                continue;
            }
            if in_str {
                cur.push(c);
                if c == '\\' && i + 1 < chars.len() {
                    cur.push(chars[i + 1]);
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
                // 行内注释原样收尾
                cur.push_str(&chars[i..].iter().collect::<String>());
                break;
            }
            if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
                cur.push_str("/*");
                i += 2;
                in_block_comment = true;
                continue;
            }
            if c == '"' {
                in_str = true;
                cur.push(c);
                i += 1;
                continue;
            }
            if c == '(' {
                depth += 1;
            } else if c == ')' {
                depth -= 1;
            } else if c == '{' {
                brace_depth += 1;
            } else if c == '}' {
                brace_depth -= 1;
            }
            cur.push(c);

            // begin 断行：同行 begin 之后还有语句时（本行无闭合 end 才会走到这里），
            // 在 begin（或 `begin : label` 的标签）之后断行
            if c == 'n'
                && cur.ends_with("begin")
                && !cur[..cur.len() - 5].ends_with(|ch: char| ch.is_alphanumeric() || ch == '_')
                && !(i + 1 < chars.len() && (chars[i + 1].is_alphanumeric() || chars[i + 1] == '_'))
            {
                let mut split_at = i + 1;
                let mut j = split_at;
                while j < chars.len() && (chars[j] == ' ' || chars[j] == '\t') {
                    j += 1;
                }
                if j < chars.len() && chars[j] == ':' {
                    // `begin : label` 标签与 begin 同行
                    let mut k = j + 1;
                    while k < chars.len() && (chars[k] == ' ' || chars[k] == '\t') {
                        k += 1;
                    }
                    while k < chars.len()
                        && (chars[k].is_alphanumeric() || chars[k] == '_' || chars[k] == '$')
                    {
                        k += 1;
                    }
                    split_at = k;
                }
                cur.push_str(&chars[i + 1..split_at].iter().collect::<String>());
                let has_after = chars[split_at..].iter().any(|ch| !ch.is_whitespace());
                if has_after {
                    out_lines.push(cur.trim_end().to_string());
                    pushed += 1;
                    cur.clear();
                }
                i = split_at;
                continue;
            }

            // 关闭关键字断行：单词刚结束时检查（"end end" / "x<=1; end"）
            if (c.is_alphanumeric() || c == '_')
                && !(i + 1 < chars.len()
                    && (chars[i + 1].is_alphanumeric() || chars[i + 1] == '_'))
            {
                if let Some(kw_start) = trailing_close_kw(&cur) {
                    if !cur[..kw_start].trim().is_empty() {
                        let rest = cur[kw_start..].to_string();
                        out_lines.push(cur[..kw_start].trim_end().to_string());
                        pushed += 1;
                        cur = rest;
                    }
                }
            }

            if c == ';' && depth == 0 && brace_depth == 0 {
                // 前瞻：跳过空白；后续是行尾注释或已到行尾则保持同行，否则断行。
                // 花括号深度 > 0（constraint { ...; } / struct { ...; } 等）不拆，
                // 单行块保持单行
                let mut j = i + 1;
                while j < chars.len() && (chars[j] == ' ' || chars[j] == '\t') {
                    j += 1;
                }
                if j < chars.len() && chars[j] != '/' {
                    out_lines.push(cur.clone());
                    pushed += 1;
                    cur.clear();
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
        if !cur.trim().is_empty() || pushed == 0 {
            out_lines.push(cur);
        }
    }
    out_lines.join("\n")
}

/// 扫描一行，返回（本行是否存在配对的单行 begin...end 块，行尾时的块注释状态）。
/// 注释/字符串区域内的 begin/end 不参与判定。
fn scan_line_flags(line: &str, in_block_start: bool) -> (bool, bool) {
    let chars: Vec<char> = line.chars().collect();
    let mut in_block = in_block_start;
    let mut in_str = false;
    let mut seen_begin = false;
    let mut closed = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_block {
            if c == '*' && i + 1 < chars.len() && chars[i + 1] == '/' {
                in_block = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
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
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            in_block = true;
            i += 2;
            continue;
        }
        if c == '"' {
            in_str = true;
            i += 1;
            continue;
        }
        if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if word == "begin" {
                seen_begin = true;
            } else if word == "end" && seen_begin {
                closed = true;
            }
            continue;
        }
        i += 1;
    }
    (closed, in_block)
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
    let mut out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        out.push(normalize_for_line(line));
    }
    out.join("\n")
}

fn normalize_for_line(line: &str) -> String {
    let trimmed = line.trim_start();
    let indent_len = line.len() - trimmed.len();
    let rest = match trimmed.strip_prefix("for") {
        Some(r) => r,
        None => return line.to_string(),
    };
    let rest = rest.trim_start();
    if !rest.starts_with('(') {
        return line.to_string();
    }
    let mut depth = 0i32;
    let mut close: Option<usize> = None;
    for (idx, ch) in rest.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(idx);
                    break;
                }
            }
            '"' => return line.to_string(),
            _ => {}
        }
    }
    let end_idx = match close {
        Some(e) => e,
        None => return line.to_string(),
    };
    let header = &rest[1..end_idx];
    let body = rest[end_idx + 1..].trim_start();
    if body.is_empty() || body.starts_with("begin") {
        return line.to_string();
    }
    let header = respace_ops(header);
    let body = respace_ops(body);
    format!("{}for({}) {}", &line[..indent_len], header, body)
}

fn respace_ops(s: &str) -> String {
    let re_op = Regex::new(r"\s*(==|!=|<=|>=|<<|>>|\+=|-=|\*=|/=|%=|=|<|>)\s*").unwrap();
    let out = re_op.replace_all(s, " $1 ");
    let re_sc = Regex::new(r";\s*").unwrap();
    let out = re_sc.replace_all(&out, "; ");
    out.trim().to_string()
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
    let mut out: Vec<String> = Vec::new();
    let mut in_body = false;
    for line in text.split('\n') {
        if in_body {
            if re_end.is_match(line) {
                in_body = false;
                out.push(line.to_string());
            } else {
                out.push(normalize_expr_line(line));
            }
            continue;
        }
        if re_head.is_match(line) {
            in_body = true;
            out.push(normalize_expr_line(line));
            continue;
        }
        out.push(line.to_string());
    }
    out.join("\n")
}

/// 表达式行空格归一化：缩进保留；代码区空白串折叠为单个空格；
/// `(` 后、`)`/`,`/`;` 前的空格删除。字符串字面量原样；行尾注释原样。
fn normalize_expr_line(line: &str) -> String {
    // 行尾注释切分（代码区不含 //）
    let bytes = line.as_bytes();
    let mut comment_start = line.len();
    let mut in_str = false;
    let mut esc = false;
    for i in 0..bytes.len().saturating_sub(1) {
        if in_str {
            if esc {
                esc = false;
                continue;
            }
            if bytes[i] == b'\\' {
                esc = true;
            } else if bytes[i] == b'"' {
                in_str = false;
            }
            continue;
        }
        if bytes[i] == b'"' {
            in_str = true;
        } else if bytes[i] == b'/' && bytes[i + 1] == b'/' {
            comment_start = i;
            break;
        }
    }
    let (code, comment) = line.split_at(comment_start);
    if code.contains("/*") {
        // 块注释保守跳过
        return line.to_string();
    }

    let cb = code.as_bytes();
    let indent_end = code.len() - code.trim_start().len();
    let mut out = String::with_capacity(code.len());
    // 掩码状态：逐字符扫描，字符串内原样复制
    let mut i = indent_end;
    let mut in_str = false;
    while i < cb.len() {
        let c = cb[i] as char;
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < cb.len() {
                out.push(cb[i + 1] as char);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == ' ' || c == '\t' {
            // 空白串折叠：吃掉整个串，按下一个非空白字符决定输出
            let mut j = i;
            while j < cb.len() && (cb[j] == b' ' || cb[j] == b'\t') {
                j += 1;
            }
            if j >= cb.len() {
                break; // 行尾空白丢弃（trim）
            }
            let next = cb[j] as char;
            let prev = out.as_bytes().last().copied().unwrap_or(b' ') as char;
            // `)`/`,`/`;` 前不留空格；`(`/`!` 后不留空格；其余折叠为单个
            if next == ')' || next == ',' || next == ';' {
                // 不输出空格
            } else if prev == '(' || prev == '!' {
                // 不输出空格
            } else {
                out.push(' ');
            }
            i = j;
            continue;
        }
        out.push(c);
        i += 1;
    }

    let mut result = out.trim_end().to_string();
    result.push_str(comment);
    result
}

/// modport 列表按方向拆行：`modport master(output a,b,input c);`/// → `modport master (\noutput a, b,\ninput c\n);`（逗号后补空格）。
/// 缩进交由 beautifier（modport 的括号会推入 "(" 状态）。
fn expand_modport(text: &str) -> String {
    let re_head = Regex::new(r"^([ \t]*modport[ \t]+\w+[ \t]*)\((.*)\)[ \t]*;?[ \t]*$").unwrap();
    let re_dir = Regex::new(r"\b(?:input|output|inout|ref)\b").unwrap();

    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        // 收集可能跨行的 modport 声明（到 ';' 或 ')' 为止）
        let mut stmt = line.to_string();
        let mut consumed = 1;
        if re_dir.is_match(line) {
            while !stmt.contains(')') || !stmt.trim_end().ends_with(';') {
                if i + consumed >= lines.len() || consumed > 20 {
                    break;
                }
                // 括号未闭合或缺少分号时继续收集
                if stmt.matches('(').count() > stmt.matches(')').count()
                    || (stmt.contains(')') && !stmt.contains(';'))
                {
                    stmt.push('\n');
                    stmt.push_str(lines[i + consumed]);
                    consumed += 1;
                } else {
                    break;
                }
            }
        }
        let joined: String = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
        let joined = joined.replace(" (", " (").replace("( ", "(").replace(" )", ")");

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
                    let seg = inner[*start..seg_end].trim().trim_end_matches(',').trim_end();
                    // 方向后名字列表：逗号 + 空格规范化
                    let mut parts = seg.splitn(2, char::is_whitespace);
                    let dir = parts.next().unwrap_or("");
                    let names_raw = parts.next().unwrap_or("");
                    let names = names_raw
                        .split(',')
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
