/// Postprocess text: control the number of consecutive empty lines.
///
/// This replicates `FormatterDaemon::postprocess_text` from daemon.py.
pub fn postprocess_text(text: &str, max_empty_lines: i32) -> String {
    if max_empty_lines < 0 {
        return text.to_string();
    }

    let max_empty = max_empty_lines as usize;
    let lines: Vec<&str> = text.split('\n').collect();
    let mut processed = Vec::with_capacity(lines.len());
    let mut empty_count: usize = 0;

    for line in lines {
        if line.trim().is_empty() {
            empty_count += 1;
            if empty_count <= max_empty {
                processed.push(line);
            }
        } else {
            empty_count = 0;
            processed.push(line);
        }
    }

    processed.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_postprocess_limit_empty_lines() {
        let input = "line1\n\n\n\nline2";
        let result = postprocess_text(input, 1);
        assert_eq!(result, "line1\n\nline2");
    }

    #[test]
    fn test_postprocess_remove_all() {
        let input = "line1\n\n\n\nline2";
        let result = postprocess_text(input, 0);
        assert_eq!(result, "line1\nline2");
    }

    #[test]
    fn test_postprocess_keep_all() {
        let input = "line1\n\n\n\nline2";
        let result = postprocess_text(input, -1);
        assert_eq!(result, input);
    }
}
