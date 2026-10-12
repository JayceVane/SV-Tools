pub mod align;
pub mod analyzer;
pub mod beautifier;
pub mod blank_rules;
pub mod codegen;
pub mod config;
pub mod formatter;
pub mod parser;
#[cfg_attr(
    not(test),
    deprecated(
        since = "4.0.0",
        note = "Legacy empty-line utility; formatter uses blank_rules"
    )
)]
pub mod postprocess;
pub mod preprocess;
pub mod source_scan;
pub mod tokenizer;

// host 绑定由 napi 注册，Rust 单测不会直接调用这些入口。
#[cfg_attr(test, allow(dead_code))]
mod bindings;
use config::FormatOptions;

/// 完整格式化：`` `pragma protect `` 加密区原样透传（BASE64 行长是编码
/// 规范的一部分，重排会破坏解密；且长载荷会使对齐器二次方变慢），
/// 其余普通代码段独立格式化后按原顺序拼接。
pub fn format_with_protect_passthrough(text: &str, options: &FormatOptions) -> String {
    // 行尾归一须先于加密区切分：CRLF 的 \r 会让段间空行判定失效
    // （`\r\n` 行被视为非空内容，段边界空行被丢弃）
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let segments = preprocess::split_protected_regions(&text);
    if segments.is_empty() {
        return String::new();
    }
    if segments.len() == 1 {
        return match segments.into_iter().next().unwrap() {
            preprocess::ProtectSegment::Code(s) => format_code_segment(&s, options),
            preprocess::ProtectSegment::Protected(s) => s,
        };
    }
    let mut out = String::with_capacity(text.len());
    let n = segments.len();
    for (i, seg) in segments.into_iter().enumerate() {
        match seg {
            preprocess::ProtectSegment::Protected(s) => out.push_str(&s),
            preprocess::ProtectSegment::Code(s) => {
                // 段边界镜像用户的空行分隔：原有 ≥1 空行则保留恰好 1 行，
                // 原没有就不加（§6 不增空行原则）
                let lead_blank = i > 0 && s.starts_with('\n');
                let trail_blank = i + 1 < n && s.trim_end_matches('\n').len() + 2 <= s.len();
                let f = format_code_segment(&s, options);
                // 段首空行由拼接层统一裁决（格式化结果不保留前导换行）
                let f_body = f.trim_start_matches('\n');
                if i + 1 == n {
                    if lead_blank {
                        out.push('\n');
                    }
                    out.push_str(f_body);
                } else {
                    let f_trim = f_body.trim_end();
                    if !f_trim.is_empty() {
                        if lead_blank {
                            out.push('\n');
                        }
                        out.push_str(f_trim);
                        out.push('\n');
                        if trail_blank {
                            out.push('\n');
                        }
                    }
                }
            }
        }
    }
    out
}

/// 格式化单个普通代码段（不含加密区）。
pub fn format_code_segment(text: &str, options: &FormatOptions) -> String {
    let indent_style = options.indent_style().to_string();

    // Preprocess: merge standalone 'begin' for 1tbs style
    let preprocessed = preprocess::preprocess_text(text, &indent_style, options.inline_compact());

    // Core formatting
    let mut beautifier = beautifier::VerilogBeautifier::new(options.clone());
    let formatted = beautifier.beautify_text(&preprocessed);

    // Postprocess: 空行规则 pass（spec §6，替代单纯折叠）
    let max_empty = options.max_consecutive_empty_lines();
    blank_rules::normalize_blank_lines(&formatted, max_empty, options.blank_compact())
}
