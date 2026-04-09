use regex::Regex;

/// Token types produced by the Verilog tokenizer
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    /// A word: identifier, keyword, number (including backtick-prefixed like `ifdef)
    Word(String),
    /// A single non-word, non-whitespace character: (, ), {, }, ;, etc.
    Punct(char),
    /// A run of horizontal whitespace (spaces/tabs)
    Space(String),
    /// A newline character
    Newline,
}

/// Tokenize Verilog/SystemVerilog source text into a stream of tokens.
///
/// This replicates the Python regex:
/// `re.findall(r"`?\w+|[^\w\s]|[ \t]+|\n", txt, flags=re.MULTILINE)`
pub fn tokenize(txt: &str) -> Vec<Token> {
    let re = Regex::new(r"`?\w+|[^\w\s]|[ \t]+|\n").unwrap();
    let mut tokens = Vec::with_capacity(txt.len() / 4);
    for cap in re.find_iter(txt) {
        let s = cap.as_str();
        if s == "\n" {
            tokens.push(Token::Newline);
        } else if s.starts_with(|c: char| c == ' ' || c == '\t') {
            tokens.push(Token::Space(s.to_string()));
        } else if s.len() == 1 && !s.chars().next().unwrap().is_alphanumeric() && s != "_" {
            // Single non-word character
            tokens.push(Token::Punct(s.chars().next().unwrap()));
        } else {
            tokens.push(Token::Word(s.to_string()));
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
        let words: Vec<&str> = tokens
            .iter()
            .map(|t| match t {
                Token::Word(s) => s.as_str(),
                Token::Punct(c) => {
                    let mut buf = [0u8; 4];
                    c.encode_utf8(&mut buf);
                    // safe because single ASCII punct
                    unsafe { std::str::from_utf8_unchecked(&buf[..c.len_utf8()]) }
                }
                Token::Space(s) => s.as_str(),
                Token::Newline => "\n",
            })
            .collect();

        assert!(words.contains(&"module"));
        assert!(words.contains(&"foo"));
        assert!(words.contains(&"input"));
        assert!(words.contains(&"clk"));
    }

    #[test]
    fn test_backtick_token() {
        let txt = "`ifdef DEBUG\n`endif";
        let tokens = tokenize(txt);
        assert!(matches!(&tokens[0], Token::Word(s) if s == "`ifdef"));
        assert!(matches!(&tokens[2], Token::Word(s) if s == "`endif"));
    }
}
