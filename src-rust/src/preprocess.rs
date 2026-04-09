use regex::Regex;

/// Preprocess text: if using 1tbs style, merge standalone 'begin' to previous line.
///
/// This replicates `FormatterDaemon::preprocess_text` from daemon.py.
pub fn preprocess_text(text: &str, indent_style: &str) -> String {
    if indent_style != "1tbs" {
        return text.to_string();
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
}
