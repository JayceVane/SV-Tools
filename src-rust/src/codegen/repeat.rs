use regex::Regex;

/// Repeat code template with number formatting.
/// Replicates Python `vg_core.repeat_code_with_numbers()`.
pub fn repeat_code_with_numbers(
    template: &str,
    start: i32,
    end: i32,
    row_step: i32,
    col_step: i32,
    clipboard_lines: &[String],
) -> Result<String, String> {
    let (effective_end, rsp_n, csp_n) = if start <= end {
        (end + 1, row_step, col_step)
    } else {
        (end - 1, -row_step, col_step)
    };

    let range_len = if rsp_n != 0 {
        ((effective_end - start) / rsp_n).abs() as usize
    } else {
        0
    };

    if range_len < 1 {
        return Err("Invalid range".to_string());
    }

    let has_cb = template.contains("{cb}");
    let tup_n = count_placeholders(template);

    let mut result = String::new();
    let mut cidx = 0;

    let mut i = start;
    let mut iter_count = 0;
    while if rsp_n > 0 {
        i < effective_end
    } else {
        i > effective_end
    } {
        let r_txt = if has_cb {
            if (cidx as usize) < clipboard_lines.len() {
                let replaced = template.replace("{cb}", &clipboard_lines[cidx]);
                cidx += 1;
                replaced
            } else {
                let last = clipboard_lines.last().cloned().unwrap_or_default();
                template.replace("{cb}", &last)
            }
        } else {
            template.to_string()
        };

        let mut prm_l: Vec<i32> = Vec::new();
        for j in 0..tup_n {
            prm_l.push(i + j as i32 * csp_n);
        }

        match format_template(&r_txt, &prm_l) {
            Ok(formatted) => {
                if !result.is_empty() {
                    result.push('\n');
                }
                result.push_str(&formatted);
            }
            Err(_) => {
                // Try with extended params
                let ext: Vec<i32> = (0..tup_n)
                    .map(|k| if k < prm_l.len() { prm_l[k] } else { i })
                    .collect();
                if let Ok(formatted) = format_template(&r_txt, &ext) {
                    if !result.is_empty() {
                        result.push('\n');
                    }
                    result.push_str(&formatted);
                }
            }
        }

        i += rsp_n;
        iter_count += 1;
        if iter_count > 100000 {
            return Err("Range too large".to_string());
        }
    }

    Ok(result)
}

fn count_placeholders(template: &str) -> usize {
    // Count {} style placeholders
    let empty = Regex::new(r"\{\}").unwrap().find_iter(template).count();
    if empty > 0 {
        return empty;
    }
    // Count explicit format specs like {0:d}, {:03x}, etc.
    Regex::new(r"\{[^}]*\}")
        .unwrap()
        .find_iter(template)
        .count()
}

fn format_template(template: &str, params: &[i32]) -> Result<String, String> {
    let mut result = template.to_string();

    // Replace numbered or positional placeholders with values
    let re = Regex::new(r"\{(\d*)(?::([^}]*))?\}").unwrap();
    let mut offset = 0;

    let matches: Vec<_> = re.captures_iter(template).collect();
    if matches.is_empty() {
        // Try simple {} placeholders
        let simple_re = Regex::new(r"\{\}").unwrap();
        let mut idx = 0;
        result = simple_re
            .replace_all(template, |_: &regex::Captures| {
                let val = params.get(idx).unwrap_or(&0);
                idx += 1;
                val.to_string()
            })
            .to_string();
    } else {
        result = re
            .replace_all(template, |caps: &regex::Captures| {
                let idx_str = caps.get(1).unwrap().as_str();
                let _fmt = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let idx: usize = if idx_str.is_empty() {
                    0
                } else {
                    idx_str.parse().unwrap_or(0)
                };
                params.get(idx).unwrap_or(&0).to_string()
            })
            .to_string();
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_repeat_simple() {
        let result = repeat_code_with_numbers("wire data_{:d};", 0, 3, 1, 0, &[]).unwrap();
        assert!(result.contains("wire data_0;"));
        assert!(result.contains("wire data_3;"));
    }
}
