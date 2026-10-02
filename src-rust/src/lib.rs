pub mod align;
pub mod analyzer;
pub mod beautifier;
pub mod blank_rules;
pub mod codegen;
pub mod config;
pub mod parser;
pub mod postprocess;
pub mod preprocess;
pub mod tokenizer;

use config::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Format Verilog/SystemVerilog text.
#[napi]
fn format_text(text: String, options: FormatOptions) -> Result<String> {
    Ok(format_with_protect_passthrough(&text, &options))
}

/// 完整格式化：`` `pragma protect `` 加密区原样透传（BASE64 行长是编码
/// 规范的一部分，重排会破坏解密；且长载荷会使对齐器二次方变慢），
/// 其余普通代码段独立格式化后按原顺序拼接。
pub fn format_with_protect_passthrough(text: &str, options: &FormatOptions) -> String {
    let segments = preprocess::split_protected_regions(text);
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

/// Generate module instantiation code.
#[napi]
fn generate_module_inst(text: String, options: GadgetOptions) -> Result<ModuleInstResult> {
    let cleaned = crate::parser::comments::clean_comment(&text);
    let normalized = crate::codegen::align_code::normalize_for_parsing(&cleaned);

    match parser::module::parse_module(&normalized, &options) {
        Some(info) => {
            let port_decls = if options.include_declarations() {
                let decls = codegen::module_inst::generate_port_declarations_only(&info);
                if !decls.is_empty() {
                    format!("\n// Signal declarations\n{}\n", decls)
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            let inst = codegen::module_inst::build_instance_code(&info, options.inst_prefix());
            let result = format!("{}\n{}", port_decls, inst);

            Ok(ModuleInstResult {
                success: true,
                result: Some(result),
                module: Some(info.name.clone()),
                error: None,
            })
        }
        None => Ok(ModuleInstResult {
            success: false,
            result: None,
            module: None,
            error: Some("Failed to find module definition".to_string()),
        }),
    }
}

/// Generate testbench code.
#[napi]
fn generate_testbench(text: String, options: GadgetOptions) -> Result<TestbenchResult> {
    let cleaned = crate::parser::comments::clean_comment(&text);
    let normalized = crate::codegen::align_code::normalize_for_parsing(&cleaned);

    match parser::module::parse_module(&normalized, &options) {
        Some(info) => {
            let tb = codegen::testbench::generate_testbench(&info, &options);
            Ok(TestbenchResult {
                success: true,
                result: Some(tb),
                module: Some(info.name.clone()),
                error: None,
            })
        }
        None => Ok(TestbenchResult {
            success: false,
            result: None,
            module: None,
            error: Some("Failed to find module definition".to_string()),
        }),
    }
}

/// Repeat code with number formatting.
#[napi]
fn repeat_code(template: String, options: RepeatOptions) -> Result<String> {
    codegen::repeat::repeat_code_with_numbers(
        &template,
        options.start(),
        options.end(),
        options.row_step(),
        options.col_step(),
        options.clipboard_lines(),
    )
    .map_err(|e| Error::from_reason(e))
}

/// Align selected Verilog code.
#[napi]
fn align_code(text: String, tab_size: u32) -> Result<String> {
    Ok(codegen::align_code::align_code(&text, tab_size))
}

/// Generate file header from template.
#[napi]
fn generate_header(template: String, file_name: String, tab_size: u32) -> Result<String> {
    Ok(codegen::header::generate_header_template(
        &template, &file_name, tab_size,
    ))
}

/// Extract all symbols from SystemVerilog source (for Outline / DocumentSymbol).
#[napi]
fn extract_symbols(text: String) -> Result<analyzer::ParseResult> {
    Ok(analyzer::extract_symbols(&text))
}

/// Find symbols by name (for hover / goto definition).
#[napi]
fn find_symbol_by_name(text: String, name: String) -> Result<Vec<analyzer::SvSymbol>> {
    Ok(analyzer::find_symbol_by_name(&text, &name))
}
