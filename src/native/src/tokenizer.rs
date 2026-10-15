use regex::Regex;
use std::sync::LazyLock;

use crate::source_scan::{self, SegmentKind};

/// Token types produced by the Verilog tokenizer
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    /// 完整保护区；格式化器直接写回原文，不参与结构识别。
    Protected { kind: SegmentKind, text: String },
    /// A word: identifier, keyword, number (including backtick-prefixed like `ifdef)
    Word(String),
    /// A single non-word, non-whitespace character: (, ), {, }, ;, etc.
    Punct(char),
    /// 换行以外的连续空白；原文保留，保证完整往返
    Space(String),
    /// A newline character
    Newline,
}

/// Tokenize Verilog/SystemVerilog source text into a stream of tokens.
///
/// 代码区保留 Word/Punct/Space/Newline 分类，保护区独立成 Token，拼接完整还原原文。
pub fn tokenize(txt: &str) -> Vec<Token> {
    static TOKEN_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"`?\w+|[^\w\s]|[^\S\n]+|\n").unwrap());
    let mut tokens = Vec::with_capacity(txt.len() / 4);
    for segment in source_scan::scan(txt) {
        if segment.kind != SegmentKind::Code {
            tokens.push(Token::Protected {
                kind: segment.kind,
                text: segment.text.to_string(),
            });
            continue;
        }
        for cap in TOKEN_RE.find_iter(segment.text) {
            let s = cap.as_str();
            if s == "\n" {
                tokens.push(Token::Newline);
            } else if s.starts_with(char::is_whitespace) {
                tokens.push(Token::Space(s.to_string()));
            } else if s.chars().count() == 1
                && !s.chars().next().unwrap().is_alphanumeric()
                && s != "_"
            {
                // Single non-word character
                tokens.push(Token::Punct(s.chars().next().unwrap()));
            } else {
                tokens.push(Token::Word(s.to_string()));
            }
        }
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_tokenize() {
        let txt = "module foo (\n\tinput clk\n);";
        let tokens = tokenize(txt);
        let words: Vec<String> = tokens
            .iter()
            .map(|t| match t {
                Token::Word(s) | Token::Protected { text: s, .. } => s.clone(),
                Token::Punct(c) => {
                    let mut buf = [0u8; 4];
                    c.encode_utf8(&mut buf);
                    std::str::from_utf8(&buf[..c.len_utf8()])
                        .unwrap()
                        .to_string()
                }
                Token::Space(s) => s.clone(),
                Token::Newline => "\n".to_string(),
            })
            .collect();

        assert!(words.contains(&"module".to_string()));
        assert!(words.contains(&"foo".to_string()));
        assert!(words.contains(&"input".to_string()));
        assert!(words.contains(&"clk".to_string()));
    }

    #[test]
    fn test_backtick_token() {
        let txt = "`ifdef DEBUG\n`endif";
        let tokens = tokenize(txt);
        // 序列：[Word("`ifdef"), Space, Word("DEBUG"), Newline, Word("`endif")]
        assert!(matches!(&tokens[0], Token::Word(s) if s == "`ifdef"));
        assert!(matches!(&tokens[2], Token::Word(s) if s == "DEBUG"));
        assert!(matches!(&tokens[3], Token::Newline));
        assert!(matches!(&tokens[4], Token::Word(s) if s == "`endif"));
    }
}

#[cfg(test)]
mod lossless_tests {
    use super::*;

    #[test]
    fn tokens_round_trip_all_input_characters() {
        let text =
            "module 中文;\r\n\t$display(\"文字 \\\"\"); // 内容\n\u{a0}\u{b}\u{c}\\escaped.id ;。";
        let restored = tokenize(text)
            .iter()
            .map(|token| match token {
                Token::Word(text) | Token::Space(text) | Token::Protected { text, .. } => {
                    text.clone()
                }
                Token::Punct(ch) => ch.to_string(),
                Token::Newline => "\n".to_string(),
            })
            .collect::<String>();
        assert_eq!(restored, text);
    }
}

#[cfg(test)]
mod protected_token_tests {
    use super::*;

    #[test]
    fn lexical_regions_are_atomic_events() {
        let text = "a = \"中文 ) ;\"; /* 多行\n 注释 */ \\id,( ";
        let regions: Vec<_> = tokenize(text)
            .into_iter()
            .filter_map(|token| match token {
                Token::Protected { kind, text } => Some((kind, text)),
                _ => None,
            })
            .collect();
        assert_eq!(
            regions,
            vec![
                (SegmentKind::String, "\"中文 ) ;\"".to_string()),
                (SegmentKind::BlockComment, "/* 多行\n 注释 */".to_string()),
                (SegmentKind::EscapedIdentifier, "\\id,(".to_string()),
            ]
        );
    }
}
