//! 保留原文区间的轻量词法扫描。布局模块只消费代码区，保护区始终以原文切片传递。

use std::ops::Range;

use regex::{Captures, Regex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentKind {
    Code,
    String,
    LineComment,
    BlockComment,
    EscapedIdentifier,
    Directive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment<'a> {
    pub kind: SegmentKind,
    pub text: &'a str,
    pub range: Range<usize>,
}

/// 扫描完整原文；区间连续覆盖输入，未闭合的字符串或块注释保护至 EOF。
pub fn scan(text: &str) -> Vec<Segment<'_>> {
    let mut segments = Vec::new();
    let mut code_start = 0;
    let mut pos = 0;
    while pos < text.len() {
        if let Some((kind, end)) = protected_region(text, pos) {
            if code_start < pos {
                segments.push(segment(text, SegmentKind::Code, code_start..pos));
            }
            segments.push(segment(text, kind, pos..end));
            pos = end;
            code_start = end;
        } else {
            pos += text[pos..].chars().next().unwrap().len_utf8();
        }
    }
    if code_start < text.len() {
        segments.push(segment(text, SegmentKind::Code, code_start..text.len()));
    }
    segments
}

fn segment(text: &str, kind: SegmentKind, range: Range<usize>) -> Segment<'_> {
    Segment {
        kind,
        text: &text[range.clone()],
        range,
    }
}

/// 返回从 `pos` 开始的保护区末尾（不含）；位置不在字符边界或不是区域头时返回 None。
pub fn protected_end(text: &str, pos: usize) -> Option<usize> {
    protected_region(text, pos).map(|(_, end)| end)
}

fn protected_region(text: &str, pos: usize) -> Option<(SegmentKind, usize)> {
    if !text.is_char_boundary(pos) {
        return None;
    }
    let bytes = text.as_bytes();
    match bytes.get(pos)? {
        b'"' => {
            let mut cursor = pos + 1;
            while cursor < bytes.len() {
                match bytes[cursor] {
                    b'\\' => {
                        cursor += 1;
                        if cursor < bytes.len() {
                            cursor += text[cursor..].chars().next().unwrap().len_utf8();
                        }
                    }
                    b'"' => return Some((SegmentKind::String, cursor + 1)),
                    _ => cursor += text[cursor..].chars().next().unwrap().len_utf8(),
                }
            }
            Some((SegmentKind::String, text.len()))
        }
        b'/' if bytes.get(pos + 1) == Some(&b'/') => {
            let end = text[pos..]
                .find('\n')
                .map_or(text.len(), |offset| pos + offset);
            Some((SegmentKind::LineComment, end))
        }
        b'/' if bytes.get(pos + 1) == Some(&b'*') => {
            let end = text[pos + 2..]
                .find("*/")
                .map_or(text.len(), |offset| pos + 2 + offset + 2);
            Some((SegmentKind::BlockComment, end))
        }
        b'`' if text[pos..].starts_with("`define")
            && text[pos + 7..]
                .chars()
                .next()
                .is_none_or(char::is_whitespace)
            && text[text[..pos].rfind('\n').map_or(0, |offset| offset + 1)..pos]
                .chars()
                .all(char::is_whitespace) =>
        {
            let mut cursor = pos;
            loop {
                let end = text[cursor..]
                    .find('\n')
                    .map_or(text.len(), |offset| cursor + offset);
                let continued = text[cursor..end].trim_end().ends_with('\\');
                let region_end = if end < text.len() { end + 1 } else { end };
                if !continued || end == text.len() {
                    return Some((SegmentKind::Directive, region_end));
                }
                cursor = region_end;
            }
        }
        b'\\' => {
            let end = text[pos..]
                .find(char::is_whitespace)
                .map_or(text.len(), |offset| pos + offset);
            Some((SegmentKind::EscapedIdentifier, end))
        }
        _ => None,
    }
}

/// 屏蔽非代码字节但保留换行和字节位置，方便对原文安全切片。
pub fn mask_non_code(text: &str) -> String {
    let mut masked = String::with_capacity(text.len());
    for segment in scan(text) {
        if segment.kind == SegmentKind::Code {
            masked.push_str(segment.text);
        } else {
            for byte in segment.text.bytes() {
                masked.push(if byte == b'\n' { '\n' } else { ' ' });
            }
        }
    }
    masked
}

/// 布局识别用等长掩码：字面量/转义标识符为非空白占位，注释/宏不产生伪语句。
/// 保护行首保留斜杠哨兵，既阻止声明匹配，也让尾部注释进入原有 comment 字段。
pub fn mask_for_layout(text: &str) -> String {
    let mut masked = String::with_capacity(text.len());
    for segment in scan(text) {
        if segment.kind == SegmentKind::Code {
            masked.push_str(segment.text);
            continue;
        }
        let placeholder = if matches!(
            segment.kind,
            SegmentKind::String | SegmentKind::EscapedIdentifier
        ) {
            '_'
        } else {
            ' '
        };
        let mut line_start = true;
        let mut first_line = true;
        for byte in segment.text.bytes() {
            if byte == b'\n' {
                masked.push('\n');
                line_start = true;
                first_line = false;
            } else {
                masked.push(if line_start && (placeholder == ' ' || !first_line) {
                    '/'
                } else {
                    placeholder
                });
                line_start = false;
            }
        }
    }
    masked
}

/// 掩码匹配的一个字段；字节位置来自掩码，文字始终来自原文。
#[derive(Debug, Clone, Copy)]
pub struct SourceMatch<'a> {
    source: &'a str,
    start: usize,
    end: usize,
}
impl<'a> SourceMatch<'a> {
    pub fn as_str(&self) -> &'a str {
        &self.source[self.start..self.end]
    }
    pub fn start(&self) -> usize {
        self.start
    }
    pub fn end(&self) -> usize {
        self.end
    }
}

/// 保留掩码 captures 的结构，又确保调用方只能取到原文字段。
#[derive(Debug)]
pub struct SourceCaptures<'source, 'mask> {
    source: &'source str,
    captures: Captures<'mask>,
}
impl<'source> SourceCaptures<'source, '_> {
    pub fn name(&self, name: &str) -> Option<SourceMatch<'source>> {
        self.captures.name(name).map(|field| SourceMatch {
            source: self.source,
            start: field.start(),
            end: field.end(),
        })
    }
    pub fn get(&self, index: usize) -> Option<SourceMatch<'source>> {
        self.captures.get(index).map(|field| SourceMatch {
            source: self.source,
            start: field.start(),
            end: field.end(),
        })
    }
}

/// 对等长掩码识别，字段区间映射至原文；长度或 UTF-8 边界不一致时不匹配。
pub fn captures<'source, 'mask>(
    regex: &Regex,
    source: &'source str,
    masked: &'mask str,
) -> Option<SourceCaptures<'source, 'mask>> {
    if source.len() != masked.len() {
        return None;
    }
    let captures = regex.captures(masked)?;
    if captures
        .iter()
        .flatten()
        .any(|field| source.get(field.range()).is_none())
    {
        return None;
    }
    Some(SourceCaptures { source, captures })
}

/// 布局安全检查使用最长匹配的词法 token；保护区继续复用扫描器的原文区间。
#[derive(Debug, Clone)]
pub struct SyntaxToken<'a> {
    pub kind: SegmentKind,
    pub text: &'a str,
    pub range: Range<usize>,
}

struct SyntaxTokens<'a> {
    source: &'a str,
    position: usize,
    directive_line: bool,
}

/// 仅忽略四种 ASCII 排版字符。数字、完整操作符和宏调用均保持词法边界。
pub fn syntax_tokens(text: &str) -> impl Iterator<Item = SyntaxToken<'_>> {
    SyntaxTokens {
        source: text,
        position: 0,
        directive_line: false,
    }
}

impl<'a> Iterator for SyntaxTokens<'a> {
    type Item = SyntaxToken<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        while matches!(
            self.source.as_bytes().get(self.position),
            Some(b' ' | b'\t' | b'\r' | b'\n')
        ) {
            let start = self.position;
            let newline = matches!(self.source.as_bytes()[start], b'\r' | b'\n');
            self.position += 1;
            if self.source.as_bytes()[start] == b'\r'
                && self.source.as_bytes().get(self.position) == Some(&b'\n')
            {
                self.position += 1;
            }
            if newline && self.directive_line {
                self.directive_line = false;
                if !self.source[self.position..]
                    .trim_matches([' ', '\t', '\r', '\n'])
                    .is_empty()
                {
                    return Some(SyntaxToken {
                        kind: SegmentKind::Directive,
                        text: &self.source[start..self.position],
                        range: start..self.position,
                    });
                }
            }
        }
        let start = self.position;
        if start == self.source.len() {
            return None;
        }
        let (kind, end) = protected_region(self.source, start).unwrap_or_else(|| {
            (
                SegmentKind::Code,
                start + code_token_len(&self.source[start..]),
            )
        });
        self.position = end;
        let text = &self.source[start..end];
        if kind == SegmentKind::Code
            && matches!(
                text,
                "`ifdef"
                    | "`ifndef"
                    | "`elsif"
                    | "`else"
                    | "`endif"
                    | "`include"
                    | "`undef"
                    | "`timescale"
                    | "`default_nettype"
                    | "`resetall"
                    | "`celldefine"
                    | "`endcelldefine"
                    | "`pragma"
                    | "`line"
                    | "`nounconnected_drive"
                    | "`unconnected_drive"
                    | "`begin_keywords"
                    | "`end_keywords"
            )
        {
            self.directive_line = true;
        }
        Some(SyntaxToken {
            kind,
            text,
            range: start..end,
        })
    }
}

fn code_token_len(text: &str) -> usize {
    use std::sync::LazyLock;
    // 操作符最长者在前；based number 内标准允许的空白属于同一个数字 token。
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(concat!(
        r"^(?:",
        r"(?:[0-9][0-9_]*[ \t\r\n]*)?'[ \t\r\n]*[sS]?[bBoOdDhH][ \t\r\n]*[0-9a-fA-F_xXzZ?]+|",
        r"'[01xXzZ]|",
        r"[0-9][0-9_]*(?:\.[0-9_]+(?:[eE][+-]?[0-9_]+)?|[eE][+-]?[0-9_]+)(?:ms|us|ns|ps|fs|s)?|",
        r"`?[\w$]+|",
        r"<<<=|>>>=|===|!==|==\?|!=\?|<<<|>>>|<<=|>>=|&&&|\|->|\|=>|<->|->>|#-#|#=#|",
        r"\*\*|\+\+|--|&&|\|\||->|=>|\*>|##|<<|>>|<=|>=|==|!=|~&|~\||~\^|\^~|",
        r"\+=|-=|\*=|/=|%=|&=|\|=|\^=|::|\.\*|:=|:/|\+:|-:|@@|``|",
        r"(?s:.)",
        r")"
    )).expect("valid SystemVerilog token pattern")
    });
    TOKEN.find(text).expect("nonempty source has a token").end()
}

/// 比较词法事实；注释内部排版无语义，字符串/宏体/转义标识符仍需原文保真。
pub fn same_syntax_token(left: &SyntaxToken<'_>, right: &SyntaxToken<'_>) -> bool {
    if left.kind != right.kind {
        return false;
    }
    match left.kind {
        SegmentKind::Code => left
            .text
            .bytes()
            .filter(|byte| !matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
            .eq(right
                .text
                .bytes()
                .filter(|byte| !matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))),
        SegmentKind::LineComment | SegmentKind::BlockComment => true,
        _ => {
            left.text == right.text
                || normalized_line_endings(left.text) == normalized_line_endings(right.text)
        }
    }
}

fn normalized_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// 不分配 token 列表，避免大文件的安全检查额外放大内存占用。
pub fn preserves_syntax(source: &str, candidate: &str) -> bool {
    let mut before = syntax_tokens(source);
    let mut after = syntax_tokens(candidate);
    loop {
        match (before.next(), after.next()) {
            (None, None) => return true,
            (Some(left), Some(right)) if same_syntax_token(&left, &right) => {}
            _ => return false,
        }
    }
}

fn requires_separator(left: &SyntaxToken<'_>, right: &SyntaxToken<'_>) -> bool {
    let joined = format!("{}{}", left.text, right.text);
    let mut tokens = syntax_tokens(&joined);
    !tokens
        .next()
        .is_some_and(|token| same_syntax_token(left, &token))
        || !tokens
            .next()
            .is_some_and(|token| same_syntax_token(right, &token))
        || tokens.next().is_some()
}

/// 紧凑代码区空白；保留防止 token 合并、注释吞代码和转义标识符延长所需的分隔。
pub fn without_code_whitespace(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut previous: Option<SyntaxToken<'_>> = None;
    for token in syntax_tokens(text) {
        if let Some(left) = &previous {
            if left.range.end < token.range.start && requires_separator(left, &token) {
                output.push(
                    if left.kind == SegmentKind::LineComment || token.kind == SegmentKind::Directive
                    {
                        '\n'
                    } else {
                        ' '
                    },
                );
            }
        }
        output.push_str(token.text);
        previous = Some(token);
    }
    if previous.is_some_and(|token| {
        token.kind == SegmentKind::EscapedIdentifier && token.range.end < text.len()
    }) {
        output.push(' ');
    }
    output
}

/// 只裁剪代码区尾部空白；注释/未闭合字面量内空白以及转义标识符终止空白保留。
pub fn trim_code_end(text: &str) -> &str {
    let segments = scan(text);
    let Some(last) = segments.last() else {
        return text;
    };
    if last.kind != SegmentKind::Code {
        return text;
    }
    let trimmed = last.text.trim_end();
    if trimmed.is_empty()
        && segments
            .iter()
            .rev()
            .nth(1)
            .is_some_and(|segment| segment.kind == SegmentKind::EscapedIdentifier)
    {
        return text;
    }
    &text[..last.range.start + trimmed.len()]
}

/// 找到 `open` 处代码括号的匹配闭合位置；忽略保护区，未闭合/不匹配时返回 None。
pub fn find_matching(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut expected = vec![closing(*bytes.get(open)?)?];
    if !text.is_char_boundary(open) {
        return None;
    }
    let mut pos = open + 1;
    while pos < text.len() {
        if let Some(end) = protected_end(text, pos) {
            pos = end;
            continue;
        }
        if let Some(close) = closing(bytes[pos]) {
            expected.push(close);
        } else if matches!(bytes[pos], b')' | b']' | b'}') {
            if expected.pop() != Some(bytes[pos]) {
                return None;
            }
            if expected.is_empty() {
                return Some(pos);
            }
        }
        pos += text[pos..].chars().next().unwrap().len_utf8();
    }
    None
}

fn closing(byte: u8) -> Option<u8> {
    match byte {
        b'(' => Some(b')'),
        b'[' => Some(b']'),
        b'{' => Some(b'}'),
        _ => None,
    }
}

/// 仅在代码区、三类括号深度为零时切分；保留每片原文及空片段。
pub fn split_top_level(text: &str, separator: char) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut depth = 0usize;
    for segment in scan(text) {
        if segment.kind != SegmentKind::Code {
            continue;
        }
        for (offset, ch) in segment.text.char_indices() {
            if ch == separator && depth == 0 {
                let pos = segment.range.start + offset;
                pieces.push(&text[start..pos]);
                start = pos + ch.len_utf8();
            } else if matches!(ch, '(' | '[' | '{') {
                depth += 1;
            } else if matches!(ch, ')' | ']' | '}') {
                depth = depth.saturating_sub(1);
            }
        }
    }
    pieces.push(&text[start..]);
    pieces
}

/// 查找代码区的字符，返回原文字节位置；
/// `start` 必须是字符边界，找不到时返回 None。
pub fn find_code_char(text: &str, start: usize, ch: char) -> Option<usize> {
    if !text.is_char_boundary(start) {
        return None;
    }
    let masked = mask_non_code(text);
    masked[start..].find(ch).map(|offset| start + offset)
}

/// 跳过空白和注释，返回下一个非 trivia 的原文位置（不存在时返回输入长度）。
pub fn next_code_offset(text: &str, mut pos: usize) -> usize {
    while pos < text.len() {
        if !text.is_char_boundary(pos) {
            return text.len();
        }
        if let Some((SegmentKind::LineComment | SegmentKind::BlockComment, end)) =
            protected_region(text, pos)
        {
            pos = end;
        } else {
            let ch = text[pos..].chars().next().unwrap();
            if !ch.is_whitespace() {
                return pos;
            }
            pos += ch.len_utf8();
        }
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_round_trip_preserves_every_byte() {
        for text in [
            "",
            "module m;\r\n",
            "a = \"中文 \\\" ),\"; // 注释\n/* 多行\n文字 */ \\id,( whitespace",
            "a = \"unterminated 中文",
            "/* 未闭合\n中文",
        ] {
            let segments = scan(text);
            assert_eq!(segments.iter().map(|s| s.text).collect::<String>(), text);
            let mut end = 0;
            for segment in segments {
                assert_eq!(segment.range.start, end);
                assert!(text.is_char_boundary(segment.range.start));
                assert!(text.is_char_boundary(segment.range.end));
                end = segment.range.end;
            }
            assert_eq!(end, text.len());
        }
    }

    #[test]
    fn mask_keeps_offsets_and_newlines() {
        let text = "f(\"中文)\", /* ,\n */ x)";
        let masked = mask_non_code(text);
        assert_eq!(masked.len(), text.len());
        assert_eq!(masked.find('x'), text.find('x'));
        assert_eq!(masked.find('\n'), text.find('\n'));
        assert!(!masked.contains("中文"));
    }

    #[test]
    fn delimiters_ignore_literals_comments_and_escaped_identifiers() {
        let text = "(a, '{1, 2}, f(\"),\\\"\"), /* ) */ \\id), , spaced) remainder";
        let end = find_matching(text, 0).unwrap();
        assert_eq!(&text[end..], ") remainder");
        assert_eq!(split_top_level(&text[1..end], ',').len(), 5);
        assert_eq!(find_matching("(a, \"未闭合)", 0), None);
        assert_eq!(find_matching("(a, /* 未闭合)", 0), None);
    }

    #[test]
    fn split_top_level_preserves_empty_and_nested_parts() {
        assert_eq!(
            split_top_level("a, f(b,c), '{d,e}, [f,g], \"中,文\",", ','),
            vec!["a", " f(b,c)", " '{d,e}", " [f,g]", " \"中,文\"", ""]
        );
    }
}

#[cfg(test)]
mod directive_tests {
    use super::*;

    #[test]
    fn define_continuations_are_one_lossless_region() {
        let text = "`define PAIR(a,b) { \\\n  a, b \\\n}\n`ifdef DEBUG\nlogic x;\n`endif\n";
        let segments = scan(text);
        assert_eq!(
            segments
                .iter()
                .map(|segment| segment.text)
                .collect::<String>(),
            text
        );
        assert_eq!(segments[0].kind, SegmentKind::Directive);
        assert_eq!(segments[0].text, "`define PAIR(a,b) { \\\n  a, b \\\n}\n");
        assert_eq!(segments[1].kind, SegmentKind::Code);
        assert!(segments[1].text.starts_with("`ifdef DEBUG"));
    }

    #[test]
    fn define_inside_literal_comment_or_expression_is_not_a_directive() {
        for text in [
            "\"`define A(x) x\"",
            "// `define A(x) x\n",
            "a = `define(x);",
        ] {
            assert!(scan(text)
                .iter()
                .all(|segment| segment.kind != SegmentKind::Directive));
        }
    }
}

#[cfg(test)]
mod layout_capture_tests {
    use super::*;

    #[test]
    fn captures_map_literal_and_comment_to_utf8_source_ranges() {
        let source = "label = \"中; 文\"; // 保留  注释  ";
        let masked = mask_for_layout(source);
        let regex =
            Regex::new(r"^(?P<name>\w+)\s*=\s*(?P<value>[^;]+);[ \t]*(?P<comment>.*)$").unwrap();
        let found = captures(&regex, source, &masked).unwrap();
        assert_eq!(masked.len(), source.len());
        assert_eq!(found.name("value").unwrap().as_str(), "\"中; 文\"");
        assert_eq!(found.name("comment").unwrap().as_str(), "// 保留  注释  ");
        assert_eq!(found.get(0).unwrap().as_str(), source);
    }

    #[test]
    fn captures_reject_ranges_inside_a_utf8_codepoint() {
        let regex = Regex::new(r"(.)(.*)").unwrap();
        assert!(captures(&regex, "中", "___").is_none());
    }

    #[test]
    fn whitespace_helpers_preserve_protected_text() {
        assert_eq!(
            without_code_whitespace(r#" fn( "a  ] b", \name[0] ) "#),
            r#"fn("a  ] b",\name[0] )"#
        );
        assert_eq!(trim_code_end("a; // trailing  "), "a; // trailing  ");
        assert_eq!(trim_code_end(r"wire \name   "), r"wire \name   ");
        assert_eq!(trim_code_end("a;   "), "a;");
    }
}

#[cfg(test)]
mod syntax_safety_tests {
    use super::*;

    #[test]
    fn syntax_tokens_keep_longest_operators_numbers_and_protected_regions() {
        let source =
            "a === b; x >>>= 1; 1.25e-3 8'hff 8 'h ff `MACRO \"a  b\" \\escaped.id ; // note\n";
        let tokens: Vec<_> = syntax_tokens(source).map(|token| token.text).collect();
        assert_eq!(
            tokens,
            [
                "a",
                "===",
                "b",
                ";",
                "x",
                ">>>=",
                "1",
                ";",
                "1.25e-3",
                "8'hff",
                "8 'h ff",
                "`MACRO",
                "\"a  b\"",
                "\\escaped.id",
                ";",
                "// note"
            ]
        );
    }

    #[test]
    fn syntax_guard_rejects_token_merging_splitting_and_comment_capture() {
        for (source, candidate) in [
            ("8 + +1", "8++1"),
            ("8 - -1", "8--1"),
            ("a === b", "a == = b"),
            ("a >>> b", "a >> > b"),
            ("a & &b", "a &&b"),
            ("a / * b", "a /* b"),
            ("foo bar", "foobar"),
            ("1.25e-3", "1.25e - 3"),
            ("wire \\escaped.id ;", "wire \\escaped.id;"),
            ("// note\nq = 1;", "// note q = 1;"),
            ("\"a  b\"", "\"a b\""),
            ("`define F(x) x\n", "`define F (x) x\n"),
            ("`ifdef X\nlogic a;\n`endif", "`ifdef X logic a;\n`endif"),
        ] {
            assert!(
                !preserves_syntax(source, candidate),
                "{source:?} -> {candidate:?}"
            );
        }
        assert!(preserves_syntax(
            "logic [W - 1 : 0] a; // note  ",
            "logic [W-1:0] a; // note"
        ));
        assert!(preserves_syntax("8 'h ff", "8'hff"));
    }

    #[test]
    fn compaction_keeps_required_separators_and_still_compacts_normal_ranges() {
        for (source, expected) in [
            ("8 + +1 : 0", "8+ +1:0"),
            ("8 - -1 : 0", "8- -1:0"),
            ("W - 1 : 0", "W-1:0"),
            ("a & & b", "a& &b"),
            ("a / * b", "a/ *b"),
            (" foo bar ", "foo bar"),
            ("// note\nq = 1;", "// note\nq=1;"),
            ("wire \\escaped.id ;", "wire\\escaped.id ;"),
        ] {
            let output = without_code_whitespace(source);
            assert_eq!(output, expected);
            assert!(preserves_syntax(source, &output));
        }
    }
}
