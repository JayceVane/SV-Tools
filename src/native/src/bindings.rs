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
    match parser::module::parse_module_checked(&cleaned, &options) {
        Ok(info) => {
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
        Err(error) => Ok(ModuleInstResult {
            success: false,
            result: None,
            module: None,
            error: Some(error),
        }),
    }
}

/// Generate testbench code.
#[napi]
pub fn generate_testbench(text: String, options: GadgetOptions) -> Result<TestbenchResult> {
    let cleaned = crate::parser::comments::clean_comment(&text);
    match parser::module::parse_module_checked(&cleaned, &options) {
        Ok(info) => {
            let tb = codegen::testbench::generate_testbench(&info, &options);
            Ok(TestbenchResult {
                success: true,
                result: Some(tb),
                module: Some(info.name.clone()),
                error: None,
            })
        }
        Err(error) => Ok(TestbenchResult {
            success: false,
            result: None,
            module: None,
            error: Some(error),
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

// ── 波形查询（VCD/FST 统一，按需加载信号）────────────────────────

use crate::wave;

// 查询级资源上限（与旧 JS VcdStore 的口径一致）。
// 这些护栏在「后端下沉」时一度全部丢失：宽总线或稠密信号可以在一次查询里
// 物化出上百 MB 的位串，把宿主内存吃穿。上限必须在**取数之前**判定，
// 不能等构造完响应再检查。
const MAX_QUERY_IDS: usize = 256;
const MAX_QUERY_PIXELS: u32 = 4096;
const MAX_QUERY_POINTS: usize = 262_144;
const MAX_RESULT_BYTES: usize = 32 * 1024 * 1024;
const MAX_SAMPLES: u32 = 4096;

/// ids 数量上限检查。
fn check_ids(count: usize) -> Result<()> {
    if count > MAX_QUERY_IDS {
        return Err(Error::from_reason(format!(
            "[VCD_RESOURCE_LIMIT] 查询 ids 必须为最多 {MAX_QUERY_IDS} 个信号"
        )));
    }
    Ok(())
}

/// 序列化前检查响应体积：超预算直接拒绝，而不是把巨型 JSON 交给 JS。
fn check_payload(text: String) -> Result<String> {
    if text.len() > MAX_RESULT_BYTES {
        return Err(Error::from_reason(format!(
            "[VCD_RESOURCE_LIMIT] 查询响应超过 {} MiB 预算，请减少信号或缩小窗口",
            MAX_RESULT_BYTES / 1048576
        )));
    }
    Ok(text)
}

/// 打开波形：只读层级元数据，不加载信号值。
#[napi]
pub fn wave_open(file: String) -> Result<String> {
    let trace = wave::open(std::path::Path::new(&file)).map_err(wave_error)?;
    serde_json::to_string(&trace.snapshot())
        .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
}

/// 打开波形并**登记为可复用会话**，返回 `{ handle, meta }`。
///
/// 与 `wave_open` 的区别：句柄让后续查询复用这一次解析（见 `wave/session.rs`）。
/// `wave_open` 保留给只读一次元数据、不做后续查询的场景。
#[napi]
pub fn wave_session_open(file: String) -> Result<String> {
    let session = wave::WaveSession::open(std::path::Path::new(&file)).map_err(wave_error)?;
    let meta = session.trace.snapshot();
    let handle = wave::session::insert(session);
    serde_json::to_string(&serde_json::json!({ "handle": handle, "meta": meta }))
        .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
}

/// 异步版的 `wave_session_open`：解析在 libuv 线程池执行，不阻塞 JS 事件循环。
pub struct WaveSessionOpenTask {
    file: String,
}

impl napi::Task for WaveSessionOpenTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        wave_session_open(self.file.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<string>")]
pub fn wave_session_open_async(file: String) -> AsyncTask<WaveSessionOpenTask> {
    AsyncTask::new(WaveSessionOpenTask { file })
}

/// 释放会话句柄。幂等：重复关闭返回 false 而不是报错。
#[napi]
pub fn wave_session_close(handle: i64) -> bool {
    if handle < 0 {
        return false;
    }
    wave::session::remove(handle as u64)
}

/// 当前活跃会话数（诊断用）。
#[napi]
pub fn wave_session_count() -> u32 {
    wave::session::active_count() as u32
}

/// 按句柄取出会话并执行查询；句柄无效时给出可诊断错误而不是静默失败。
fn with_session<T>(
    handle: i64,
    task: impl FnOnce(&mut wave::WaveSession) -> Result<T>,
) -> Result<T> {
    if handle < 0 {
        return Err(Error::from_reason("[INVALID_ARGUMENT] 会话句柄无效"));
    }
    let shared = wave::session::get(handle as u64)
        .ok_or_else(|| Error::from_reason("[SESSION_CLOSED] 波形会话已关闭，请重新打开"))?;
    let mut guard = shared
        .lock()
        .map_err(|_| Error::from_reason("[SESSION_CLOSED] 波形会话状态损坏，请重新打开"))?;
    task(&mut guard)
}

/// 查询入口的会话来源：**给了 handle 就复用它，否则按 file 新开一次**。
///
/// 两种用法共用同一段实现体，避免每个查询写两遍（那样最容易在修一处时漏另一处）：
/// - 给了 handle：不解析文件，直接锁住已登记的会话；
/// - 只给 file：临时开一个（CLI 单次命令的路径），用完释放。
#[derive(Clone)]
enum SessionSource {
    Handle(i64),
    File(String),
}

impl SessionSource {
    /// 句柄优先；两者都没有时报参数错误。
    fn from(handle: Option<i64>, file: Option<String>) -> Result<Self> {
        match (handle, file) {
            (Some(handle), _) => Ok(Self::Handle(handle)),
            (None, Some(file)) => Ok(Self::File(file)),
            (None, None) => Err(Error::from_reason(
                "[INVALID_ARGUMENT] 需要 file 或 handle 之一",
            )),
        }
    }

    /// 在会话上执行一段查询。
    fn run<T>(&self, task: impl FnOnce(&mut wave::WaveSession) -> Result<T>) -> Result<T> {
        match self {
            Self::Handle(handle) => with_session(*handle, task),
            Self::File(file) => {
                let mut session =
                    wave::WaveSession::open(std::path::Path::new(file)).map_err(wave_error)?;
                task(&mut session)
            }
        }
    }
}

/// `wave_open` 的异步版本：解析在 libuv 线程池执行，不阻塞 JS 事件循环。
///
/// 必须提供异步入口的原因：webview 的 worker 用 `worker.terminate()` 取消加载，
/// 而同步 napi 调用占着 worker 线程时，V8 会把整个 isolate 拆掉，Rust 侧的析构函数
/// 随后在已销毁的上下文里运行——实测在并发测试下稳定段错误（0xC0000005）。
/// 走 `Task` 后 compute 阶段不碰 JS，terminate 只会丢弃结果，不会撕裂隔离区。
pub struct WaveOpenTask {
    file: String,
}

impl napi::Task for WaveOpenTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let path = std::path::Path::new(&self.file);
        let trace = wave::open(path).map_err(wave_error)?;
        serde_json::to_string(&trace.snapshot())
            .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// 异步打开波形，返回 Promise<JSON 字符串>。
#[napi(ts_return_type = "Promise<string>")]
pub fn wave_open_async(file: String) -> AsyncTask<WaveOpenTask> {
    AsyncTask::new(WaveOpenTask { file })
}


/// 按信号名解析并返回值（逗号分隔多个信号）；时间单位为 tick 或带 s/ns 等单位。
///
/// `handle` 有值时复用已打开的会话（不重新解析）；否则按 `file` 临时开一个。
/// 二选一，两者都给时以 handle 为准。
#[napi]
pub fn wave_values(
    handle: Option<i64>,
    file: Option<String>,
    signals: String,
    at: String,
) -> Result<String> {
    SessionSource::from(handle, file)?.run(|session| values_impl(session, &signals, &at))
}

fn values_impl(session: &mut wave::WaveSession, signals: &str, at: &str) -> Result<String> {
    let at = at.to_string();
    let signals = signals.to_string();
    let scale = wave::seconds_per_tick(&session.trace.timescale);
    let time = wave::parse_tick(&at, scale)
        .ok_or_else(|| Error::from_reason(format!("--at 时间格式无效：{}", at)))?;
    if time > session.trace.end_time {
        return Err(Error::from_reason(format!(
            "--at 超出记录范围：{} > {}",
            time, session.trace.end_time
        )));
    }
    let names: Vec<String> = signals
        .split(',')
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    check_ids(names.len())?;
    let name_refs: Vec<&str> = names.iter().map(|name| name.as_str()).collect();
    // 解析结果借用 trace.vars；按 **id** 回查（不能按 path：逐位展开后
    // 隐藏源条目与原向量同 path，按 path 会撞车）。
    let picked_ids: Vec<String> = {
        let picked = wave::resolve_ids(&session.trace.vars, &name_refs).map_err(wave_error)?;
        picked.into_iter().map(|var| var.id.clone()).collect()
    };
    let picked: Vec<wave::WaveVar> = picked_ids
        .iter()
        .filter_map(|id| session.trace.vars.iter().find(|var| &var.id == id).cloned())
        .collect();
    let picked_refs: Vec<&wave::WaveVar> = picked.iter().collect();
    let values = wave::values_at(session, &picked_refs, time).map_err(wave_error)?;
    let map: std::collections::BTreeMap<String, Option<wave::WaveValue>> = values.into_iter().collect();
    serde_json::to_string(&serde_json::json!({
        "file": session.trace.file,
        "at": time.to_string(),
        "timescale": session.trace.timescale,
        "values": map,
    }))
    .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
    .and_then(check_payload)
}

/// WaveError → napi 错误。JS 侧按 `error.code` 分派（`VCD_PARSE`/`SIGNAL_NOT_FOUND`/
/// `VCD_RESOURCE_LIMIT`…），所以稳定码既要进 `message` 前缀（便于人读与正则匹配），
/// 也要写进错误对象自身，供 `error.code` 直接判定。
fn wave_error(error: wave::WaveError) -> Error {
    let text = format!("[{}] {}", error.code, error.message);
    let status = match error.code.as_str() {
        "VCD_PARSE" => Status::InvalidArg,
        "SIGNAL_NOT_FOUND" => Status::InvalidArg,
        "INVALID_ARGUMENT" => Status::InvalidArg,
        "SOURCE_NOT_FOUND" => Status::GenericFailure,
        _ => Status::GenericFailure,
    };
    Error::new(status, text)
}

/// 窗口内全保真跳变枚举；`from` 为左开下界（-1 表示从首事件起）。
#[napi]
pub fn wave_changes(handle: Option<i64>, file: Option<String>, signals: String, from: Option<i64>, to: Option<i64>, limit: Option<u32>) -> Result<String> {
    SessionSource::from(handle, file)?.run(|session| {
        let end = session.trace.end_time;
        let to = to.unwrap_or(end);
        let from = from.unwrap_or(-1);
        if from >= to {
            return Err(Error::from_reason("--from 必须早于 --to"));
        }
        let names: Vec<String> = signals.split(',').map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
        check_ids(names.len())?;
        let name_refs: Vec<&str> = names.iter().map(|n| n.as_str()).collect();
        let picked: Vec<wave::WaveVar> = {
            let resolved = wave::resolve_ids(&session.trace.vars, &name_refs).map_err(wave_error)?;
            // 按 id 回查：逐位展开后隐藏源与原向量同 path，按 path 会撞车。
            let ids: Vec<String> = resolved.into_iter().map(|v| v.id.clone()).collect();
            ids.iter().filter_map(|id| session.trace.vars.iter().find(|v| &v.id == id).cloned()).collect()
        };
        let limit = (limit.unwrap_or(200) as usize).min(10000);
        let mut series = Vec::new();
        for variable in &picked {
            series.push(wave::changes_for_public(session, variable, from, to, limit).map_err(wave_error)?);
        }
        serde_json::to_string(&serde_json::json!({
            "file": session.trace.file,
            "from": (from + 1).to_string(),
            "to": to.to_string(),
            "timescale": session.trace.timescale,
            "series": series,
        }))
        .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
        .and_then(check_payload)
    })
}

/// 沿/未知态搜索（rise/fall 对向量信号需 bit 位级投影）。
#[napi]
pub fn wave_edges(handle: Option<i64>, file: Option<String>, signal: String, kind: Option<String>, bit: Option<u32>, from: Option<i64>, to: Option<i64>, limit: Option<u32>) -> Result<String> {
    SessionSource::from(handle, file)?.run(|session| {
    let kind = kind.unwrap_or_else(|| "any".to_string());
    if !["any", "rise", "fall", "x", "z"].contains(&kind.as_str()) {
        return Err(Error::from_reason("--kind 必须为 any|rise|fall|x|z"));
    }
    let resolved = wave::resolve_ids(&session.trace.vars, &[signal.as_str()]).map_err(wave_error)?;
    let variable = resolved[0].clone();
    if let Some(offset) = bit {
        if offset >= variable.width {
            return Err(Error::from_reason("--bit 超出信号位宽"));
        }
    }
    if matches!(kind.as_str(), "rise" | "fall") && variable.width != 1 && bit.is_none() {
        return Err(Error::from_reason("向量信号的 rise/fall 需要 --bit <位下标>（LSB 起 0）"));
    }
    let end = session.trace.end_time;
    let to = to.unwrap_or(end);
    let from = from.unwrap_or(-1);
    if from >= to {
        return Err(Error::from_reason("--from 必须早于 --to"));
    }
    let limit = (limit.unwrap_or(100) as usize).min(10000);
    let (matched, next, events) = wave::edges(session, &variable, &kind, bit, from, to, limit).map_err(wave_error)?;
    serde_json::to_string(&serde_json::json!({
        "file": session.trace.file,
        "signal": variable.path,
        "kind": kind,
        "from": (from + 1).to_string(),
        "to": to.to_string(),
        "timescale": session.trace.timescale,
        "matched": matched,
        "truncated": next.is_some(),
        "next": next,
        "events": events.into_iter().map(|(t, from, to)| serde_json::json!({"t": t, "from": from, "to": to})).collect::<Vec<_>>(),
    }))
    .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
    .and_then(check_payload)
    })
}

/// 时钟沿采样多信号（clock 必须 1 位标量）；`where` 为逗号分隔的条件表达式列表。
#[napi]
pub fn wave_sample(handle: Option<i64>, file: Option<String>, clock: String, edge: Option<String>, signals: String, from: Option<i64>, to: Option<i64>, limit: Option<u32>, r#where: Option<Vec<String>>) -> Result<String> {
    SessionSource::from(handle, file)?.run(|session| {
    let edge = edge.unwrap_or_else(|| "rise".to_string());
    if !["rise", "fall", "both"].contains(&edge.as_str()) {
        return Err(Error::from_reason("--clock-edge 必须为 rise|fall|both"));
    }
    let clock_resolved = wave::resolve_ids(&session.trace.vars, &[clock.as_str()]).map_err(wave_error)?;
    let clock_var = clock_resolved[0].clone();
    let names: Vec<String> = signals.split(',').map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
    check_ids(names.len())?;
    let name_refs: Vec<&str> = names.iter().map(|n| n.as_str()).collect();
    let picked: Vec<wave::WaveVar> = {
        let resolved = wave::resolve_ids(&session.trace.vars, &name_refs).map_err(wave_error)?;
        // 按 id 回查：逐位展开后隐藏源与原向量同 path，按 path 会撞车。
        let ids: Vec<String> = resolved.into_iter().map(|v| v.id.clone()).collect();
        ids.iter().filter_map(|id| session.trace.vars.iter().find(|v| &v.id == id).cloned()).collect()
    };
    let picked_refs: Vec<&wave::WaveVar> = picked.iter().collect();
    // --where 条件：先解析成结构化条件，信号对信号的右值在这里确定。
    let where_texts = r#where.unwrap_or_default();
    let parsed: Vec<wave::WaveWhere> = where_texts
        .iter()
        .map(|text| wave::parse_where(text))
        .collect::<std::result::Result<_, _>>()
        .map_err(wave_error)?;
    let conditions = wave::resolve_where(&session.trace.vars, &parsed).map_err(wave_error)?;
    let end = session.trace.end_time;
    let to = to.unwrap_or(end);
    let from = from.unwrap_or(-1);
    if from >= to {
        return Err(Error::from_reason("--from 必须早于 --to"));
    }
    // 有 where 时默认页更小（与 JS 的 50 一致），无 where 时沿用 256。
    let default_limit = if conditions.is_empty() { 256 } else { 50 };
    let limit = (limit.unwrap_or(default_limit) as usize).min(MAX_SAMPLES as usize);
    let (scanned, matched, next, samples) = wave::sample(session, &clock_var, &edge, &picked_refs, &conditions, from, to, limit).map_err(wave_error)?;
    serde_json::to_string(&serde_json::json!({
        "file": session.trace.file,
        "clock": clock_var.path,
        "clockEdge": edge,
        "from": (from + 1).to_string(),
        "to": to.to_string(),
        "timescale": session.trace.timescale,
        "where": if where_texts.is_empty() { serde_json::Value::Null } else { serde_json::json!(where_texts) },
        "scannedEdges": scanned,
        "matched": matched,
        "truncated": next.is_some(),
        "next": next,
        "samples": samples.into_iter().map(|(t, values)| {
            let map: std::collections::BTreeMap<String, Option<wave::WaveValue>> = values.into_iter().collect();
            serde_json::json!({"t": t, "values": map})
        }).collect::<Vec<_>>(),
    }))
    .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
    .and_then(check_payload)
    })
}

/// 两份波形同名信号逐对比较：首差异时刻 + 前 N 条差异。
#[napi]
pub fn wave_diff(file: String, against: String, signals: Option<String>, from: Option<i64>, to: Option<i64>, limit: Option<u32>) -> Result<String> {
    let limit = (limit.unwrap_or(50) as usize).min(1000);
    let from = from.unwrap_or(0);
    let (outcome, file_a, file_b, to, timescale, against_timescale) =
        wave::diff_files(std::path::Path::new(&file), std::path::Path::new(&against), signals.as_deref(), from, to, limit)
            .map_err(wave_error)?;
    serde_json::to_string(&serde_json::json!({
        "file": file_a,
        "against": file_b,
        "from": from.to_string(),
        "to": to.to_string(),
        "timescale": if timescale.is_empty() { serde_json::Value::Null } else { serde_json::json!(timescale) },
        "againstTimescale": if against_timescale.is_empty() { serde_json::Value::Null } else { serde_json::json!(against_timescale) },
        "pairs": outcome.pairs,
        "totalDiffs": outcome.total_diffs,
        "differingSignals": outcome.differing_signals,
        "truncated": outcome.truncated,
        "firstDiff": outcome.first,
        "diffs": outcome.entries,
    }))
    .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
    .and_then(check_payload)
}

/// 视窗像素桶降采样：把 [start,end] 切成 pixels 个桶，每桶保留首末事件并标记密集区。
/// ids 为信号 id 列表（与 JS worker 协议一致，用 id 而非路径）。
#[napi]
pub fn wave_window(handle: Option<i64>, file: Option<String>, ids: Vec<String>, start: i64, end: i64, pixels: u32) -> Result<String> {
    SessionSource::from(handle, file)?.run(|session| {
    if start < 0 || end < 0 {
        return Err(Error::from_reason("视窗时间必须非负"));
    }
    if pixels == 0 {
        return Err(Error::from_reason("像素数必须为正整数"));
    }
    // 与旧 VcdStore 同口径：像素数与「信号数 × 像素数」都要有界，
    // 否则一次视窗查询就能把每个信号切成上百万桶、物化出巨量首末事件。
    check_ids(ids.len())?;
    if pixels > MAX_QUERY_PIXELS || ids.len() * pixels as usize > MAX_QUERY_POINTS {
        return Err(Error::from_reason(format!(
            "[VCD_RESOURCE_LIMIT] 视窗像素预算无效：pixels ≤ {MAX_QUERY_PIXELS} 且 信号数×像素数 ≤ {MAX_QUERY_POINTS}"
        )));
    }
    // 按 id 直接取变量，不走名称解析（面板侧的 id 来自 open 返回的变量表）。
    let mut picked: Vec<wave::WaveVar> = Vec::new();
    for id in &ids {
        match session.trace.vars.iter().find(|var| &var.id == id) {
            Some(var) => picked.push(var.clone()),
            None => return Err(Error::from_reason(format!("[SIGNAL_NOT_FOUND] 信号 id 不存在：{id}"))),
        }
    }
    let refs: Vec<&wave::WaveVar> = picked.iter().collect();
    let series = wave::window_series(session, &refs, start, end, pixels as usize).map_err(wave_error)?;
    serde_json::to_string(&serde_json::json!({ "series": series }))
        .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
        .and_then(check_payload)
    })
}

/// 边沿查询：next/previous，支持 bitOffset/bitWidth 位段投影与 continuation 续查。
#[napi]
pub fn wave_edge(handle: Option<i64>, file: Option<String>, id: String, time: i64, direction: String, bit_offset: Option<u32>, bit_width: Option<u32>, continuation: Option<u32>) -> Result<String> {
    SessionSource::from(handle, file)?.run(|session| {
    if time < 0 {
        return Err(Error::from_reason("查询时间必须是非负有限数值"));
    }
    // 入参既可能是变量 id（面板/worker 用），也可能是完整路径（CLI/测试用）。
    // 先按 id 精确命中，再退回名称解析（与 `wave values --signals` 同一套规则）。
    let looked_up = session.trace.vars.iter().find(|var| var.id == id).cloned();
    let var = match looked_up {
        Some(var) => var,
        None => {
            let resolved = wave::resolve_ids(&session.trace.vars, &[id.as_str()]).map_err(wave_error)?;
            resolved[0].clone()
        }
    };
    let bit_width = bit_width.unwrap_or(1);
    if let Some(offset) = bit_offset {
        if offset.checked_add(bit_width).is_none_or(|end| end > var.width) {
            return Err(Error::from_reason("位边沿下标无效"));
        }
    }
    // 续查起点：`edge_hit` 在耗尽逐事件扫描预算时返回 `continuation`（事件索引），
    // 调用方原样回传即可从断点继续。此前这里丢弃该参数，导致：
    // ① 每次续查都从头重扫（分页退化成 O(n²)）；
    // ② webview 的 `do…while (continuation)` 拿到同一个 continuation 无限重发同一请求。
    let hit = wave::edge_hit(
        session,
        &var,
        time,
        &direction,
        bit_offset,
        bit_width,
        continuation.map(|value| value as usize),
    )
    .map_err(wave_error)?;
    serde_json::to_string(&hit)
        .map_err(|error| Error::from_reason(format!("序列化失败：{}", error)))
        .and_then(check_payload)
    })
}

// ── 波形查询的异步入口 ──────────────────────────────────────────────
//
// 为什么每个查询都要有 `*_async`：
// webview 的波形会话用 `worker.terminate()` 取消加载/关闭面板。若此时 worker 线程
// 正卡在同步 napi 调用里，V8 拆 isolate 的同时 Rust 侧仍在访问波形数据，
// 析构会在已销毁的上下文里执行——实测 14 路并发测试下稳定段错误（0xC0000005）。
// 走 `AsyncTask` 后 compute 在 libuv 线程池执行，不持有 isolate，terminate 只会
// 丢弃结果，不会撕裂隔离区。同步版本保留给 CLI（单线程、无取消需求）。
macro_rules! wave_async {
    ($name:ident, $task:ident, $sync:ident, ($($arg:ident : $ty:ty),*)) => {
        pub struct $task {
            $($arg: $ty,)*
        }

        impl napi::Task for $task {
            type Output = String;
            type JsValue = String;

            fn compute(&mut self) -> Result<Self::Output> {
                $sync($(self.$arg.clone()),*)
            }

            fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
                Ok(output)
            }
        }

        #[napi(ts_return_type = "Promise<string>")]
        pub fn $name($($arg: $ty),*) -> AsyncTask<$task> {
            AsyncTask::new($task { $($arg),* })
        }
    };
}

wave_async!(wave_values_async, WaveValuesTask, wave_values, (handle: Option<i64>, file: Option<String>, signals: String, at: String));
wave_async!(wave_changes_async, WaveChangesTask, wave_changes, (handle: Option<i64>, file: Option<String>, signals: String, from: Option<i64>, to: Option<i64>, limit: Option<u32>));
wave_async!(wave_edges_async, WaveEdgesTask, wave_edges, (handle: Option<i64>, file: Option<String>, signal: String, kind: Option<String>, bit: Option<u32>, from: Option<i64>, to: Option<i64>, limit: Option<u32>));
wave_async!(wave_sample_async, WaveSampleTask, wave_sample, (handle: Option<i64>, file: Option<String>, clock: String, edge: Option<String>, signals: String, from: Option<i64>, to: Option<i64>, limit: Option<u32>, r#where: Option<Vec<String>>));
wave_async!(wave_diff_async, WaveDiffTask, wave_diff, (file: String, against: String, signals: Option<String>, from: Option<i64>, to: Option<i64>, limit: Option<u32>));
wave_async!(wave_window_async, WaveWindowTask, wave_window, (handle: Option<i64>, file: Option<String>, ids: Vec<String>, start: i64, end: i64, pixels: u32));
wave_async!(wave_edge_async, WaveEdgeTask, wave_edge, (handle: Option<i64>, file: Option<String>, id: String, time: i64, direction: String, bit_offset: Option<u32>, bit_width: Option<u32>, continuation: Option<u32>));
