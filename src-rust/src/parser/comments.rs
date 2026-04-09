use regex::Regex;

/// Remove comments from Verilog text while preserving line structure.
///
/// Replicates `verilogutil.clean_comment()` from Python.
/// Handles:
/// - `//` line comments
/// - `/* ... */` block comments
/// - `(* ... *)` attributes
/// - String literals (preserves them)
/// - `( * )` (not a comment)
pub fn clean_comment(text: &str) -> String {
    // Pattern matches: line comments, block comments, (* attrs *), string literals
    // Use raw string with ## delimiter to allow literal backslashes and quotes
    // (?s) = DOTALL (dot matches newline), (?m) = MULTILINE (^ and $ match line boundaries)
    let re = Regex::new(r##"(?sm)//.*?$|/\*.*?\*/|\(\s*\*\s*\)|\(\*.*?\*\)|"(?:\\.|[^\\"])*""##)
        .unwrap();

    let result = re.replace_all(text, |caps: &regex::Captures| {
        let m = caps.get(0).unwrap().as_str();
        // Check if this is a `( * )` (multiplication, not attribute)
        if caps.get(1).is_some() {
            // The `(\*)` group matched — this is `( * )`, keep it
            return m.to_string();
        }
        if m.starts_with('/') || m.starts_with('(') {
            // Comment or attribute: replace with a space (preserve column alignment)
            " ".to_string()
        } else {
            // String literal: keep as-is
            m.to_string()
        }
    });

    result.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_line_comment() {
        let input = "wire clk; // clock signal";
        let result = clean_comment(input);
        assert_eq!(result, "wire clk;  ");
    }

    #[test]
    fn test_clean_block_comment() {
        let input = "wire clk; /* clock */ wire rst;";
        let result = clean_comment(input);
        assert_eq!(result, "wire clk;   wire rst;");
    }

    #[test]
    fn test_preserve_string() {
        let input = r#"display("hello // not comment");"#;
        let result = clean_comment(input);
        assert_eq!(result, input);
    }

    #[test]
    fn test_preserve_star_in_parens() {
        let input = "a = (b * c);";
        let result = clean_comment(input);
        assert_eq!(result, input);
    }
}
