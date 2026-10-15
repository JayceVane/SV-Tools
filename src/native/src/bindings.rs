//! napi-rs host 适配；格式化核心不处理 JavaScript 运行时。
use crate::{analyzer, codegen, config::*, parser};
use napi::bindgen_prelude::*;
use napi::{Env, JsString};
use napi_derive::napi;

/// Format Verilog/SystemVerilog text.
#[napi]
pub fn format_text(env: Env, text: JsString, options: FormatOptions) -> Result<JsString> {
    layout_js_string(env, text, |source| {
        crate::format_with_protect_passthrough(source, &options)
    })
}

/// 两个布局入口共用 UTF-16 边界，代码生成命令仍保留各自的改写语义。
fn layout_js_string(
    env: Env,
    text: JsString,
    layout: impl FnOnce(&str) -> String,
) -> Result<JsString> {
    // 先严格读取 UTF-16；String 入参会将孤立代理项替换成 U+FFFD，事后无法追回原文。
    let original = text.into_utf16()?;
    let source = match original.as_str() {
        Ok(source) => source,
        Err(_) => {
            eprintln!("[svtools] Invalid UTF-16; original text preserved.");
            return Ok(original.into_value());
        }
    };
    env.create_string(&layout(&source))
}

/// Generate module instantiation code.
#[napi]
pub fn generate_module_inst(text: String, options: GadgetOptions) -> Result<ModuleInstResult> {
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
pub fn generate_testbench(text: String, options: GadgetOptions) -> Result<TestbenchResult> {
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
pub fn repeat_code(template: String, options: RepeatOptions) -> Result<String> {
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
pub fn align_code(env: Env, text: JsString, tab_size: u32) -> Result<JsString> {
    layout_js_string(env, text, |source| {
        codegen::align_code::align_code(source, tab_size)
    })
}

/// Generate file header from template.
#[napi]
pub fn generate_header(template: String, file_name: String, tab_size: u32) -> Result<String> {
    Ok(codegen::header::generate_header_template(
        &template, &file_name, tab_size,
    ))
}

/// Extract all symbols from SystemVerilog source (for Outline / DocumentSymbol).
#[napi]
pub fn extract_symbols(text: String) -> Result<analyzer::ParseResult> {
    Ok(analyzer::extract_symbols(&text))
}

/// Find symbols by name (for hover / goto definition).
#[napi]
pub fn find_symbol_by_name(text: String, name: String) -> Result<Vec<analyzer::SvSymbol>> {
    Ok(analyzer::find_symbol_by_name(&text, &name))
}
