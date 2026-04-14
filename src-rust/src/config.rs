use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Format Options ──────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormatOptions {
    pub nb_space: Option<u32>,
    pub use_tab: Option<bool>,
    pub one_bind_per_line: Option<bool>,
    pub one_decl_per_line: Option<bool>,
    pub param_one_line: Option<bool>,
    pub indent_style: Option<String>,
    pub reindent_only: Option<bool>,
    pub strip_empty_line: Option<bool>,
    pub inst_align_port: Option<bool>,
    pub ignore_tick: Option<bool>,
    pub import_same_line: Option<bool>,
    pub align_comma: Option<bool>,
    pub max_consecutive_empty_lines: Option<i32>,
}

impl Default for FormatOptions {
    fn default() -> Self {
        Self {
            nb_space: Some(4),
            use_tab: Some(false),
            one_bind_per_line: Some(true),
            one_decl_per_line: Some(false),
            param_one_line: Some(true),
            indent_style: Some("1tbs".into()),
            reindent_only: Some(false),
            strip_empty_line: Some(true),
            inst_align_port: Some(true),
            ignore_tick: Some(true),
            import_same_line: Some(false),
            align_comma: Some(true),
            max_consecutive_empty_lines: Some(1),
        }
    }
}

impl FormatOptions {
    pub fn nb_space(&self) -> usize {
        self.nb_space.unwrap_or(4) as usize
    }
    pub fn use_tab(&self) -> bool {
        self.use_tab.unwrap_or(false)
    }
    pub fn one_bind_per_line(&self) -> bool {
        self.one_bind_per_line.unwrap_or(true)
    }
    pub fn one_decl_per_line(&self) -> bool {
        self.one_decl_per_line.unwrap_or(false)
    }
    pub fn param_one_line(&self) -> bool {
        self.param_one_line.unwrap_or(true)
    }
    pub fn indent_style(&self) -> &str {
        self.indent_style.as_deref().unwrap_or("1tbs")
    }
    pub fn reindent_only(&self) -> bool {
        self.reindent_only.unwrap_or(false)
    }
    pub fn strip_empty_line(&self) -> bool {
        self.strip_empty_line.unwrap_or(true)
    }
    pub fn inst_align_port(&self) -> bool {
        self.inst_align_port.unwrap_or(true)
    }
    pub fn ignore_tick(&self) -> bool {
        self.ignore_tick.unwrap_or(true)
    }
    pub fn import_same_line(&self) -> bool {
        self.import_same_line.unwrap_or(false)
    }
    pub fn align_comma(&self) -> bool {
        self.align_comma.unwrap_or(true)
    }
    pub fn max_consecutive_empty_lines(&self) -> i32 {
        self.max_consecutive_empty_lines.unwrap_or(1)
    }
}

// ── Gadget Options ──────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GadgetOptions {
    pub inst_prefix: Option<String>,
    pub reset: Option<Vec<String>>,
    pub sreset: Option<Vec<String>>,
    pub clock: Option<Vec<String>>,
    pub wave_type: Option<String>,
    pub task_init: Option<bool>,
    pub task_drive: Option<bool>,
    pub include_declarations: Option<bool>,
}

impl Default for GadgetOptions {
    fn default() -> Self {
        Self {
            inst_prefix: Some("u_".into()),
            reset: Some(vec!["rst_n".into(), "reset_n".into()]),
            sreset: Some(vec!["sreset".into(), "srst".into()]),
            clock: Some(vec!["clk".into(), "uclk".into(), "cclk".into()]),
            wave_type: Some("fsdb".into()),
            task_init: Some(true),
            task_drive: Some(true),
            include_declarations: Some(true),
        }
    }
}

impl GadgetOptions {
    pub fn inst_prefix(&self) -> &str {
        self.inst_prefix.as_deref().unwrap_or("u_")
    }
    pub fn reset(&self) -> &[String] {
        self.reset.as_deref().unwrap_or(&[])
    }
    pub fn sreset(&self) -> &[String] {
        self.sreset.as_deref().unwrap_or(&[])
    }
    pub fn clock(&self) -> &[String] {
        self.clock.as_deref().unwrap_or(&[])
    }
    pub fn wave_type(&self) -> &str {
        self.wave_type.as_deref().unwrap_or("fsdb")
    }
    pub fn task_init(&self) -> bool {
        self.task_init.unwrap_or(true)
    }
    pub fn task_drive(&self) -> bool {
        self.task_drive.unwrap_or(true)
    }
    pub fn include_declarations(&self) -> bool {
        self.include_declarations.unwrap_or(true)
    }
}

// ── Repeat Options ──────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepeatOptions {
    pub start: Option<i32>,
    pub end: Option<i32>,
    pub row_step: Option<i32>,
    pub col_step: Option<i32>,
    pub clipboard_lines: Option<Vec<String>>,
}

impl RepeatOptions {
    pub fn start(&self) -> i32 {
        self.start.unwrap_or(0)
    }
    pub fn end(&self) -> i32 {
        self.end.unwrap_or(10)
    }
    pub fn row_step(&self) -> i32 {
        self.row_step.unwrap_or(1)
    }
    pub fn col_step(&self) -> i32 {
        self.col_step.unwrap_or(0)
    }
    pub fn clipboard_lines(&self) -> &[String] {
        self.clipboard_lines.as_deref().unwrap_or(&[])
    }
}

// ── Result Types ────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleInstResult {
    pub success: bool,
    pub result: Option<String>,
    pub module: Option<String>,
    pub error: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestbenchResult {
    pub success: bool,
    pub result: Option<String>,
    pub module: Option<String>,
    pub error: Option<String>,
}
