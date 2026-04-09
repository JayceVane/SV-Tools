mod align;
mod beautifier;
mod codegen;
mod config;
mod parser;
mod postprocess;
mod preprocess;
mod tokenizer;

use config::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Format Verilog/SystemVerilog text.
#[napi]
fn format_text(text: String, options: FormatOptions) -> Result<String> {
    let indent_style = options.indent_style().to_string();

    // Preprocess: merge standalone 'begin' for 1tbs style
    let preprocessed = preprocess::preprocess_text(&text, &indent_style);

    // Core formatting
    let mut beautifier = beautifier::VerilogBeautifier::new(options.clone());
    let formatted = beautifier.beautify_text(&preprocessed);

    // Postprocess: control empty lines
    let max_empty = options.max_consecutive_empty_lines();
    let result = postprocess::postprocess_text(&formatted, max_empty);

    Ok(result)
}

/// Generate module instantiation code.
#[napi]
fn generate_module_inst(text: String, options: GadgetOptions) -> Result<ModuleInstResult> {
    let cleaned = crate::parser::comments::clean_comment(&text);
    let normalized = crate::codegen::align_code::normalize_for_parsing(&cleaned);

    // Debug: print normalized text (first 200 chars)
    eprintln!(
        "DEBUG normalized (first 200): {}",
        &normalized.chars().take(200).collect::<String>()
    );

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
