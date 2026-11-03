//! 波形查询服务：wellen 统一读取 VCD/FST，按需加载信号。
//!
//! 与 JS 版 `src/agent/wave.js` 的输出合同保持一致：时刻一律整数 tick 字符串，
//! 原始位值保留 X/Z，信号名按「完整路径 > 唯一短名 > 唯一包含」解析且 alias 不算歧义。

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use wellen::{simple, Hierarchy, SignalRef, VarRef};

pub mod header;
pub mod normalize;
pub use header::WaveHeaderEntry;

/// 与 JS `UNITS` 一致：各时间单位对应的秒数。
const UNITS: [(&str, f64); 6] = [
    ("s", 1.0),
    ("ms", 1e-3),
    ("us", 1e-6),
    ("ns", 1e-9),
    ("ps", 1e-12),
    ("fs", 1e-15),
];

/// 统一的波形错误；`code` 与 JS 侧 fail() 的错误码对齐。
#[derive(Debug)]
pub struct WaveError {
    pub code: String,
    pub message: String,
    pub candidates: Vec<String>,
}

impl std::fmt::Display for WaveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for WaveError {}

impl WaveError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into(), candidates: Vec::new() }
    }
    pub fn with_candidates(mut self, candidates: Vec<String>) -> Self {
        self.candidates = candidates;
        self
    }
}

pub type WaveResult<T> = Result<T, WaveError>;

/// 单个变量（含 alias 各自一行）；`id` 是文件内符号，多个路径可能共享同一 id。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveVar {
    pub id: String,
    pub path: String,
    pub name: String,
    /// 与 JS 版字段名一致：作用域路径。
    #[serde(rename = "scopePath")]
    pub scope: String,
    /// `WaveTrace.scopes` 的下标；顶层或无作用域时为 `None`。
    #[serde(rename = "scopeId", skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<usize>,
    pub width: u32,
    #[serde(rename = "type")]
    pub var_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    /// 位下标方向（wellen `VarIndex`）。取值位串最左位对应 `msb`。
    /// 逐位 dump 展开要靠它还原每个位置的真实位号，不能依赖声明顺序。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msb: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lsb: Option<i64>,
    /// 该信号真实变化次数（JS 合同字段）。
    #[serde(rename = "changeCount", default)]
    pub change_count: usize,
    /// 逐位展开后的来源（原向量 id + 位偏移）；普通信号为 None。
    #[serde(rename = "packedSource", skip_serializing_if = "Option::is_none")]
    pub packed_source: Option<PackedSource>,
    /// 仅供内部取值回溯的隐藏条目（不得出现在变量表/信号清单里）。
    #[serde(skip_serializing, default)]
    pub trace_only: bool,
}


/// 打开后的波形句柄：层级元数据常驻，信号值按需加载。
pub struct WaveTrace {
    pub file: String,
    pub vars: Vec<WaveVar>,
    /// 扁平作用域表（索引即 WaveVar.scopeId）。
    pub scopes: Vec<header::DeclaredScope>,
    /// 文件内符号 → 变量下标（同 id 的 alias 只保留首个用于展示）。
    pub by_id: HashMap<String, usize>,
    /// wellen 变量引用，用于按需加载取值。
    pub var_refs: Vec<VarRef>,
    pub timescale: String,
    pub end_time: i64,
    pub format: String,
    pub file_bytes: u64,
    /// 时间步数（wellen 的 time_table 长度）。注意**不是** JS 合同的 `eventCount`。
    pub event_count: usize,
    /// 时间步数（wellen 的 time_table 长度，不是事件数）。
    pub time_steps: usize,
    /// VCD 头声明（$date/$version/$comment）；FST 为空。
    pub headers: Vec<WaveHeaderEntry>,
    /// 未合并的原始 $var 声明表（JS 侧按 RTL 范围重建总线时使用）。
    pub declarations: Vec<header::DeclaredVar>,
    pub cached: bool,
}

/// 解析 timescale 字符串为「秒/tick」；无效或缺失返回 None（此时拒绝物理单位输入）。
pub fn seconds_per_tick(timescale: &str) -> Option<f64> {
    let text = timescale.trim();
    let digits_end = text.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(text.len());
    if digits_end == 0 || digits_end == text.len() {
        return None;
    }
    let value: f64 = text[..digits_end].parse().ok()?;
    if !(value > 0.0) || !value.is_finite() {
        return None;
    }
    let unit = text[digits_end..].trim().to_ascii_lowercase();
    UNITS
        .iter()
        .find(|(name, _)| *name == unit)
        .map(|(_, scale)| value * scale)
}

/// 解析时间输入：裸整数 ticks，或带 s/ms/us/ns/ps/fs 单位。
/// 物理单位要求 timescale 可用，否则返回 None（由调用方报 INVALID_ARGUMENT）。
pub fn parse_tick(text: &str, seconds_per_tick: Option<f64>) -> Option<i64> {    let raw = text.trim();
    let digits_end = raw
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '+' || c == 'e' || c == 'E' || c == '-'))
        .unwrap_or(raw.len());
    // 负号只允许出现在指数位置；裸负数时间非法。
    if raw.starts_with('-') {
        return None;
    }
    let (number, unit) = raw.split_at(digits_end);
    let value: f64 = number.trim().parse().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    let unit = unit.trim().to_ascii_lowercase();
    let tick = if unit.is_empty() || unit.starts_with("tick") {
        value
    } else {
        let scale = UNITS.iter().find(|(name, _)| *name == unit)?.1;
        let per_tick = seconds_per_tick?;
        value * scale / per_tick
    };
    if !tick.is_finite() || tick < 0.0 || tick > i64::MAX as f64 {
        return None;
    }
    Some(tick.round() as i64)
}

/// wellen 的 VarType 映射到 JS 版沿用的 VCD 风格类型名。
fn type_name(var: &wellen::Var) -> String {
    use wellen::VarType::*;
    match var.var_type() {
        Wire => "wire",
        Reg => "reg",
        Integer => "integer",
        Real => "real",
        RealTime => "realtime",
        RealParameter => "real",
        String => "string",
        Parameter => "parameter",
        Supply0 => "supply0",
        Supply1 => "supply1",
        Time => "time",
        Tri => "tri",
        TriAnd => "triand",
        TriOr => "trior",
        TriReg => "trireg",
        Tri0 => "tri0",
        Tri1 => "tri1",
        WAnd => "wand",
        WOr => "wor",
        Logic => "logic",
        Bit => "bit",
        Int => "int",
        ShortInt => "shortint",
        LongInt => "longint",
        Byte => "byte",
        Enum => "enum",
        ShortReal => "shortreal",
        Event | EventParameter => "event",
        Port => "port",
        SparseArray => "array",
        Boolean => "boolean",
        BitVector | StdLogicVector | StdULogicVector => "logic",
        StdLogic | StdULogic => "logic",
    }
    .to_string()
}

/// 波形格式的短名（`vcd`/`fst`/`ghw`），与 JS 合同的 `format` 字段一致。
fn format_name(hierarchy: &Hierarchy) -> &'static str {
    match hierarchy.file_format() {
        wellen::FileFormat::Vcd => "vcd",
        wellen::FileFormat::Fst => "fst",
        wellen::FileFormat::Ghw => "ghw",
        wellen::FileFormat::Unknown => "unknown",
    }
}

fn is_bit_dump(var: &WaveVar, declared: &[header::DeclaredVar]) -> bool {
    if var.range.is_none() || var.msb.is_none() {
        return false;
    }
    // 位宽 1 且带位下标：必然是逐位声明（原生向量声明不会只有 1 位还写下标）。
    if var.width == 1 {
        return true;
    }
    // 位宽 > 1：只有「wellen 把多条逐位声明合并成向量」时才需要重新展开。
    //
    // 判据：该作用域 + 基名下存在**多于一條、且都是单位宽**的逐位声明。
    // 不能用「声明数 == 向量位宽」——wellen 的合并是**声明顺序贪心**，
    // 只合并相邻位号，可能只合并了一部分（实测 `[-4,-2,-1,-3]` 只合并出 3 位
    // `[-1:-3]`，`-4` 孤立）。只要这一组是逐位声明，就把向量按 msb/lsb 展开成位，
    // 未合并的位由它们自己的单位变量承担，上层再一起按 RTL 重排。
    let base = var.name.split('[').next().unwrap_or(&var.name);
    let bits: Vec<&header::DeclaredVar> = declared
        .iter()
        .filter(|item| item.scope == var.scope && item.name == base && item.width == 1 && item.msb.is_some())
        .collect();
    bits.len() > 1
}



/// 按位展开一条带下标变量的位号，返回 `(位号, 位串偏移)`。
///
/// 取值位串最左位对应 `msb`，最右位对应 `lsb`；宽度为 N 时共 N 位。
/// `position` 是该位在字符串里的下标（0 = 最左）。
fn bit_layout(var: &WaveVar) -> Vec<(i64, usize)> {
    let Some(msb) = var.msb else { return Vec::new() };
    let Some(lsb) = var.lsb else { return Vec::new() };
    let width = var.width as usize;
    if width == 0 {
        return Vec::new();
    }
    let step: i64 = if msb >= lsb { -1 } else { 1 };
    (0..width)
        .map(|position| (msb + step * position as i64, position))
        .collect()
}

/// 把逐位 dump 的变量**按位展开**成独立单位变量。
///
/// wellen 的合并是「声明顺序相邻」的贪心结果，与 RTL 位集合无关（实测
/// `[-4,-2,-1,-3]` 只合并 `-2,-1,-3`，`-4` 孤立）。这里统一展开，
/// 让上层 `restorePackedBuses` 只看「一组单位变量 + 各自位号」，自行按 RTL 重排：
/// - 合并向量（宽 N）→ N 个单位变量，位号由 `msb`/`lsb` 精确推出；
/// - 孤立单位变量（宽 1、带位下标）→ 保持原样。
///
/// 展开后的单位变量 id 形如 `<原id>#<位号>`，并带 `packedSource` 供取值时按位切片。
fn expand_bit_dumps(vars: Vec<WaveVar>, declared: &[header::DeclaredVar]) -> Vec<WaveVar> {
    let mut expanded = Vec::with_capacity(vars.len());
    for var in vars {
        if !is_bit_dump(&var, declared) {
            expanded.push(var);
            continue;
        }
        let layout = bit_layout(&var);
        // 宽度 1 的位级声明本身已是单位变量，无需展开。
        if layout.len() <= 1 {
            expanded.push(var);
            continue;
        }
        // 保留原向量：位变量的取值要回溯到它（按位切片），
        // 上层展示会过滤掉它（只显示展开后的位变量或合成总线）。
        let mut source = var.clone();
        source.id = format!("{}#@source", var.id);
        source.packed_source = None;
        source.trace_only = true;
        expanded.push(source);
        for (bit_index, position) in layout {
            let suffix = format!("[{}]", bit_index);
            expanded.push(WaveVar {
                id: format!("{}#{}", var.id, bit_index),
                // 位号拼进 path/name：上层据此识别位级声明（与 JS parser 形态一致）。
                path: format!("{}{}", var.path, suffix),
                name: format!("{}{}", var.name, suffix),
                scope: var.scope.clone(),
                scope_id: var.scope_id,
                width: 1,
                var_type: var.var_type.clone(),
                range: Some(suffix),
                msb: Some(bit_index),
                lsb: Some(bit_index),
                change_count: var.change_count,
                // 取值时按 position 从原向量位串里切出这一位。
                packed_source: Some(PackedSource {
                    id: format!("{}#@source", var.id),
                    position,
                    width: var.width,
                }),
                trace_only: false,
            });
        }
    }
    expanded
}

/// 单位变量对应的原向量信息（用于按位取值）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedSource {
    /// 原（合并）向量 id。
    pub id: String,
    /// 该位在取值位串中的下标（0 = 最左 / msb）。
    pub position: usize,
    /// 原位宽。
    pub width: u32,
}

/// 给 wellen 的变量分配稳定 id。
///
/// 优先级：
/// 1. **符号精确匹配**：wellen 的变量（路径 + 位宽）恰好对应一条 `$var` 声明时，用其符号。
/// 2. **合并向量匹配**：wellen 把「同作用域 + 同名 + 相邻位号」的逐位声明合并成一个向量
///    （ModelSim/Questa 逐位 dump），此时用**首个成员声明的符号**作为该向量身份。
/// 3. **回退序号**：FST 无符号概念，或结构对不上时用 VarRef 序号（同文件内稳定）。
///
/// 这条规则是从实测错位反推出来的：曾按「声明顺序逐一对齐」，合并后变量数变少，
/// 导致后续所有 id 整体偏移（`#` 被标成 `%`），查询与别名判定全部失效。
/// 变量与 `$var` 声明的匹配结果。
#[derive(Debug, Clone, Copy)]
struct Match {
    /// 命中的声明下标（合并向量时是该组首个成员）。
    index: usize,
    /// 是否是**一对一**的精确命中。
    ///
    /// 只有精确命中才能拿声明原文当变量名和 packed 范围：合并向量的声明是若干
    /// 单位宽逐位声明，它们的 name/range 描述的是单根线，不是合并后的向量。
    exact: bool,
}

/// 由 wellen 的层级树生成扁平作用域表（JS 合同：`{type,name,path,parentId}`）。
///
/// 必须遍历 wellen 的作用域而不是从变量表反推：空作用域（没有任何 `$var`）也要
/// 出现在信号树里，否则前端层级会缺分支。父下标用 `path` 前缀匹配填，这样与



/// 为 wellen 的每个变量找到它对应的 `$var` 声明（若有）。
///
/// 匹配优先级：
/// 1. **精确匹配**：声明表里的原始名（含数组下标）拼出的路径 == wellen 层级名，且位宽相同。
/// 2. **合并向量**：wellen 把「同作用域 + 同名 + 相邻位号」的逐位声明合并成一个向量
///    （ModelSim/Questa 逐位 dump），此时返回该组**首个**声明的下标。
/// 3. **无匹配**：FST 无符号概念，或结构对不上。
///
/// 必须用「原始名拼出的路径」而不是 wellen 拆出来的 `name()` 比较：wellen 在
/// `$var reg 8 # \mem[0] [7:0]` 里把 `[0]` 当成数组作用域、变量名只剩 `[0]`，
/// 按 name 比较永远不中，符号身份会整体退化成 VarRef 序号。
fn match_declarations(hierarchy: &Hierarchy, declared: &[header::DeclaredVar]) -> Vec<Option<Match>> {
    let mut matches = Vec::with_capacity(hierarchy.all_vars().count());
    let mut claimed = vec![false; declared.len()];
    for var_ref in hierarchy.all_vars() {
        let var = &hierarchy[var_ref];
        let raw_path = var.full_name(hierarchy);
        let path = normalize_hierarchy_name(&raw_path);
        let width = var.length(hierarchy).unwrap_or(1);
        let exact = declared.iter().enumerate().find(|(index, declaration)| {
            !claimed[*index] && declaration.width == width && declared_path(declaration) == path
        });
        if let Some((index, _)) = exact {
            claimed[index] = true;
            matches.push(Some(Match { index, exact: true }));
            continue;
        }
        // 合并向量：同作用域、同名、位宽累加等于向量宽度的声明组。
        let name = var.name(hierarchy).to_string();
        let scope = match raw_path.rfind('.') {
            Some(index) => raw_path[..index].to_string(),
            None => String::new(),
        };
        let mut accumulated = 0u32;
        let mut member = None;
        let mut taken = Vec::new();
        for (index, declaration) in declared.iter().enumerate() {
            if claimed[index] || declaration.scope != scope || declaration.name != name {
                continue;
            }
            if member.is_none() {
                member = Some(index);
            }
            accumulated += declaration.width.max(1);
            taken.push(index);
            if accumulated >= width {
                break;
            }
        }
        match member {
            Some(index) if accumulated == width => {
                for item in taken {
                    claimed[item] = true;
                }
                matches.push(Some(Match { index, exact: false }));
            }
            // 位宽对不上：不占用任何声明，回退到序号身份。
            _ => matches.push(None),
        }
    }
    matches
}


/// 一条 `$var` 声明在 wellen 层级里对应的完整路径。
///
/// 下标属于名字本身，直接拼接即可得到 wellen 规范化后的层级名
/// （`memory_dump.\mem[0]`）。真正的位下标是独立 token，不在 `name` 里。
fn declared_path(declaration: &header::DeclaredVar) -> String {
    if declaration.scope.is_empty() {
        declaration.name.clone()
    } else {
        format!("{}.{}", declaration.scope, declaration.name)
    }
}

/// 给 wellen 的变量分配稳定 id：有匹配声明时用其符号，否则用 VarRef 序号。
fn assign_ids(
    hierarchy: &Hierarchy,
    declared: &[header::DeclaredVar],
    matched: &[Option<Match>],
) -> Vec<String> {
    hierarchy
        .all_vars()
        .zip(matched)
        .map(|(var_ref, hit)| match hit {
            Some(item) => declared[item.index].symbol.clone(),
            None => var_ref.index().to_string(),
        })
        .collect()
}




/// 变量名带位下标时拼出 `[n]` / `[msb:lsb]`，与 VCD 版 `range` 字段对齐。
///
/// 注意：**位下标不是位宽**。`$var wire 1 # bits [7] $end` 是「1 位、位 7」，
/// 必须输出 `[7]` 而不是因为 width<=1 就丢掉——否则逐位声明的 `bits[7]`/`bits[6]`
/// 会在变量表里退化成两个同名 `bits`，前端无法区分也无法做位投影。
fn range_of(var: &wellen::Var, hierarchy: &Hierarchy) -> Option<String> {
    let index = var.index()?;
    let width = var.length(hierarchy)?;
    let msb = index.msb();
    let lsb = index.lsb();
    // index 存在即说明源码里写了位下标：单位宽给 `[n]`，多位宽给 `[msb:lsb]`。
    Some(if width <= 1 {
        format!("[{}]", msb)
    } else {
        format!("[{}:{}]", msb, lsb)
    })
}

/// 是否把位下标拼进 path/name。
///
/// VCD 合同（见 `test/waveform_stream_test.js` 的「元数据保留 range 和不同 bit 路径」）：
/// - **单位宽且带显式下标**（`$var wire 1 ! bits [7]`）→ 拼进 path，得到 `bits[7]`；
///   这类声明通常是为一个逻辑总线逐位 dump，不拼就会退化成多个同名条目。
/// - **多位宽向量**（`$var wire 8 # vector [7:0]`）→ path 保持 `vector`，范围只放 `range` 字段，
///   因为展开到 path 会让前端把位宽信息重复两次（`vector[7:0][7:0]` 风格的名字/范围错位）。
fn path_includes_index(width: u32, range: &Option<String>) -> bool {
    width <= 1 && range.is_some()
}


/// 规范化 wellen 的层级名：把 `.\mem.[0].[2]` 形式还原成 `\mem[0][2]`。
///
/// wellen 把 VCD 的转义标识符（`\mem`）与其后的数组下标都当成独立层级段，
/// 用 `.` 连接，于是 `$var reg 8 # mem[0][2]` 会变成 `.\mem.[0].[2]`。
/// JS 合同与既有测试要求 `mem[0][2]` 形态（下标紧贴名字），这里统一还原。
fn normalize_hierarchy_name(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '.' {
            // `.[` → 直接接下标，不加点
            if chars.peek() == Some(&'[') {
                continue;
            }
            out.push(ch);
            continue;
        }
        out.push(ch);
    }
    out
}

/// 为一个变量找到它在 wellen 里的 SignalRef。
///
/// 三类情况：
/// - **逐位展开项**：取值的实际来源是它的源向量（`packed_source.id` 指向的变量）；
/// - **普通变量**：路径直接命中 `var_refs` 建的映射；
/// - **wellen 未合并的孤立位变量**：`full_name` 只有基名（如 `top.d`），位号只体现在
///   `VarIndex` 上，必须靠「基名 + 位号」兜底查找。
fn resolve_signal_ref(
    var: &WaveVar,
    vars: &[WaveVar],
    path_to_signal: &HashMap<String, SignalRef>,
    bit_signal: &HashMap<(String, i64), SignalRef>,
) -> Option<SignalRef> {
    // ① 逐位展开项 → 源向量。源条目可能已被隐藏（trace_only），仍可从 vars 里查到。
    if let Some(source) = &var.packed_source {
        if let Some(source_var) = vars.iter().find(|item| item.id == source.id) {
            if let Some(signal_ref) = path_to_signal.get(&source_var.path) {
                return Some(*signal_ref);
            }
        }
    }
    // ② 普通路径命中。
    if let Some(signal_ref) = path_to_signal.get(&var.path) {
        return Some(*signal_ref);
    }
    // ③ 位号兜底：剥掉 path 末尾的 `[n]`，用基名 + msb 反查。
    if let Some(open) = var.path.rfind('[') {
        let base = &var.path[..open];
        if let Some(msb) = var.msb {
            if let Some(signal_ref) = bit_signal.get(&(base.to_string(), msb)) {
                return Some(*signal_ref);
            }
        }
    }
    None
}

/// 读取波形：先按原文件解析；wellen 的 body 解析按行推进，单行挤在一起的 body
/// 会静默解析出零时间步（实测 `$enddefinitions $end 0! #10 1!` 得到空时间表）。
/// 因此「有 body 内容却零时间步」时用规范化副本重试一次。正常文件不会走重试，无额外 IO。
fn read_wave(file: &Path) -> WaveResult<simple::Waveform> {
    let first = parse_once(file)?;
    if !normalize::needs_normalization(file, first.time_table().len()) {
        return Ok(first);
    }
    let Some(temporary) = normalized_copy(file) else { return Ok(first) };
    let retried = parse_once(&temporary);
    let _ = std::fs::remove_file(&temporary);
    match retried {
        Ok(wave) if wave.time_table().len() > first.time_table().len() => Ok(wave),
        // 规范化也救不回来：保留原始结果（可能确实是零事件文件）。
        _ => Ok(first),
    }
}

/// 生成 body 规范化副本；失败时返回 None（调用方退回原始结果）。
fn normalized_copy(file: &Path) -> Option<std::path::PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let target = std::env::temp_dir().join(format!("svtools-wave-{}-{}.vcd", std::process::id(), stamp));
    normalize::write_normalized(file, &target).ok()
}

/// 单次解析：捕获第三方库 panic，避免宿主进程被拖垮。
fn parse_once(file: &Path) -> WaveResult<simple::Waveform> {
    // 必须关掉 wellen 的 rayon 多线程：`LoadOptions::default()` 是 multi_thread=true，
    // 而 wellen 的 VCD 体解析用 rayon 全局线程池并行装载信号。本模块跑在 napi 环境里，
    // 既可能被 Node worker_threads 调用、也会被多个测试进程并发调用，rayon 的全局池
    // 与 napi 的线程模型叠加后实测在 14 路并发下稳定段错误（exitCode 0xC0000005）。
    // 单线程解析的代价可接受：500 MiB 语料实测 353 ms，瓶颈本就在 I/O。
    let options = wellen::LoadOptions {
        multi_thread: false,
        ..wellen::LoadOptions::default()
    };
    // wellen 对某些变体（如 EVCD 的端口强度三元组）会 panic 而不是返回 Err。
    // 波形解析是第三方库边界，必须捕获为可诊断错误，否则整个宿主进程会崩溃。
    match catch_library_panic(|| simple::read_with_options(file, &options)) {
        Ok(Ok(wave)) => Ok(wave),
        Ok(Err(error)) => {
            let text = error.to_string();
            // wellen 对未知格式报「unknown file format」，这里给出更可操作的提示。
            Err(if text.contains("unknown file format") {
                WaveError::new("WAVE_FORMAT_UNSUPPORTED", "不支持的波形格式（仅支持 VCD 与 FST）")
            } else {
                WaveError::new("VCD_PARSE", format!("波形解析失败：{}", text))
            })
        }
        Err(detail) => Err(WaveError::new(
            "WAVE_FORMAT_UNSUPPORTED",
            format!("波形内容含不支持的编码（如 EVCD 端口强度）：{}", detail),
        )),
    }
}

/// 静默捕获第三方库 panic：返回 Err(可读描述)。
///
/// 默认 panic hook 会把 "not yet implemented" 之类打到 stderr，污染 CLI 的 JSON 输出。
/// **不能**在每次调用时 `take_hook` + `set_hook` 再恢复：hook 是进程全局状态，
/// `set_hook` 与并发 panic 之间是数据竞争，实测在 14 路并发测试下会直接段
/// （exitCode 0xC0000005）。这里改为进程内只安装一次静默 hook，之后不再改动。
fn catch_library_panic<T>(task: impl FnOnce() -> T) -> Result<T, String> {
    use std::sync::Once;
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| std::panic::set_hook(Box::new(|_| {})));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(task));
    outcome.map_err(|payload| {
        payload
            .downcast_ref::<&str>()
            .map(|text| text.to_string())
            .or_else(|| payload.downcast_ref::<std::string::String>().cloned())
            .unwrap_or_else(|| "未知内部错误".to_string())
    })
}

/// 打开波形文件（VCD 或 FST），只读层级元数据，不加载信号值。
pub fn open(file: &Path) -> WaveResult<WaveTrace> {
    let mut wave = read_wave(file)?;
    describe(file, &mut wave)
}

/// 从已解析的 waveform 提取元数据；与 `WaveSession` 共享同一次解析结果。
fn describe(file: &Path, wave: &mut simple::Waveform) -> WaveResult<WaveTrace> {
    let metadata = std::fs::metadata(file).map_err(|_error| {
        WaveError::new("SOURCE_NOT_FOUND", format!("波形文件不存在：{}", file.display()))
    })?;
    if !metadata.is_file() {
        return Err(WaveError::new("SOURCE_NOT_FOUND", format!("波形路径不是普通文件：{}", file.display())));
    }

    let hierarchy = wave.hierarchy();
    // timescale 优先取 VCD 原文（`1 ns`），因为 CLI 输出是对外契约、既有调用方按原文比较。
    // FST/GHW 没有可读的文本头，退回 wellen 的结构化值重建成 `<factor><unit>` 无空格形式。
    let timescale = header::declared_timescale(file, format_name(hierarchy)).unwrap_or_else(|| match hierarchy.timescale() {
        Some(scale) => {
            let unit = match scale.unit {
                wellen::TimescaleUnit::ZeptoSeconds => "zs",
                wellen::TimescaleUnit::AttoSeconds => "as",
                wellen::TimescaleUnit::FemtoSeconds => "fs",
                wellen::TimescaleUnit::PicoSeconds => "ps",
                wellen::TimescaleUnit::NanoSeconds => "ns",
                wellen::TimescaleUnit::MicroSeconds => "us",
                wellen::TimescaleUnit::MilliSeconds => "ms",
                wellen::TimescaleUnit::Seconds => "s",
                wellen::TimescaleUnit::Unknown => "",
            };
            if unit.is_empty() { String::new() } else { format!("{}{}", scale.factor, unit) }
        }
        None => String::new(),
    });

    let mut vars = Vec::new();
    let mut var_refs = Vec::new();
    let mut by_id = HashMap::new();
    // 信号身份有两个来源：
    // - VCD：用 `$var` 的符号标识（`!`/`#`/`%`…），这是 JS 版、前端缓存与既有测试共同建立的
    //   稳定身份，跨实现可对拍；
    // - FST：没有等价概念，退回 VarRef 序号（同文件内稳定）。
    //
    // 关键约束：wellen 会把「同名 + 相邻位号」的逐位声明**合并成一个向量**
    // （为兼容 ModelSim/Questa 的逐位 dump），变量数因此少于 `$var` 声明数。
    // 合并后的向量语义上对应「该组逐位声明的整体」，因此取**首个成员的符号**作为其身份；
    // 逐一按声明顺序对齐会整体错位（实测 `#` 被标成 `%`）。
    let (scopes, declared) = header::declared_hierarchy(file, format_name(hierarchy));
    let matched = match_declarations(hierarchy, &declared);
    let ids = assign_ids(hierarchy, &declared, &matched);
    // wellen 用 VarRef 迭代全部变量（含各层级），每个 alias 是独立 VarRef。
    for (position, var_ref) in hierarchy.all_vars().enumerate() {
        let var = &hierarchy[var_ref];
        let id = ids
            .get(position)
            .cloned()
            .unwrap_or_else(|| var_ref.index().to_string());
        let width = var.length(hierarchy).unwrap_or(1);
        // 命中原声明时用声明原文：wellen 的 `name()`/`index()` 只在下标恰好等于声明
        // 位宽时才可信，`\mem[0] [7:0]` 这类数组元素会把它当数组下标拆走，
        // 名字只剩 `[0]`、packed range 整个丢掉。
        let declaration = matched
            .get(position)
            .copied()
            .flatten()
            .filter(|item| item.exact)
            .map(|item| &declared[item.index]);
        let (base_path, base_name, range, msb, lsb) = match declaration {
            Some(item) => {
                let scope = if item.scope.is_empty() {
                    String::new()
                } else {
                    format!("{}.", item.scope)
                };
                let msb = item.msb;
                (
                    format!("{}{}", scope, item.name),
                    item.name.clone(),
                    item.range.clone(),
                    msb,
                    // 声明给了 `[msb:lsb]` 时 lsb 也从声明取；单位下标两值相同。
                    msb.map(|highest| match (&item.range, highest) {
                        (Some(range), _) => match range.trim_matches(&['[', ']'][..]).split_once(':') {
                            Some((_, lsb)) => lsb.parse().unwrap_or(highest),
                            None => highest,
                        },
                        (None, _) => highest,
                    }),
                )
            }
            None => (
                normalize_hierarchy_name(&var.full_name(hierarchy)),
                normalize_hierarchy_name(var.name(hierarchy)),
                range_of(var, hierarchy),
                var.index().map(|index| index.msb()),
                var.index().map(|index| index.lsb()),
            ),
        };
        // VCD 把名字与位下标分开存（`$var wire 1 ! bits [7] $end`）；
        // JS 合同要求单位宽的下标拼进 path/name（`bits[7]`），多位向量只留 range 字段。
        let (path, name) = if path_includes_index(width, &range) {
            let suffix = range.as_deref().unwrap_or_default();
            (format!("{}{}", base_path, suffix), format!("{}{}", base_name, suffix))
        } else {
            (base_path, base_name)
        };
        let scope = match path.rfind('.') {
            Some(index) => path[..index].to_string(),
            None => String::new(),
        };
        // 作用域下标优先取声明自己的：Icarus 会给每条 `$var` 各套一个同名
        // `$scope module x`，按路径查只会命中最后一条，前端层级校验就断了。
        let scope_id = match matched.get(position).copied().flatten().map(|item| &declared[item.index]) {
            Some(item) => item.scope_id,
            None => scopes.iter().position(|entry| entry.path == scope),
        };
        let entry = WaveVar {
            id: id.clone(),
            path,
            name,
            scope,
            scope_id,
            width,
            var_type: type_name(var),
            range,
            msb,
            lsb,
            packed_source: None,
            trace_only: false,
            // 真实变化次数在 describe 末尾统一回填（需要先扫一遍事件）。
            change_count: 0,
        };
        if !by_id.contains_key(&id) {
            by_id.insert(id, vars.len());
        }
        vars.push(entry);
        var_refs.push(var_ref);
    }

    if vars.is_empty() {
        return Err(WaveError::new("VCD_PARSE", "波形中没有任何变量"));
    }

    // wellen 的 Time 是 u64；JS 合同用整数 tick 字符串，超出 i64 的记录极少见，
    // 这里饱和到 i64::MAX 而不是 panic。
    let end_time = wave.time_table().last().copied().unwrap_or(0).min(i64::MAX as u64) as i64;
    let format = match hierarchy.file_format() {
        wellen::FileFormat::Vcd => "vcd",
        wellen::FileFormat::Fst => "fst",
        wellen::FileFormat::Ghw => "ghw",
        wellen::FileFormat::Unknown => "unknown",
    };
    let headers = header::read_headers(file, format);
    // 逐信号事件数：JS 的 `changeCount`/`eventCount` 语义是「该信号实际发生的变化次数」，
    // wellen 不缓存这个统计，必须扫一遍。用 stream 接口而不是 load_signals 全量装载，
    // 避免为计数把每个信号的事件序列都物化一遍（500 MiB 语料实测内存差 3 倍以上）。
    let wave_time_steps = wave.time_table().len();
    let (signal_event_count, per_signal) = count_signal_events(wave);
    ensure_body_not_silently_empty(file, format, signal_event_count)?;
    let vars = attach_change_counts(vars, &var_refs, wave.hierarchy(), &per_signal);
    // 逐位 dump：按 msb/lsb 精确展开成单位变量，交给上层按 RTL 范围重排。
    // wellen 的合并是声明顺序贪心，位集合不完整，不能直接当位来源。
    let vars = expand_bit_dumps(vars, &declared);
    Ok(WaveTrace {
        file: file.display().to_string(),
        vars,
        scopes,
        by_id,
        var_refs,
        timescale,
        end_time,
        format: format.to_string(),
        file_bytes: metadata.len(),
        event_count: signal_event_count,
        // 时间步数单独保留：dense/window 的像素预算按时间轴刻度算，不按事件数。
        time_steps: wave_time_steps,
        headers,
        declarations: declared,
        cached: false,
    })
}

/// 体完整性校验：wellen 对残缺的 VCD body（例如头结束后来一个孤立的 `b101`）
/// 体完整性校验：wellen 对残缺的 VCD body（例如头结束后来一个孤立的 `b101`）
/// **静默接受**，产生 0 事件、endTime=0 的空波形。这在排查现场会被误读成
/// 「仿真跑完了但没有任何跳变」，必须拦下来报 VCD_PARSE。
///
/// 判据：文件里出现 `$enddefinitions` 之后仍存在非空白内容、却解析不出任何事件，
/// 视为截断/损坏。FST 走二进制结构校验，不适用本检查。
fn ensure_body_not_silently_empty(file: &Path, format: &str, event_count: usize) -> WaveResult<()> {
    if format != "vcd" || event_count > 0 {
        return Ok(());
    }
    use std::io::Read;
    const MAX_SCAN_BYTES: u64 = 8 * 1024 * 1024;
    let Ok(handle) = std::fs::File::open(file) else { return Ok(()) };
    let mut buffer = Vec::new();
    if handle.take(MAX_SCAN_BYTES).read_to_end(&mut buffer).is_err() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&buffer);
    let Some(position) = text.find("$enddefinitions") else { return Ok(()) };
    let rest = &text[position..];
    // 跳过 `$enddefinitions <id>` 声明行本身的残余到行尾。
    let body = match rest.find('\n') {
        Some(index) => &rest[index + 1..],
        None => "",
    };
    // 去掉 `$dumpvars`/`$end`/空白后仍有内容 → 有数据却零事件，判定为损坏。
    let meaningful = body
        .replace("$dumpvars", "")
        .replace("$end", "")
        .replace("$dumpall", "")
        .replace("$dumpoff", "")
        .replace("$dumpon", "");
    if meaningful.trim().is_empty() {
        return Ok(());
    }
    Err(WaveError::new(
        "VCD_PARSE",
        "VCD 体内容不完整或损坏：文件在 $enddefinitions 之后有数据但解析不出任何事件",
    ))
}
///
/// 为什么要单独扫一遍：wellen 只保留时间表与列式数据，不缓存「每个信号变化了几次」。
/// 逐个 `load_signals` → 计数 → `unload_signals`，峰值只驻留一个信号的事件序列，
/// 避免为统计把全部信号同时物化（大体量语料下内存差数倍）。
///
/// `eventCount` 与 JS 同义：**按唯一信号累加**，alias 共享同一 SignalRef、不重复计数。
fn count_signal_events(wave: &mut simple::Waveform) -> (usize, HashMap<usize, usize>) {
    let mut seen: Vec<SignalRef> = Vec::new();
    for var_ref in wave.hierarchy().all_vars() {
        let signal_ref = wave.hierarchy()[var_ref].signal_ref();
        if !seen.contains(&signal_ref) {
            seen.push(signal_ref);
        }
    }
    let mut per_signal: HashMap<usize, usize> = HashMap::new();
    let mut total = 0usize;
    for signal_ref in seen {
        wave.load_signals(&[signal_ref]);
        let count = wave
            .get_signal(signal_ref)
            .map(|signal| signal.iter_changes().count())
            .unwrap_or(0);
        wave.unload_signals(&[signal_ref]);
        per_signal.insert(signal_ref.index(), count);
        total += count;
    }
    (total, per_signal)
}

/// 把统计到的变化次数写回变量表。`var_refs[i]` 与 `vars[i]` 一一对应，
/// 同一 SignalRef 的多条 alias 因此拿到同一个计数。
fn attach_change_counts(
    mut vars: Vec<WaveVar>,
    var_refs: &[VarRef],
    hierarchy: &Hierarchy,
    per_signal: &HashMap<usize, usize>,
) -> Vec<WaveVar> {
    for (index, var) in vars.iter_mut().enumerate() {
        let count = var_refs
            .get(index)
            .map(|var_ref| hierarchy[*var_ref].signal_ref().index())
            .and_then(|signal_index| per_signal.get(&signal_index).copied())
            .unwrap_or(0);
        var.change_count = count;
    }
    vars
}

/// 信号名 → 唯一 id。完整路径优先，其次唯一短名/后缀，最后唯一包含匹配；
/// 同一 id 的多条 alias 不算歧义，未命中与多 id 歧义都返回候选。
pub fn resolve_ids<'a>(vars: &'a [WaveVar], names: &[&str]) -> WaveResult<Vec<&'a WaveVar>> {
    let mut picked = Vec::new();
    for name in names {
        // 隐藏条目（原向量，供位变量取值回溯）不参与名称解析。
        let visible = || vars.iter().filter(|var| !var.trace_only);
        let exact: Vec<&WaveVar> = visible().filter(|var| var.path == *name).collect();
        let loose: Vec<&WaveVar> = visible()
            .filter(|var| var.name == *name || var.path.ends_with(&format!(".{}", name)))
            .collect();
        let unique_ids = |list: &[&WaveVar]| -> Vec<String> {
            let mut seen = Vec::new();
            for var in list {
                if !seen.contains(&var.id) {
                    seen.push(var.id.clone());
                }
            }
            seen
        };
        let chosen: Vec<&WaveVar> = if unique_ids(&exact).len() == 1 {
            exact.clone()
        } else if unique_ids(&loose).len() == 1 {
            loose.clone()
        } else {
            Vec::new()
        };
        let resolved = if chosen.is_empty() && exact.is_empty() && loose.is_empty() {
            let needle = name.to_lowercase();
            vars.iter().filter(|var| var.path.to_lowercase().contains(&needle)).collect::<Vec<_>>()
        } else {
            chosen
        };
        let ids = unique_ids(&resolved);
        if ids.len() != 1 {
            let candidates: Vec<String> = exact
                .iter()
                .chain(loose.iter())
                .map(|var| var.path.clone())
                .take(20)
                .collect();
            let message = if ids.len() > 1 {
                format!("信号名匹配多个候选，请使用完整层级路径：{}", name)
            } else {
                format!("信号不存在：{}", name)
            };
            return Err(WaveError::new("SIGNAL_NOT_FOUND", message).with_candidates(candidates));
        }
        // 取该 id 的第一个变量作为展示名（alias 不产生第二行）。
        picked.push(resolved.into_iter().next().expect("resolved has one id"));
    }
    Ok(picked)
}

/// 生成可复用的信号查询上下文：wellen 波形只能加载一次，查询需共享同一实例。
pub struct WaveSession {
    pub trace: WaveTrace,
    wave: simple::Waveform,
    /// id → VarRef，避免每次按路径重查。
    refs: HashMap<String, SignalRef>,
}

impl WaveSession {
    /// 打开并保持 waveform 实例；本次查询期间不再重复解析文件。
    /// wellen 的 Waveform 不可克隆，元数据与实例必须来自同一次解析，
    /// 否则变量引用与信号索引可能对不上。
    pub fn open(file: &Path) -> WaveResult<Self> {
        let mut wave = read_wave(file)?;
        let trace = describe(file, &mut wave)?;
        let hierarchy = wave.hierarchy();
        let mut refs = HashMap::new();
        // `trace.vars` 经过 `expand_bit_dumps` 展开后与 `trace.var_refs` 不再一一对应，
        // 因此分两步建映射：
        // ① 用 `var_refs`（wellen 原始表）建立「wellen 路径 → SignalRef」；
        // ② 按变量类型映射：
        //    - 逐位展开项：取值的实际来源是它的源向量（packed_source.id）；
        //    - 其余项：用其自身路径；路径对不上时（如孤立位变量 `top.d[-4]`，
        //      wellen 的 full_name 是 `top.d`）按「基名 + 位号」再试一次。
        // 键必须是**规范化后**的路径：trace.vars 里的 path 已按 JS 合同规范化，
        // 仍用 wellen 原始全名（memory_dump.\mem.[0]）建表会让所有数组元素对不上。
        let path_to_signal: HashMap<String, SignalRef> = trace
            .var_refs
            .iter()
            .map(|var_ref| {
                let var = &hierarchy[*var_ref];
                (normalize_hierarchy_name(&var.full_name(hierarchy)), var.signal_ref())
            })
            .collect();
        // 单位变量的位号 → 同一个 SignalRef 的兜底表：wellen 未合并的孤立位变量
        // 在 hierarchy 里 full_name 是基名（如 `top.d`），位号只体现在 VarIndex 上。
        let mut bit_signal: HashMap<(String, i64), SignalRef> = HashMap::new();
        for var_ref in &trace.var_refs {
            let var = &hierarchy[*var_ref];
            if let Some(index) = var.index() {
                let base = normalize_hierarchy_name(&var.full_name(hierarchy));
                bit_signal.entry((base, index.msb())).or_insert_with(|| var.signal_ref());
            }
        }
        for var in &trace.vars {
            let Some(signal_ref) = resolve_signal_ref(&var, &trace.vars, &path_to_signal, &bit_signal) else { continue };
            refs.insert(var.id.clone(), signal_ref);
        }
        Ok(Self { trace, wave, refs })
    }



    pub fn hierarchy(&self) -> &Hierarchy {
        self.wave.hierarchy()
    }

    /// 按信号 id 取按需加载的 SignalRef。
    pub fn signal_ref(&self, id: &str) -> Option<SignalRef> {
        self.refs.get(id).copied()
    }

    /// 批量按需加载信号值。
    ///
    /// 必须用单线程版 `load_signals`，不能用 `load_signals_multi_threaded`：
    /// 后者内部是 `ids.par_iter()`，走 **rayon 全局线程池**。本模块跑在 napi 里，
    /// 会被 Node worker_threads 与多个测试进程并发调用，rayon 全局池与 napi 的
    /// 线程模型叠加会触发访问违例（`0xC0000005`）。`parse_once` 已关掉
    /// `LoadOptions.multi_thread`，这条 load 路径是同一类问题的另一半——
    /// 本机 6 并发虽能跑过，CI（2 核慢盘）稳定复现。
    pub fn load(&mut self, ids: &[SignalRef]) {
        self.wave.load_signals(ids);
    }

    pub fn signal(&self, id: SignalRef) -> Option<&wellen::Signal> {
        self.wave.get_signal(id)
    }

    /// 时间表索引 → tick 值。
    pub fn time_at(&self, index: wellen::TimeTableIdx) -> u64 {
        self.wave.time_table().get(index as usize).copied().unwrap_or(0)
    }

    /// 时间表是严格递增的 tick 序列；返回「不超过 time 的最大索引」。
    /// 早于首个时间点返回 None（与 JS 版「未初始化值为 null」一致）。
    pub fn time_index_at(&self, time: u64) -> Option<wellen::TimeTableIdx> {
        let table = self.wave.time_table();
        if table.is_empty() || table[0] > time {
            return None;
        }
        let mut low = 0usize;
        let mut high = table.len();
        while low < high {
            let middle = (low + high) / 2;
            if table[middle] <= time {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        Some((low - 1) as wellen::TimeTableIdx)
    }
}

/// 单个信号的取值结果；`bits` 保留原始位串（含 X/Z），`value` 是适配宽度的解码值。
#[derive(Debug, Clone, Serialize)]
pub struct WaveValue {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bits: Option<String>,
    pub width: u32,
    #[serde(rename = "type")]
    pub var_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hex: Option<String>,
}

/// 把 wellen 的 SignalValueRef 转成 VCD 风格的位串。
/// 位向量用 `to_bit_string()`（MSB→LSB 的 01xz 文本），再按 VCD 语义压缩前导重复态
/// （`xxxxxxxx` → `x`），与 JS 版保留的原始 VCD 文本形态一致。
fn value_bits(value: wellen::SignalValueRef<'_>) -> Option<String> {
    use wellen::SignalValueRef::*;
    match value {
        BitVec(_) => value.to_bit_string().map(|bits| compress_leading_state(&bits)),
        String(text) => Some(text.to_string()),
        Real(number) => Some(format_number(number)),
        Event => Some(std::string::String::new()),
    }
}

/// 把 wellen 补齐的全宽位串压回 VCD 原始短写形态（**仅用于 `edges` 的 from/to 字段**）。
///
/// wellen 一律按声明位宽展开（`b1x` → `0000001x`），而 CLI 的 `edges.from/to` 是对外契约：
/// 旧 JS 实现逐字保存 VCD 原文（`b1x` 就是 `1x`），下游按短写做零扩展。
///
/// **不能用在 `values`/`changes` 上**：那两个字段是给前端渲染用的固定宽度位串，
/// 压缩后 `binaryValue()` 会把单位宽 `x` 当成整条总线，拼出 `xxx1` 而不是 `00x1`。
///
/// 压缩规则（都是无损的）：
/// - 全 x / 全 z → 单字符（`xxxxxxxx` → `x`，VCD 规定单字符表示整条总线）；
/// - 其余情况去掉**前导 0**：VCD 的零扩展只补在左侧，前导 0 不含信息。
fn compress_vcd_short_form(bits: &str) -> String {
    let mut chars = bits.chars();
    let Some(first) = chars.next() else { return String::new() };
    if matches!(first, 'x' | 'z') && chars.clone().all(|character| character == first) {
        return first.to_string();
    }
    let trimmed = bits.trim_start_matches('0');
    if trimmed.is_empty() { "0".to_string() } else { trimmed.to_string() }
}

/// VCD 允许 `bx` 表示整条总线全 x；wellen 会展开成与位宽等长的字符。
/// 全部同态时压缩成单字符，与 JS 侧保存的原始位串形态一致。
fn compress_leading_state(bits: &str) -> String {
    let mut chars = bits.chars();
    let Some(first) = chars.next() else { return String::new() };
    if matches!(first, 'x' | 'z') && chars.all(|character| character == first) {
        return first.to_string();
    }
    bits.to_string()
}

/// 浮点按最短往返输出。注意：`values` 查询要求**保留 VCD 原文**（JS 存的是原文
/// `1.25e+3`，只在 `semanticValue` 比较时归一化），因此本函数只用于内部比较/展示，
/// 不用于 `bits` 字段。
fn format_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
    }
    format!("{}", value)
}

/// 位串解码：≤64 位且无 X/Z 时给出十六进制值，与 JS `decodedValue` 一致。
fn decoded(bits: &str, width: u32) -> (Option<String>, Option<String>) {
    if width == 0 || width > 64 || bits.is_empty() {
        return (None, None);
    }
    let lower = bits.to_ascii_lowercase();
    if !lower.chars().all(|c| c == '0' || c == '1') {
        // 含 X/Z：只给 hex 形式（低位 nibble 用小写 x/z 表示）
        let padded = pad_left(&lower, ((lower.len() + 3) / 4) * 4, lower.chars().next().unwrap_or('0'));
        let mut hex = String::from("0x");
        for chunk in padded.as_bytes().chunks(4) {
            let text = std::str::from_utf8(chunk).unwrap_or("0000");
            if text.contains('x') {
                hex.push('x');
            } else if text.contains('z') {
                hex.push('z');
            } else {
                let number = u32::from_str_radix(text, 2).unwrap_or(0);
                hex.push_str(&format!("{:X}", number));
            }
        }
        return (None, Some(hex));
    }
    let padded = pad_left(&lower, width as usize, '0');
    let number = u64::from_str_radix(&padded, 2).ok();
    number.map(|number| (Some(format!("0x{:0width$X}", number, width = ((width as usize) + 3) / 4)), None))
        .unwrap_or((None, None))
}
fn pad_left(text: &str, width: usize, fill: char) -> String {
    if text.len() >= width {
        return text.to_string();
    }
    let mut output = String::with_capacity(width);
    for _ in 0..(width - text.len()) {
        output.push(fill);
    }
    output.push_str(text);
    output
}

/// 打开波形的元数据快照（不求值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveOpenResult {
    pub file: String,
    pub format: String,
    pub timescale: String,
    pub end_time: String,
    pub event_count: usize,
    pub file_bytes: u64,
    pub headers: Vec<WaveHeaderEntry>,
    pub vars: Vec<WaveVar>,
    /// 扁平作用域表（索引即 `WaveVar.scopeId`），前端信号树按它建层级。
    pub scopes: Vec<header::DeclaredScope>,
    /// 未合并的原始 $var 声明表（供 JS 侧按 RTL 范围重建总线）。
    pub declarations: Vec<header::DeclaredVar>,
}

impl WaveTrace {
    pub fn snapshot(&self) -> WaveOpenResult {
        WaveOpenResult {
            file: self.file.clone(),
            format: self.format.clone(),
            timescale: self.timescale.clone(),
            end_time: self.end_time.to_string(),
            event_count: self.event_count,
            file_bytes: self.file_bytes,
            headers: self.headers.clone(),
            scopes: self.scopes.clone(),
            declarations: self.declarations.clone(),
            // 隐藏条目（取值回溯用）不进入对外的变量表。
            vars: self.vars.iter().filter(|var| !var.trace_only).cloned().collect(),
        }
    }
}

/// 时间点取值：对每个已解析信号按需加载，返回左闭取值。
/// 加载/解码同样经过第三方库，需捕获 panic（EVCD 等编码在读体阶段才暴露）。
pub fn values_at(
    session: &mut WaveSession,
    ids: &[&WaveVar],
    time: i64,
) -> WaveResult<Vec<(String, Option<WaveValue>)>> {
    // 先把需要的字段复制出来，避免闭包与可变借用冲突。
    // 逐位展开的单位变量要按 packedSource 回到原向量取整串再切位。
    let wanted: Vec<(String, String, u32, String, Option<PackedSource>)> = ids
        .iter()
        .map(|var| {
            (
                var.id.clone(),
                var.path.clone(),
                var.width,
                var.var_type.clone(),
                var.packed_source.clone(),
            )
        })
        .collect();
    let outcome = catch_library_panic(|| {
        // 需要加载的信号：单位变量取来源向量，普通信号取自身。
        let refs: Vec<SignalRef> = wanted
            .iter()
            .filter_map(|(id, _, _, _, packed)| {
                let target = packed.as_ref().map(|source| source.id.as_str()).unwrap_or(id);
                session.signal_ref(target)
            })
            .collect();
        session.load(&refs);
        let time_index = session.time_index_at(time as u64);
        let mut output = Vec::new();
        for (id, path, width, var_type, packed) in &wanted {
            let target = packed.as_ref().map(|source| source.id.as_str()).unwrap_or(id);
            let Some(signal_ref) = session.signal_ref(target) else {
                output.push((path.clone(), None));
                continue;
            };
            let Some(signal) = session.signal(signal_ref) else {
                output.push((path.clone(), None));
                continue;
            };
            let raw = time_index
                .and_then(|index| signal.get_offset(index))
                .map(|offset| signal.get_value_at(&offset, 0))
                .and_then(value_bits);
            // 逐位变量：从来源向量的位串里切出对应位。
            let value = match (&raw, packed) {
                (Some(bits), Some(source)) => {
                    let lower = bits.to_ascii_lowercase();
                    let fill = lower.chars().next().unwrap_or('0');
                    let padded = pad_left(&lower, source.width as usize, fill);
                    padded.chars().nth(source.position).map(|bit| bit.to_string())
                }
                (raw, None) => raw.clone(),
                _ => None,
            };
            let entry = value.map(|bits| {
                // bits 保留 wellen 展开的全宽位串（`b1x` → `0000001x`），只把「整条
                // 全 x / 全 z」压成单字符（VCD 允许 `bx` 表示整条总线未知）。
                //
                // 不能去掉前导 0：前端 `binaryValue()` 遇到首位是 x/z 时**整条都用该态填充**，
                // `001x` 存成 `1x` 会被扩成 `xxxx` 而不是 `001x`，X 态范围就丢了。
                let (decoded_value, hex) = decoded(&bits, *width);
                WaveValue { bits: Some(bits), width: *width, var_type: var_type.clone(), value: decoded_value, hex }
            });
            output.push((path.clone(), entry));
        }
        Ok::<_, WaveError>(output)
    });
    match outcome {
        Ok(result) => result,
        Err(detail) => Err(WaveError::new(
            "WAVE_FORMAT_UNSUPPORTED",
            format!("波形取值失败（含不支持的编码）：{}", detail),
        )),
    }
}


/// 窗口内一次跳变事件；`t` 是整数 tick 字符串。
#[derive(Debug, Clone, Serialize)]
pub struct WaveChange {
    pub t: String,
    pub bits: String,
}

/// 单信号窗口跳变序列；`total` 是窗口内全数，`next` 是下一页可直接使用的 `--from`。
#[derive(Debug, Clone, Serialize)]
pub struct WaveChangeSeries {
    pub path: String,
    pub width: u32,
    pub total: usize,
    pub next: Option<String>,
    pub events: Vec<WaveChange>,
}

/// 窗口下界判定：`from < 0` 表示「从首事件起」，必须包含 t=0 的事件。
/// 直接拿 `from as u64` 会因负数回绕而排除全部事件；这里返回 Option，
/// `None` 表示无下界（含最早事件），`Some(t)` 表示严格大于 t。
fn lower_bound(from: i64) -> Option<u64> {
    if from < 0 { None } else { Some(from as u64) }
}

/// 事件时刻是否落在窗口内：左开（或含首事件）+ 右闭。
fn in_window(time: u64, from: i64, to: u64) -> bool {
    time <= to && lower_bound(from).is_none_or(|bound| time > bound)
}

/// 取某信号在窗口内的事件；使用 wellen 的 time_indices 二分 + 逐索引取值。
fn changes_for(
    session: &mut WaveSession,
    var: &WaveVar,
    from: i64,
    to: i64,
    limit: usize,
) -> WaveResult<WaveChangeSeries> {
    let Some(signal_ref) = session.signal_ref(&var.id) else {
        return Ok(WaveChangeSeries { path: var.path.clone(), width: var.width, total: 0, next: None, events: Vec::new() });
    };
    session.load(&[signal_ref]);
    let Some(signal) = session.signal(signal_ref) else {
        return Ok(WaveChangeSeries { path: var.path.clone(), width: var.width, total: 0, next: None, events: Vec::new() });
    };
    // 窗口语义：from 为左开下界（JS 传 from-1 后的值），to 为闭区间上界。
    let indices: Vec<wellen::TimeTableIdx> = signal
        .iter_changes()
        .map(|(index, _)| index)
        .filter(|index| {
            let time = session.time_at(*index);
            in_window(time, from, to as u64)
        })
        .collect();
    let total = indices.len();
    let mut events = Vec::new();
    for index in indices.iter().take(limit) {
        let Some(offset) = signal.get_offset(*index) else { continue };
        let raw = value_bits(signal.get_value_at(&offset, 0)).unwrap_or_default();
        // 逐位变量：从源向量位串里切出该位（与 values_at 同一规则）。
        let bits = match &var.packed_source {
            Some(source) => {
                let lower = raw.to_ascii_lowercase();
                let fill = lower.chars().next().unwrap_or('0');
                let padded = pad_left(&lower, source.width as usize, fill);
                padded.chars().nth(source.position).map(|bit| bit.to_string()).unwrap_or(raw)
            }
            None => raw,
        };
        // changes 与 values 同口径：保留全宽位串（`compress_leading_state` 只在
        // `value_bits` 里处理「整条全 x/z」的压缩）。
        events.push(WaveChange { t: session.time_at(*index).to_string(), bits });
    }

    // next：下一页可直接使用的 --from（最后返回事件的 tick + 1），与 JS 一致。
    let next = if total > events.len() {
        events.last().map(|event| (event.t.parse::<i64>().unwrap_or(0) + 1).to_string())
    } else {
        None
    };
    Ok(WaveChangeSeries { path: var.path.clone(), width: var.width, total, next, events })
}

/// `changes_for` 的公开包装（napi 绑定层使用；内部仍走同一实现）。
pub fn changes_for_public(
    session: &mut WaveSession,
    var: &WaveVar,
    from: i64,
    to: i64,
    limit: usize,
) -> WaveResult<WaveChangeSeries> {
    changes_for(session, var, from, to, limit)
}

/// 按信号取位（LSB 起算 0），用于 `--bit` 投影。
fn bit_of(bits: &str, offset: u32) -> char {
    let lower: Vec<char> = bits.to_ascii_lowercase().chars().collect();
    let position = lower.len().checked_sub(1 + offset as usize);
    match position {
        Some(index) => lower[index],
        None => {
            // 位串短于位宽时按 VCD 语义向左补首位（全 x/z 补同态，否则 0）。
            let first = lower.first().copied().unwrap_or('0');
            if first == 'x' || first == 'z' { first } else { '0' }
        }
    }
}

/// 沿/未知态搜索：在窗口内枚举跳变并过滤，支持 `--bit` 位级投影。
pub fn edges(
    session: &mut WaveSession,
    var: &WaveVar,
    kind: &str,
    bit: Option<u32>,
    from: i64,
    to: i64,
    limit: usize,
) -> WaveResult<(usize, Option<String>, Vec<(String, String, String)>)> {
    let project = |bits: &str| -> String {
        match bit {
            Some(offset) => bit_of(bits, offset).to_string(),
            // edges 的 from/to 保留 VCD 短写（旧 JS 契约），不用固定宽度。
            None => compress_vcd_short_form(bits),
        }
    };
    let matches = |before: &str, after: &str| -> bool {
        match kind {
            "any" => true,
            "rise" => before == "0" && after == "1",
            "fall" => before == "1" && after == "0",
            "x" => after.contains('x'),
            "z" => after.contains('z'),
            _ => false,
        }
    };
    let Some(signal_ref) = session.signal_ref(&var.id) else {
        return Ok((0, None, Vec::new()));
    };
    session.load(&[signal_ref]);
    let all: Vec<(u64, String)> = {
        let Some(signal) = session.signal(signal_ref) else { return Ok((0, None, Vec::new())) };
        signal
            .iter_changes()
            .map(|(index, _)| index)
            .filter_map(|index| {
                let time = session.time_at(index);
                let offset = signal.get_offset(index)?;
                let bits = value_bits(signal.get_value_at(&offset, 0))?;
                Some((time, bits))
            })
            .collect()
    };
    let mut previous: Option<String> = None;
    let mut matched = 0usize;
    let mut events = Vec::new();
    let mut next = None;
    for (time, raw) in all {
        if time > to as u64 { break; }
        let current = project(&raw);
        if let Some(before) = previous.clone() {
            if before != current && matches(&before, &current) && in_window(time, from, to as u64) {
                matched += 1;
                if events.len() < limit {
                    events.push((time.to_string(), before, current.clone()));
                } else {
                    next = Some((time as i64 + 1).to_string());
                    break;
                }
            }
        }
        previous = Some(current);
    }
    Ok((matched, next, events))
}

/// 时钟沿采样：clock 必须 1 位标量，X/Z 不构成沿；返回每个命中沿的取值。
/// `conditions` 非空时只保留满足全部条件的沿（与 JS `--where` 语义一致：
/// 条件引用的信号即使不在输出列里也会被加载求值）。
pub fn sample(
    session: &mut WaveSession,
    clock: &WaveVar,
    edge: &str,
    ids: &[&WaveVar],
    conditions: &[ResolvedWhere],
    from: i64,
    to: i64,
    limit: usize,
) -> WaveResult<(usize, usize, Option<String>, Vec<(String, Vec<(String, Option<WaveValue>)>)>)> {
    if clock.width != 1 {
        return Err(WaveError::new("INVALID_ARGUMENT", "采样时钟必须是 1 位标量信号"));
    }
    let Some(clock_ref) = session.signal_ref(&clock.id) else {
        return Err(WaveError::new("SIGNAL_NOT_FOUND", format!("时钟信号不存在：{}", clock.path)));
    };
    // 先把时钟沿时刻收集出来，再按这些时刻取其它信号值。
    session.load(&[clock_ref]);
    let rising = |before: &str, after: &str| before == "0" && after == "1";
    let falling = |before: &str, after: &str| before == "1" && after == "0";
    let clock_changes: Vec<(u64, String)> = {
        let Some(signal) = session.signal(clock_ref) else {
            return Ok((0, 0, None, Vec::new()));
        };
        signal
            .iter_changes()
            .map(|(index, _)| index)
            .filter_map(|index| {
                let time = session.time_at(index);
                let offset = signal.get_offset(index)?;
                let bits = value_bits(signal.get_value_at(&offset, 0))?;
                Some((time, bits))
            })
            .collect()
    };
    let mut previous: Option<String> = None;
    let mut edge_times = Vec::new();
    for (time, bits) in clock_changes {
        if time > to as u64 { break; }
        if let Some(before) = previous.clone() {
            let hit = match edge {
                "rise" => rising(&before, &bits),
                "fall" => falling(&before, &bits),
                _ => rising(&before, &bits) || falling(&before, &bits),
            };
            if hit && in_window(time, from, to as u64) {
                edge_times.push(time);
            }
        }
        previous = Some(bits);
    }
    let scanned = edge_times.len();
    // 条件里引用的信号必须一并加载求值，即便它们不在输出列。
    let mut condition_ids: Vec<(String, u32)> = Vec::new();
    for condition in conditions {
        if !condition_ids.iter().any(|(id, _)| *id == condition.variable_id) {
            condition_ids.push((condition.variable_id.clone(), condition.variable_width));
        }
        if let Some((id, width)) = &condition.against {
            if !condition_ids.iter().any(|(existing, _)| existing == id) {
                condition_ids.push((id.clone(), *width));
            }
        }
    }
    let mut matched = 0usize;
    let mut next = None;
    let mut samples = Vec::new();
    for time in edge_times.iter() {
        // 命中判定只在实际消费该沿时才做：分页语义要求 matched 统计「被条件筛出的沿」。
        if !conditions.is_empty() {
            let raw = bits_at(session, &condition_ids, *time as i64);
            let values: HashMap<String, Option<String>> = raw.into_iter().collect();
            if !evaluate_where(conditions, &values) {
                continue;
            }
        }
        matched += 1;
        if samples.len() >= limit {
            next = Some((*time as i64 + 1).to_string());
            break;
        }
        let values = values_at(session, ids, *time as i64)?;
        samples.push((time.to_string(), values));
    }
    Ok((scanned, matched, next, samples))
}

/// `--where` 受限条件：`信号 op [字面量]`，op ∈ == != contains-x contains-z。
#[derive(Debug, Clone)]
pub struct WaveWhere {
    pub name: String,
    pub operator: String,
    pub literal: Option<String>,
}

/// 与 JS `parseWhere` 一致：名称取第一个「空白 + 运算符」之前的部分，运算符后可带字面量。
/// `contains-x` / `contains-z` 不需要字面量，`==` / `!=` 必须给。
pub fn parse_where(text: &str) -> WaveResult<WaveWhere> {
    const OPERATORS: [&str; 4] = ["==", "!=", "contains-x", "contains-z"];
    let text = text.trim();
    let bytes = text.as_bytes();
    let mut found: Option<(usize, usize, &str)> = None;
    for index in 1..bytes.len() {
        if !bytes[index].is_ascii_whitespace() {
            continue;
        }
        let mut cursor = index;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        for operator in OPERATORS {
            if text[cursor..].starts_with(operator) {
                found = Some((index, cursor + operator.len(), operator));
                break;
            }
        }
        if found.is_some() {
            break;
        }
    }
    let Some((name_end, literal_start, operator)) = found else {
        return Err(WaveError::new(
            "INVALID_ARGUMENT",
            format!("--where 格式无效：{}（示例 \"dut.q != 8'hA5\" 或 \"dut.bus contains-x\"）", text),
        ));
    };
    let name = text[..name_end].trim().to_string();
    if name.is_empty() {
        return Err(WaveError::new("INVALID_ARGUMENT", format!("--where 缺少信号名：{}", text)));
    }
    let literal = {
        let rest = text[literal_start..].trim();
        if rest.is_empty() { None } else { Some(rest.to_string()) }
    };
    if literal.is_none() && !operator.starts_with("contains") {
        return Err(WaveError::new(
            "INVALID_ARGUMENT",
            format!("--where 缺少字面量：{}（示例 \"dut.q != 8'hA5\"）", text),
        ));
    }
    Ok(WaveWhere { name, operator: operator.to_string(), literal })
}

/// 十进制字符串 → 二进制位串（不引入大整数依赖：逐位除以 2）。
fn decimal_to_bits(digits: &str) -> String {
    let mut number: Vec<u8> = digits.bytes().map(|byte| byte - b'0').collect();
    if number.iter().all(|digit| *digit == 0) {
        return "0".to_string();
    }
    let mut bits = Vec::new();
    while number.iter().any(|digit| *digit != 0) {
        let mut carry = 0u32;
        for digit in number.iter_mut() {
            let current = carry * 10 + *digit as u32;
            *digit = (current / 2) as u8;
            carry = current % 2;
        }
        bits.push(if carry == 0 { '0' } else { '1' });
    }
    bits.iter().rev().collect()
}

/// 字面量 → 定宽位串。支持 `0b` / `0x` / 十进制 / SV 的 `<宽>'<h|b|d><值>`。
/// 超出信号位宽时报 INVALID_ARGUMENT（与 JS 合同一致）。
pub fn literal_bits(literal: &str, width: u32) -> WaveResult<String> {
    let text: String = literal.chars().filter(|character| !character.is_whitespace()).collect();
    let lower = text.to_ascii_lowercase();
    let mut bits: Option<String> = None;
    // SV 风格：`8'hA5` / `4'b1010` / `8'd12`
    if let Some(quote) = lower.find('\'') {
        let radix = lower[quote + 1..].chars().next();
        let digits: String = lower[quote + 2..].chars().filter(|c| *c != '_').collect();
        match radix {
            Some('b') if digits.chars().all(|c| c == '0' || c == '1') && !digits.is_empty() => {
                let trimmed = digits.trim_start_matches('0');
                bits = Some(if trimmed.is_empty() { "0".to_string() } else { trimmed.to_string() });
            }
            Some('h') if digits.chars().all(|c| c.is_ascii_hexdigit()) && !digits.is_empty() => {
                let trimmed = digits.trim_start_matches('0');
                let body = if trimmed.is_empty() { "0" } else { trimmed };
                let mut out = String::new();
                for character in body.chars() {
                    let nibble = character.to_digit(16).unwrap_or(0);
                    out.push_str(&format!("{:04b}", nibble));
                }
                let trimmed_bits = out.trim_start_matches('0');
                bits = Some(if trimmed_bits.is_empty() { "0".to_string() } else { trimmed_bits.to_string() });
            }
            Some('d') if digits.chars().all(|c| c.is_ascii_digit()) && !digits.is_empty() => {
                bits = Some(decimal_to_bits(&digits));
            }
            _ => {}
        }
    } else if let Some(rest) = lower.strip_prefix("0b") {
        let digits: String = rest.chars().filter(|c| *c != '_').collect();
        if !digits.is_empty() && digits.chars().all(|c| c == '0' || c == '1') {
            let trimmed = digits.trim_start_matches('0');
            bits = Some(if trimmed.is_empty() { "0".to_string() } else { trimmed.to_string() });
        }
    } else if let Some(rest) = lower.strip_prefix("0x") {
        let digits: String = rest.chars().filter(|c| *c != '_').collect();
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_hexdigit()) {
            let trimmed = digits.trim_start_matches('0');
            let body = if trimmed.is_empty() { "0" } else { trimmed };
            let mut out = String::new();
            for character in body.chars() {
                out.push_str(&format!("{:04b}", character.to_digit(16).unwrap_or(0)));
            }
            let trimmed_bits = out.trim_start_matches('0');
            bits = Some(if trimmed_bits.is_empty() { "0".to_string() } else { trimmed_bits.to_string() });
        }
    } else {
        let digits: String = lower.chars().filter(|c| *c != '_').collect();
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            bits = Some(decimal_to_bits(&digits));
        }
    }
    let Some(bits) = bits else {
        return Err(WaveError::new(
            "INVALID_ARGUMENT",
            format!("--where 字面量无效：{}（支持 0b/0x/十进制与 8'hA5 风格）", literal),
        ));
    };
    if bits.len() > width as usize {
        let mut error = WaveError::new(
            "INVALID_ARGUMENT",
            format!("--where 字面量超过信号位宽 {}", width),
        );
        error.candidates = Vec::new();
        return Err(error);
    }
    Ok(format!("{:0>width$}", bits, width = width.max(1) as usize))
}

/// 与 JS `model.binaryValue` 一致：非法字符返回 None；短于位宽时按首位态左扩。
pub fn binary_value(bits: Option<&str>, width: u32) -> Option<String> {
    let raw = bits?.to_ascii_lowercase();
    if raw.is_empty() || !raw.chars().all(|character| matches!(character, '0' | '1' | 'x' | 'z')) {
        return None;
    }
    let fill = match raw.chars().next() {
        Some('x') => 'x',
        Some('z') => 'z',
        _ => '0',
    };
    Some(pad_left(&raw, width.max(1) as usize, fill))
}

/// 已解析的 where 条件：右值可以是字面量，也可以是同文件内另一个信号。
#[derive(Debug, Clone)]
pub struct ResolvedWhere {
    pub variable_id: String,
    pub variable_width: u32,
    pub operator: String,
    /// 字面量已按信号位宽规范化；信号对信号比较时为 None。
    pub expected: Option<String>,
    pub against: Option<(String, u32)>,
}

/// 把条件里的信号名/右值解析成 id。右值唯一命中一个信号时按「信号对信号」比较，
/// 否则按字面量解析——与 JS `sample` 的判定顺序一致。
pub fn resolve_where(
    vars: &[WaveVar],
    conditions: &[WaveWhere],
) -> WaveResult<Vec<ResolvedWhere>> {
    let mut resolved = Vec::new();
    for condition in conditions {
        let picked = resolve_ids(vars, &[condition.name.as_str()])?;
        let variable = picked[0];
        let mut against = None;
        if let Some(literal) = &condition.literal {
            let exact: Vec<&WaveVar> = vars.iter().filter(|var| var.path == *literal).collect();
            let loose: Vec<&WaveVar> = vars
                .iter()
                .filter(|var| var.path.ends_with(&format!(".{}", literal)) || var.name == *literal)
                .collect();
            let matches = if exact.len() == 1 {
                Some(exact[0])
            } else if loose.len() == 1 {
                Some(loose[0])
            } else if exact.len() + loose.len() > 1 {
                let candidates: Vec<String> = exact
                    .iter()
                    .chain(loose.iter())
                    .map(|var| var.path.clone())
                    .take(20)
                    .collect();
                return Err(WaveError::new(
                    "SIGNAL_NOT_FOUND",
                    format!("--where 右值匹配多个信号，请使用完整路径：{}", literal),
                )
                .with_candidates(candidates));
            } else {
                None
            };
            if let Some(matched) = matches {
                against = Some((matched.id.clone(), matched.width));
            }
        }
        let expected = match (&against, &condition.literal) {
            (None, Some(literal)) => Some(literal_bits(literal, variable.width)?),
            _ => None,
        };
        resolved.push(ResolvedWhere {
            variable_id: variable.id.clone(),
            variable_width: variable.width,
            operator: condition.operator.clone(),
            expected,
            against,
        });
    }
    Ok(resolved)
}

/// 条件求值：`values` 是 id → 原始位串。任一条件不满足即 false。
pub fn evaluate_where(
    conditions: &[ResolvedWhere],
    values: &HashMap<String, Option<String>>,
) -> bool {
    for condition in conditions {
        let raw = values.get(&condition.variable_id).and_then(|value| value.as_deref());
        let bits = binary_value(raw, condition.variable_width);
        match condition.operator.as_str() {
            "contains-x" => {
                if !bits.is_some_and(|value| value.contains('x')) {
                    return false;
                }
            }
            "contains-z" => {
                if !bits.is_some_and(|value| value.contains('z')) {
                    return false;
                }
            }
            operator => {
                let equal = match &condition.against {
                    // 信号对信号：各自按位宽规范化后逐位比较，X/Z 参与比较而非通配。
                    Some((against_id, against_width)) => {
                        let other = values.get(against_id).and_then(|value| value.as_deref());
                        let other_bits = binary_value(other, *against_width);
                        bits.is_some() && other_bits.is_some() && bits == other_bits
                    }
                    None => match &condition.expected {
                        Some(expected) => {
                            bits.is_some() && binary_value(Some(expected.as_str()), condition.variable_width) == bits
                        }
                        None => false,
                    },
                };
                if equal != (operator == "==") {
                    return false;
                }
            }
        }
    }
    true
}

/// 按 id 取某时刻的原始位串（不构造解码值），供 where 求值与采样复用。
fn bits_at(
    session: &mut WaveSession,
    wanted: &[(String, u32)],
    time: i64,
) -> Vec<(String, Option<String>)> {
    let refs: Vec<SignalRef> = wanted
        .iter()
        .filter_map(|(id, _)| session.signal_ref(id))
        .collect();
    session.load(&refs);
    let time_index = session.time_index_at(time.max(0) as u64);
    wanted
        .iter()
        .map(|(id, _)| {
            let value = session
                .signal_ref(id)
                .and_then(|signal_ref| session.signal(signal_ref))
                .and_then(|signal| {
                    time_index
                        .and_then(|index| signal.get_offset(index))
                        .map(|offset| signal.get_value_at(&offset, 0))
                })
                .and_then(value_bits);
            (id.clone(), value)
        })
        .collect()
}

/// 单个信号在一份波形里的完整事件序列（tick + 原始位串），供 diff 双指针推进。
fn event_series(session: &mut WaveSession, var: &WaveVar) -> Vec<(u64, String)> {
    let Some(signal_ref) = session.signal_ref(&var.id) else { return Vec::new() };
    session.load(&[signal_ref]);
    let Some(signal) = session.signal(signal_ref) else { return Vec::new() };
    signal
        .iter_changes()
        .map(|(index, _)| index)
        .filter_map(|index| {
            let time = session.time_at(index);
            let offset = signal.get_offset(index)?;
            let bits = value_bits(signal.get_value_at(&offset, 0))?;
            Some((time, bits))
        })
        .collect()
}

/// 两份波形同名信号逐对比较：返回首差异、差异条数、涉差信号数、是否截断。
///
/// 语义对照 JS 版 `diff`：以 `from` 时刻的「≤ from 的最后一次取值」为初始状态，
/// 然后双指针按时刻合并推进，只在「相同→不同」的跳变处记一条差异（不重复计持续差异）。
#[derive(Debug, Clone, Serialize)]
pub struct WaveDiffEntry {
    pub path: String,
    pub t: String,
    #[serde(rename = "a")]
    pub value_a: Option<String>,
    #[serde(rename = "b")]
    pub value_b: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WaveDiffOutcome {
    pub pairs: usize,
    pub total_diffs: usize,
    pub differing_signals: usize,
    pub truncated: bool,
    pub first: Option<WaveDiffEntry>,
    pub entries: Vec<WaveDiffEntry>,
}

/// 单对信号的比较预算：与 JS 一样按对数均分总量，再给每对补 1000 条余量。
const MAX_DIFF_EVENTS: usize = 2_000_000;

/// diff 的配对键：path + 向量 range。
/// 单位宽的下标已在 path 里（`bits[7]`），多位向量在 `range` 字段（`[7:0]`），
/// 拼起来与 JS 版 `path + (range || '')` 结果一致。
fn diff_key(var: &WaveVar) -> String {
    format!("{}{}", var.path, var.range.clone().unwrap_or_default())
}

/// 构造一条差异记录。
///
/// `a`/`b` 用 VCD 短写（`1x` 而不是 `0000001x`）：CLI 的 `wave.diff` 是对外契约，
/// 旧 JS 实现逐字保存原文，调用方按短写比较。`values`/`changes` 则保留全宽，
/// 供前端按位宽做位投影——两条路径的口径不同，不要混用。
fn diff_entry(var: &WaveVar, time: u64, value_a: &Option<String>, value_b: &Option<String>) -> WaveDiffEntry {
    WaveDiffEntry {
        path: diff_key(var),
        t: time.to_string(),
        value_a: value_a.as_deref().map(compress_vcd_short_form),
        value_b: value_b.as_deref().map(compress_vcd_short_form),
    }
}

pub fn diff_pair_series(
    keys: &[(WaveVar, WaveVar)],
    series_a: &[Vec<(u64, String)>],
    series_b: &[Vec<(u64, String)>],
    from: i64,
    to: i64,
    limit: usize,
) -> WaveDiffOutcome {
    let start = from.max(0) as u64;
    let mut entries = Vec::new();
    let mut first: Option<WaveDiffEntry> = None;
    let mut total_diffs = 0usize;
    let mut differing_signals = 0usize;
    let mut truncated = false;

    for ((var_a, var_b), (events_a, events_b)) in keys
        .iter()
        .zip(series_a.iter().zip(series_b.iter()))
    {
        // 初始值：≤ from 的最后一次事件（JS 用 upperBound(from) - 1）。
        let mut index_a = events_a.partition_point(|(time, _)| *time <= start) as isize - 1;
        let mut index_b = events_b.partition_point(|(time, _)| *time <= start) as isize - 1;
        let mut value_a = if index_a >= 0 { Some(events_a[index_a as usize].1.clone()) } else { None };
        let mut value_b = if index_b >= 0 { Some(events_b[index_b as usize].1.clone()) } else { None };
        let width = var_a.width.max(var_b.width);
        let differs = |a: &Option<String>, b: &Option<String>| {
            binary_value(a.as_deref(), width) != binary_value(b.as_deref(), width)
        };
        let mut differing = differs(&value_a, &value_b);
        let mut had_difference = differing;
        let mut budget = MAX_DIFF_EVENTS / keys.len().max(1) + 1000;

        if differing {
            total_diffs += 1;
            let entry = diff_entry(var_a, start, &value_a, &value_b);
            if first.is_none() {
                first = Some(entry.clone());
            }
            if entries.len() < limit {
                entries.push(entry);
            }
        }

        while budget > 0 {
            budget -= 1;
            let time_a = events_a
                .get((index_a + 1) as usize)
                .map(|(time, _)| *time)
                .unwrap_or(u64::MAX);
            let time_b = events_b
                .get((index_b + 1) as usize)
                .map(|(time, _)| *time)
                .unwrap_or(u64::MAX);
            let time = time_a.min(time_b);
            if time == u64::MAX || time > to as u64 {
                break;
            }
            if time_a == time {
                index_a += 1;
                value_a = Some(events_a[index_a as usize].1.clone());
            }
            if time_b == time {
                index_b += 1;
                value_b = Some(events_b[index_b as usize].1.clone());
            }
            let now_differing = differs(&value_a, &value_b);
            if now_differing != differing {
                if now_differing {
                    total_diffs += 1;
                    had_difference = true;
                    let entry = diff_entry(var_a, time, &value_a, &value_b);
                    if first.is_none() {
                        first = Some(entry.clone());
                    }
                    if entries.len() < limit {
                        entries.push(entry);
                    }
                }
                differing = now_differing;
            }
        }
        if had_difference {
            differing_signals += 1;
        }
        if budget == 0 {
            truncated = true;
        }
    }

    WaveDiffOutcome { pairs: keys.len(), total_diffs, differing_signals, truncated, first, entries }
}

/// `diff` 的完整入口：打开两份波形，按同名（路径 + range 后缀）配对后逐对比较。
pub fn diff_files(
    file_a: &Path,
    file_b: &Path,
    signals: Option<&str>,
    from: i64,
    to: Option<i64>,
    limit: usize,
) -> WaveResult<(WaveDiffOutcome, String, String, i64, String, String)> {
    let mut session_a = WaveSession::open(file_a)?;
    let mut session_b = WaveSession::open(file_b)?;
    let keys = pair_signals(&session_a.trace.vars, &session_b.trace.vars, signals)?;
    let end = session_a.trace.end_time.min(session_b.trace.end_time);
    let to = to.unwrap_or(end);
    if from >= to {
        return Err(WaveError::new("INVALID_ARGUMENT", "--from 必须早于 --to"));
    }
    let series_a: Vec<Vec<(u64, String)>> = keys.iter().map(|(var, _)| event_series(&mut session_a, var)).collect();
    let series_b: Vec<Vec<(u64, String)>> = keys.iter().map(|(_, var)| event_series(&mut session_b, var)).collect();
    let outcome = diff_pair_series(&keys, &series_a, &series_b, from, to, limit);
    Ok((
        outcome,
        session_a.trace.file.clone(),
        session_b.trace.file.clone(),
        to,
        session_a.trace.timescale.clone(),
        session_b.trace.timescale.clone(),
    ))
}

/// 按「路径 + range 后缀」配对两份波形的同名信号；`signals` 非空时只保留指定名
/// （支持完整路径或唯一后缀/短名，range 后缀在匹配时剥离）。
fn pair_signals(
    vars_a: &[WaveVar],
    vars_b: &[WaveVar],
    signals: Option<&str>,
) -> WaveResult<Vec<(WaveVar, WaveVar)>> {
    let key_of = diff_key;
    let index_b: HashMap<String, &WaveVar> =
        vars_b.iter().map(|var| (key_of(var), var)).collect();
    let mut keys: Vec<(WaveVar, WaveVar)> = vars_a
        .iter()
        .filter_map(|var| index_b.get(&key_of(var)).map(|other| (var.clone(), (*other).clone())))
        .collect();
    if let Some(text) = signals {
        let wanted: Vec<String> = text
            .split(',')
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect();
        let strip = |key: &str| -> String {
            match key.rfind('[') {
                Some(index) if key.ends_with(']') => key[..index].to_string(),
                _ => key.to_string(),
            }
        };
        keys.retain(|(var, _)| {
            let key = key_of(var);
            let short = strip(&key);
            wanted.iter().any(|name| {
                *name == key
                    || *name == short
                    || short == *name
                    || short.ends_with(&format!(".{}", name))
            })
        });
        if keys.is_empty() {
            return Err(WaveError::new(
                "SIGNAL_NOT_FOUND",
                "两份 VCD 中没有可比对的指定信号",
            ));
        }
    }
    if keys.is_empty() {
        return Err(WaveError::new("SIGNAL_NOT_FOUND", "两份 VCD 没有同名信号可比较"));
    }
    Ok(keys)
}

/// 视窗像素桶降采样结果的一个桶：时间范围与桶内事件数，供面板画「密集」标记。
#[derive(Debug, Clone, Serialize)]
pub struct WaveDense {
    pub start: String,
    pub end: String,
    pub count: usize,
}

/// 单信号视窗序列：`changes` 是保留的事件（每桶首/末），`dense` 是折叠掉的桶。
#[derive(Debug, Clone, Serialize)]
pub struct WaveWindowSeries {
    pub id: String,
    pub changes: Vec<WaveChange>,
    pub dense: Vec<WaveDense>,
}

/// 视窗降采样：把 `[start, end]` 切成 `pixels` 个桶，每桶只保留首末事件；
/// 桶内事件数 > 2 时记一条 dense 标记（渲染器据此画「密集」底纹）。
///
/// 语义严格对照 JS `VcdStore.window`：
/// - 先补一个「≤ start 的最后事件」作为窗口起点值；
/// - `start == end` 时只有起点值，不产生任何桶；
/// - 最后一个桶的右边界是 `end`（闭区间），其余按线性刻度切分。
pub fn window_series(
    session: &mut WaveSession,
    ids: &[&WaveVar],
    start: i64,
    end: i64,
    pixels: usize,
) -> WaveResult<Vec<WaveWindowSeries>> {
    if end < start {
        return Err(WaveError::new("INVALID_ARGUMENT", "视窗范围无效：end 必须不早于 start"));
    }
    if pixels == 0 {
        return Err(WaveError::new("INVALID_ARGUMENT", "像素数必须为正整数"));
    }
    let start_time = start.max(0) as u64;
    let end_time = end.max(0) as u64;
    let mut series = Vec::with_capacity(ids.len());
    for var in ids {
        let mut changes: Vec<WaveChange> = Vec::new();
        let mut dense: Vec<WaveDense> = Vec::new();
        let Some(signal_ref) = session.signal_ref(&var.id) else {
            series.push(WaveWindowSeries { id: var.id.clone(), changes, dense });
            continue;
        };
        session.load(&[signal_ref]);
        let Some(signal) = session.signal(signal_ref) else {
            series.push(WaveWindowSeries { id: var.id.clone(), changes, dense });
            continue;
        };
        // 事件索引与时刻一次性取出：桶切分需要按时刻二分，逐次 get_offset 会重复走链。
        let events: Vec<(u64, String)> = signal
            .iter_changes()
            .map(|(index, _)| index)
            .filter_map(|index| {
                let time = session.time_at(index);
                let offset = signal.get_offset(index)?;
                let bits = value_bits(signal.get_value_at(&offset, 0))?;
                Some((time, bits))
            })
            .collect();
        let upper_bound = |time: u64| -> usize { events.partition_point(|(t, _)| *t <= time) };
        let push = |changes: &mut Vec<WaveChange>, index: usize| {
            changes.push(WaveChange { t: events[index].0.to_string(), bits: events[index].1.clone() });
        };
        let mut left = upper_bound(start_time);
        if left > 0 {
            push(&mut changes, left - 1);
        }
        if end_time != start_time {
            let span = (end_time - start_time) as f64;
            for bucket in 0..pixels {
                let boundary = if bucket == pixels - 1 {
                    end_time
                } else {
                    start_time + (span * (bucket + 1) as f64 / pixels as f64) as u64
                };
                let right = upper_bound(boundary);
                let count = right.saturating_sub(left);
                if count > 0 {
                    push(&mut changes, left);
                    if count > 1 {
                        push(&mut changes, right - 1);
                        if count > 2 {
                            dense.push(WaveDense {
                                start: events[left].0.to_string(),
                                end: events[right - 1].0.to_string(),
                                count,
                            });
                        }
                    }
                }
                left = right;
            }
        }
        series.push(WaveWindowSeries { id: var.id.clone(), changes, dense });
    }
    Ok(series)
}

/// 边沿查询：`next`/`previous` 方向，支持按位/位段投影与续查。
///
/// 语义对照 JS `VcdStore.edge`：返回「相对上一刻发生变化的那个事件」，
/// `previous` 方向要跳过与查询时刻同刻的事件（严格早于 time）。
#[derive(Debug, Clone, Serialize)]
pub struct WaveEdgeHit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation: Option<usize>,
}

/// 单次边沿查询的最大扫描事件数（与 JS `maxBitEdgeScan / bitWidth` 同量级保护）。
const MAX_BIT_EDGE_SCAN: usize = 1_000_000;

pub fn edge_hit(
    session: &mut WaveSession,
    var: &WaveVar,
    time: i64,
    direction: &str,
    bit_offset: Option<u32>,
    bit_width: u32,
) -> WaveResult<WaveEdgeHit> {
    let next = matches!(direction, "next" | "forward");
    let previous = matches!(direction, "previous" | "backward");
    if !next && !previous {
        return Err(WaveError::new("INVALID_ARGUMENT", "边沿方向必须为 next 或 previous"));
    }
    let Some(signal_ref) = session.signal_ref(&var.id) else {
        return Ok(WaveEdgeHit { time: None, value: None, continuation: None });
    };
    session.load(&[signal_ref]);
    let Some(signal) = session.signal(signal_ref) else {
        return Ok(WaveEdgeHit { time: None, value: None, continuation: None });
    };
    let events: Vec<(u64, String)> = signal
        .iter_changes()
        .map(|(index, _)| index)
        .filter_map(|index| {
            let time = session.time_at(index);
            let offset = signal.get_offset(index)?;
            let bits = value_bits(signal.get_value_at(&offset, 0))?;
            Some((time, bits))
        })
        .collect();
    let time_value = time.max(0) as u64;
    let mut cursor = events.partition_point(|(t, _)| *t <= time_value) as isize;
    if previous {
        cursor -= 1;
        if cursor >= 0 && events[cursor as usize].0 == time_value {
            cursor -= 1;
        }
    }
    let project = |bits: &str| -> String {
        match bit_offset {
            Some(offset) => {
                let lower: Vec<char> = bits.to_ascii_lowercase().chars().collect();
                let from = lower.len().checked_sub(1 + offset as usize + bit_width as usize - 1);
                match from {
                    Some(start) => lower[start..start + bit_width as usize].iter().collect(),
                    None => {
                        let first = lower.first().copied().unwrap_or('0');
                        let fill = if first == 'x' || first == 'z' { first } else { '0' };
                        std::iter::repeat_n(fill, bit_width as usize).collect()
                    }
                }
            }
            None => bits.to_string(),
        }
    };
    if cursor < 0 || cursor as usize >= events.len() {
        return Ok(WaveEdgeHit { time: None, value: None, continuation: None });
    }
    // 无位投影时直接返回该事件：VCD 只在值变化时产生事件，候选必然是一次变化
    // （与 JS `edge` 的非投影分支一致，不做同值比较）。
    if bit_offset.is_none() {
        return Ok(WaveEdgeHit {
            time: Some(events[cursor as usize].0.to_string()),
            value: Some(events[cursor as usize].1.clone()),
            continuation: None,
        });
    }
    // 位投影：向量整体变化不代表所投影的位段变化，必须逐事件比较。
    let at_index = events.partition_point(|(t, _)| *t <= time_value) as isize - 1;
    let initial = if at_index >= 0 { project(&events[at_index as usize].1) } else { String::new() };
    let step: isize = if next { 1 } else { -1 };
    let mut scanned = 0usize;
    loop {
        if cursor < 0 || cursor as usize >= events.len() {
            return Ok(WaveEdgeHit { time: None, value: None, continuation: None });
        }
        if scanned >= MAX_BIT_EDGE_SCAN {
            return Ok(WaveEdgeHit { time: None, value: None, continuation: Some(cursor as usize) });
        }
        scanned += 1;
        let value = project(&events[cursor as usize].1);
        let before = if next {
            initial.clone()
        } else {
            let previous_index = cursor - 1;
            if previous_index >= 0 { project(&events[previous_index as usize].1) } else { String::new() }
        };
        if value != before {
            return Ok(WaveEdgeHit {
                time: Some(events[cursor as usize].0.to_string()),
                value: Some(value),
                continuation: None,
            });
        }
        cursor += step;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_parsing_matches_js_contract() {
        let parsed = parse_where("dut.q != 8'hA5").expect("信号对字面量");
        assert_eq!(parsed.name, "dut.q");
        assert_eq!(parsed.operator, "!=");
        assert_eq!(parsed.literal.as_deref(), Some("8'hA5"));
        // contains-x/z 不需要字面量
        let parsed = parse_where("tb.bus contains-x").expect("contains 无字面量");
        assert_eq!(parsed.operator, "contains-x");
        assert_eq!(parsed.literal, None);
        // == / != 缺字面量必须报错
        assert_eq!(parse_where("a.b ==").unwrap_err().code, "INVALID_ARGUMENT");
        // 无运算符
        assert_eq!(parse_where("just_a_name").unwrap_err().code, "INVALID_ARGUMENT");
        // 信号名含点、字面量含空格
        let parsed = parse_where("tb.u_dut.state  ==  4'b1010").expect("多重空白");
        assert_eq!(parsed.name, "tb.u_dut.state");
        assert_eq!(parsed.literal.as_deref(), Some("4'b1010"));
    }

    #[test]
    fn literal_parsing_accepts_all_radixes_and_rejects_overflow() {
        assert_eq!(literal_bits("8'hA5", 8).expect("SV hex"), "10100101");
        assert_eq!(literal_bits("0xA5", 8).expect("0x"), "10100101");
        assert_eq!(literal_bits("0b1010", 4).expect("0b"), "1010");
        assert_eq!(literal_bits("165", 8).expect("decimal"), "10100101");
        assert_eq!(literal_bits("4'd12", 4).expect("SV decimal"), "1100");
        assert_eq!(literal_bits("0", 4).expect("zero"), "0000");
        // 下划线分隔
        assert_eq!(literal_bits("16'hFF_00", 16).expect("underscores"), "1111111100000000");
        // 超位宽
        assert_eq!(literal_bits("0x1FF", 8).unwrap_err().code, "INVALID_ARGUMENT");
        // 非法字面量
        assert_eq!(literal_bits("0b102", 8).unwrap_err().code, "INVALID_ARGUMENT");
    }

    #[test]
    fn binary_value_pads_by_leading_state() {
        // 首位是 x/z 时用同态扩展，否则补 0（与 JS model.binaryValue 一致）
        assert_eq!(binary_value(Some("1"), 4).as_deref(), Some("0001"));
        assert_eq!(binary_value(Some("x1"), 4).as_deref(), Some("xxx1"));
        assert_eq!(binary_value(Some("z"), 4).as_deref(), Some("zzzz"));
        assert_eq!(binary_value(Some("10"), 4).as_deref(), Some("0010"));
        // 非法字符
        assert_eq!(binary_value(Some("12ab"), 4), None);
        assert_eq!(binary_value(None, 4), None);
    }

    #[test]
    fn diff_counts_only_transitions_into_difference() {
        // A: 0→1→2→3，B: 0→1→9→3。持续不同只记一次，回到相同后再次分开才再记。
        let vars = [
            WaveVar { id: "1".into(), path: "tb.q".into(), name: "q".into(), scope: "tb".into(), scope_id: None, width: 8, var_type: "wire".into(), range: None, msb: None, lsb: None, change_count: 0, packed_source: None, trace_only: false },
        ];
        let keys: Vec<(WaveVar, WaveVar)> = vec![(vars[0].clone(), vars[0].clone())];
        let series_a = vec![vec![
            (0u64, "0".to_string()),
            (10, "1".into()),
            (20, "10".into()),
            (30, "11".into()),
        ]];
        let series_b = vec![vec![
            (0, "0".into()),
            (10, "1".into()),
            (20, "1001".into()),
            (30, "11".into()),
        ]];
        let outcome = diff_pair_series(&keys, &series_a, &series_b, 0, 30, 50);
        assert_eq!(outcome.pairs, 1);
        // t=20 开始不同（2 vs 9），t=30 又相同 → 只记 1 条
        assert_eq!(outcome.total_diffs, 1, "持续差异只记一次");
        assert_eq!(outcome.differing_signals, 1);
        assert_eq!(outcome.first.as_ref().map(|entry| entry.t.as_str()), Some("20"));
        assert_eq!(outcome.entries.len(), 1);
    }

    #[test]
    fn diff_reports_initial_mismatch_at_from_time() {
        // 起点就不同：JS 在 from 时刻记一条，即使之后从未发生跳变。
        let vars = [WaveVar { id: "1".into(), path: "tb.q".into(), name: "q".into(), scope: "tb".into(), scope_id: None, width: 4, var_type: "wire".into(), range: None, msb: None, lsb: None, change_count: 0, packed_source: None, trace_only: false }];
        let keys: Vec<(WaveVar, WaveVar)> = vec![(vars[0].clone(), vars[0].clone())];
        let series_a = vec![vec![(0u64, "0001".into())]];
        let series_b = vec![vec![(0u64, "0010".into())]];
        let outcome = diff_pair_series(&keys, &series_a, &series_b, 0, 100, 50);
        assert_eq!(outcome.total_diffs, 1, "起点差异必须计入");
        assert_eq!(outcome.first.as_ref().map(|entry| entry.t.as_str()), Some("0"));
        // 相同内容不应报差异
        let same = diff_pair_series(&keys, &series_a, &series_a, 0, 100, 50);
        assert_eq!(same.total_diffs, 0);
        assert_eq!(same.differing_signals, 0);
        assert!(same.first.is_none());
    }

    #[test]
    fn where_evaluation_supports_literal_signal_and_contains() {
        let vars = [
            WaveVar { id: "1".into(), path: "tb.dout".into(), name: "dout".into(), scope: "tb".into(), scope_id: None, width: 8, var_type: "wire".into(), range: None, msb: None, lsb: None, change_count: 0, packed_source: None, trace_only: false },
            WaveVar { id: "2".into(), path: "tb.model".into(), name: "model".into(), scope: "tb".into(), scope_id: None, width: 8, var_type: "wire".into(), range: None, msb: None, lsb: None, change_count: 0, packed_source: None, trace_only: false },
        ];
        // 字面量比较
        let conditions = resolve_where(&vars, &[parse_where("tb.dout != 8'hA5").unwrap()]).unwrap();
        let mut values = HashMap::new();
        values.insert("1".to_string(), Some("10100100".to_string()));
        assert!(evaluate_where(&conditions, &values), "0xA4 != 0xA5");
        values.insert("1".to_string(), Some("10100101".to_string()));
        assert!(!evaluate_where(&conditions, &values), "0xA5 == 0xA5 应不满足 !=");

        // 信号对信号：右值是唯一命中信号时按信号比较
        let conditions = resolve_where(&vars, &[parse_where("tb.dout != tb.model").unwrap()]).unwrap();
        assert!(conditions[0].against.is_some(), "唯一命中的右值应按信号比较");
        let mut values = HashMap::new();
        values.insert("1".to_string(), Some("10100100".to_string()));
        values.insert("2".to_string(), Some("10100101".to_string()));
        assert!(evaluate_where(&conditions, &values), "0xA4 != 0xA5");
        values.insert("2".to_string(), Some("10100100".to_string()));
        assert!(!evaluate_where(&conditions, &values), "相等应不满足 !=");

        // contains-x / contains-z
        let conditions = resolve_where(&vars, &[parse_where("tb.dout contains-x").unwrap()]).unwrap();
        let mut values = HashMap::new();
        values.insert("1".to_string(), Some("1010x100".to_string()));
        assert!(evaluate_where(&conditions, &values));
        values.insert("1".to_string(), Some("10100100".to_string()));
        assert!(!evaluate_where(&conditions, &values), "无 X 应不满足");
    }

    #[test]
    fn timescale_parsing_matches_js_contract() {
        assert_eq!(seconds_per_tick("1 ns"), Some(1e-9));
        assert_eq!(seconds_per_tick("10ps"), Some(1e-11));
        assert_eq!(seconds_per_tick(""), None);
        assert_eq!(seconds_per_tick("ns"), None);
        assert_eq!(seconds_per_tick("0 ns"), None);
    }

    #[test]
    fn tick_parsing_accepts_ticks_and_physical_units() {
        assert_eq!(parse_tick("125", None), Some(125));
        assert_eq!(parse_tick("125 ticks", None), Some(125));
        assert_eq!(parse_tick("125ns", Some(1e-9)), Some(125));
        assert_eq!(parse_tick("1.5us", Some(1e-9)), Some(1500));
        // 无 timescale 时物理单位非法
        assert_eq!(parse_tick("125ns", None), None);
        assert_eq!(parse_tick("bad", None), None);
        assert_eq!(parse_tick("-5", None), None);
    }

    #[test]
    fn signal_resolution_prefers_exact_path() {
        let vars = vec![
            WaveVar { id: "1".into(), path: "tb.clk".into(), name: "clk".into(), scope: "tb".into(), scope_id: None, width: 1, var_type: "reg".into(), range: None, msb: None, lsb: None, change_count: 0, packed_source: None, trace_only: false },
            WaveVar { id: "2".into(), path: "tb.dut.clk".into(), name: "clk".into(), scope: "tb.dut".into(), scope_id: None, width: 1, var_type: "reg".into(), range: None, msb: None, lsb: None, change_count: 0, packed_source: None, trace_only: false },
        ];
        let picked = resolve_ids(&vars, &["tb.clk"]).expect("exact path resolves");
        assert_eq!(picked[0].id, "1");
        // 短名有歧义 → 报错并给候选
        let error = resolve_ids(&vars, &["clk"]).unwrap_err();
        assert_eq!(error.code, "SIGNAL_NOT_FOUND");
        assert_eq!(error.candidates.len(), 2);
    }

    /// wellen 对 EVCD 等变体会 panic；必须转成可诊断错误而不是让宿主崩溃。
    #[test]
    fn unsupported_encoding_reports_error_instead_of_panicking() {
        let directory = std::env::temp_dir().join("svtools-wave-unsupported");
        let _ = std::fs::create_dir_all(&directory);
        let file = directory.join("broken.fst");
        // 非空但结构非法的内容：wellen 会失败或 panic，两者都必须落成 Err。
        std::fs::write(&file, b"\x00\x00\x00\x00not-a-real-fst-body").expect("write fixture");
        let outcome = open(&file);
        let _ = std::fs::remove_file(&file);
        assert!(outcome.is_err(), "非法内容必须返回错误而不是 panic");
        let error = outcome.err().expect("已确认是 Err");
        assert!(
            error.code == "WAVE_FORMAT_UNSUPPORTED" || error.code == "VCD_PARSE",
            "错误码应可诊断：{}",
            error.code
        );
    }
    /// 真实文件冒烟：设置 SVTOOLS_WAVE_TEST_VCD / SVTOOLS_WAVE_TEST_FST 后验证 open。
    /// 默认跳过，避免 CI 依赖本机样本。
    #[test]
    fn opens_real_vcd_and_fst_when_provided() {
        for (env, expect_format) in [("SVTOOLS_WAVE_TEST_VCD", "vcd"), ("SVTOOLS_WAVE_TEST_FST", "fst")] {
            let Some(path) = std::env::var(env).ok() else { continue };
            let trace = open(Path::new(&path)).unwrap_or_else(|error| panic!("{}: {}", env, error));
            assert_eq!(trace.format, expect_format, "{} 格式识别", env);
            assert!(!trace.vars.is_empty(), "{} 应解析出变量", env);
            assert!(trace.end_time >= 0);
            // 至少能按完整路径解析出一个信号
            let first = trace.vars[0].path.clone();
            let picked = resolve_ids(&trace.vars, &[&first]).expect("resolve first var");
            assert_eq!(picked[0].path, first);
        }
    }
}



