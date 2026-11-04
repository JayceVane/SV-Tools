//! VCD 头部补充读取：wellen 只保留层级与时间信息，但 JS 合同还需要
//! `$date`/`$version`/`$comment` 头声明与 `$var` 的符号标识（`!`/`#`/`%`…）。
//!
//! 这些内容全部位于 `$enddefinitions` 之前，按行扫描到该标记即停止，不读 body，
//! 因此对大文件的开销可忽略（与 `read_vcd_headers` 共用同一策略）。

use std::path::Path;

use super::{WaveError, WaveResult};

/// VCD 头里的一条声明。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WaveHeaderEntry {
    pub kind: String,
    pub value: String,
}

/// 扫描上限：头声明正常只有几百字节，这里给足余量但不无限读。
const MAX_SCAN_BYTES: u64 = 8 * 1024 * 1024;

/// 头部声明的解析级资源上限（与旧 JS parser 同口径）。
///
/// 这些护栏防的是**损坏或恶意头部**，不是正常大设计：
/// 一条位宽 40 亿的 `$var` 在逐位展开时会按下标申请等量内存；
/// 十万层嵌套作用域会让路径拼接退化成 O(n²)。
const MAX_VARIABLES: usize = 1_000_000;
const MAX_SIGNAL_WIDTH: u32 = 16 * 1024 * 1024 - 1;
const MAX_SCOPE_DEPTH: usize = 256;
const MAX_REFERENCE_LENGTH: usize = 65536;

fn limit_error(message: String) -> WaveError {
    WaveError::new("VCD_RESOURCE_LIMIT", message)
}

/// 读取文件开头若干字节（截断到 `MAX_SCAN_BYTES`）。
fn read_prefix(file: &Path) -> Option<String> {
    use std::io::Read;
    let handle = std::fs::File::open(file).ok()?;
    let mut buffer = Vec::new();
    handle.take(MAX_SCAN_BYTES).read_to_end(&mut buffer).ok()?;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// 抽取 `$date` / `$version` / `$comment`。FST/GHW 没有对应结构，返回空表。
pub fn read_headers(file: &Path, format: &str) -> Vec<WaveHeaderEntry> {
    if format != "vcd" {
        return Vec::new();
    }
    let Some(text) = read_prefix(file) else { return Vec::new() };
    let mut entries = Vec::new();
    let mut current: Option<(String, Vec<String>)> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("$enddefinitions") {
            break;
        }
        if let Some((kind, parts)) = current.as_mut() {
            if trimmed == "$end" {
                entries.push(WaveHeaderEntry { kind: kind.clone(), value: parts.join("\n") });
                current = None;
            } else {
                parts.push(trimmed.to_string());
            }
            continue;
        }
        for kind in ["date", "version", "comment"] {
            let marker = format!("${}", kind);
            if trimmed == marker || trimmed.starts_with(&format!("{} ", marker)) {
                let rest = trimmed[marker.len()..].trim();
                // 单行闭合：`$date ... $end`。注意后面可能还紧跟其他块
                // （`$version X $end $timescale 10 ps $end` 全在同一行），
                // 必须只取到本块自己的 `$end`。
                if let Some(index) = rest.find("$end") {
                    entries.push(WaveHeaderEntry {
                        kind: kind.to_string(),
                        value: rest[..index].trim().to_string(),
                    });
                } else if rest.is_empty() {
                    current = Some((kind.to_string(), Vec::new()));
                } else {
                    current = Some((kind.to_string(), vec![rest.to_string()]));
                }
                break;
            }
        }
    }
    entries
}

/// 按声明顺序抽取 `$var` 的符号标识。
///
/// wellen 不暴露这个符号，但它是**跨实现唯一稳定的信号身份**：
/// 前端缓存键、`--signals` 的 id 语义、既有测试都建立在它上面。
/// 一条 `$var` 声明（含作用域），用于把 wellen 合并后的向量映射回声明组。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredVar {
    pub symbol: String,
    pub name: String,
    pub width: u32,
    /// 位下标最高位：`[3]` → 3、`[7:0]` → 7。
    pub msb: Option<i64>,
    /// 声明里的 packed 范围原文，如 `[7:0]` / `[3]`；没有范围时为 `None`。
    ///
    /// 必须从声明表取：wellen 只在「下标宽度等于声明位宽」时才认 VarIndex，
    /// 像 `$var reg 8 # \mem[0] [7:0]` 会把 `[0]` 当数组下标、丢掉 `[7:0]`，
    /// 于是 `var.index()` 为 `None`，打包范围就查不到了。
    pub range: Option<String>,
    pub scope: String,
    /// 该声明所在 `$scope` 在扁平作用域表里的下标。
    ///
    /// 不能按作用域**路径**回查：Icarus 会为每条 `$var` 各开一个同名
    /// `$scope module memory_dump`，路径完全相同但下标不同。
    pub scope_id: Option<usize>,
}

/// 一条 `$scope` 声明，扁平化后用于前端信号树。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredScope {
    /// `$scope` 的类型（`module`/`task`/`begin`…）。
    #[serde(rename = "type")]
    pub scope_type: String,
    pub name: String,
    /// 从根开始的完整路径。
    pub path: String,
    /// 父作用域在本表中的下标；顶层为 `None`。
    pub parent_id: Option<usize>,
}

/// 一趟扫描同时取出扁平作用域表与 `$var` 声明。
///
/// 两者必须同源：Icarus 会为每条 `$var` 各开一个同名 `$scope module x`，
/// 按路径回查作用域会把所有变量都指到最后一条同名 entry 上，
/// 前端 `signal-mapping` 的 `paths[scopeId]` 校验随即失败。
///
/// 返回错误只用于资源上限（`VCD_RESOURCE_LIMIT`）：正常头部不会触发。
pub fn declared_hierarchy(
    file: &Path,
    format: &str,
) -> WaveResult<(Vec<DeclaredScope>, Vec<DeclaredVar>)> {
    if format != "vcd" {
        return Ok((Vec::new(), Vec::new()));
    }
    let Some(text) = read_prefix(file) else { return Ok((Vec::new(), Vec::new())) };
    let header = match text.find("$enddefinitions") {
        Some(position) => &text[..position],
        None => text.as_str(),
    };
    let tokens: Vec<&str> = header.split_whitespace().collect();
    let mut scopes: Vec<DeclaredScope> = Vec::new();
    let mut declared: Vec<DeclaredVar> = Vec::new();
    // 当前嵌套栈：(扁平表下标, 完整路径)。路径由栈内父路径拼出，与 `$upscope` 同步弹栈。
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        match tokens[index] {
            "$scope" if index + 2 < tokens.len() => {
                let scope_type = tokens[index + 1].to_string();
                let name = tokens[index + 2].to_string();
                let (path, parent_id) = match stack.last() {
                    Some((id, parent)) => (format!("{}.{}", parent, name), Some(*id)),
                    None => (name.clone(), None),
                };
                // 深度与路径长度都要有界：二者都是 O(深度²) 的隐患，
                // 且损坏头部可以轻易构造上万层嵌套。
                if stack.len() >= MAX_SCOPE_DEPTH || path.len() > MAX_REFERENCE_LENGTH {
                    return Err(limit_error(format!(
                        "VCD 作用域超过安全上限（深度 ≤ {MAX_SCOPE_DEPTH}，路径 ≤ {MAX_REFERENCE_LENGTH} 字节）"
                    )));
                }
                stack.push((scopes.len(), path.clone()));
                scopes.push(DeclaredScope { scope_type, name, path, parent_id });
                index += 3;
            }
            "$upscope" => {
                stack.pop();
                index += 1;
            }
            "$var" if index + 4 < tokens.len() => {
                let width = tokens[index + 2].parse::<u32>().unwrap_or(1);
                if width > MAX_SIGNAL_WIDTH {
                    return Err(limit_error(format!(
                        "VCD 声明位宽 {width} 超过 {MAX_SIGNAL_WIDTH} 位安全上限"
                    )));
                }
                if declared.len() >= MAX_VARIABLES {
                    return Err(limit_error(format!(
                        "VCD 信号声明数超过 {MAX_VARIABLES} 条安全上限"
                    )));
                }
                let symbol = tokens[index + 3].to_string();
                let name = tokens[index + 4].to_string();
                let mut cursor = index + 5;
                let mut msb = None;
                let mut range = None;
                while cursor < tokens.len() && tokens[cursor] != "$end" {
                    // 只有 packed 范围是独立的 `[...]` token；数组下标都黏在名字里
                    // （`\mem[0]`、`\matrix[-1][2]`），不会以 `[` 开头。
                    if tokens[cursor].starts_with('[') {
                        msb = parse_index(tokens[cursor]);
                        range = Some(tokens[cursor].to_string());
                    }
                    cursor += 1;
                }
                declared.push(DeclaredVar {
                    symbol,
                    name,
                    width,
                    msb,
                    range,
                    scope: stack.last().map(|(_, path)| path.clone()).unwrap_or_default(),
                    scope_id: stack.last().map(|(id, _)| *id),
                });
                index = cursor + 1;
            }
            _ => index += 1,
        }
    }
    Ok((scopes, declared))
}

/// 按声明顺序读出全部 `$var`，跟踪作用域嵌套。
///
/// 用 token 流而不是 `split("$var")`：作用域是顺序上下文，
/// 且最后一个 `$var` 与 `$enddefinitions` 会落在同一片段里。
pub fn declared_vars(file: &Path, format: &str) -> WaveResult<Vec<DeclaredVar>> {
    declared_hierarchy(file, format).map(|hierarchy| hierarchy.1)
}

/// 按声明顺序读出全部 `$scope`，输出扁平表。
pub fn declared_scopes(file: &Path, format: &str) -> WaveResult<Vec<DeclaredScope>> {
    declared_hierarchy(file, format).map(|hierarchy| hierarchy.0)
}

/// 读取 `$timescale` 的**原文**（`1 ns` / `10ps`），保留原始排版。
///
/// wellen 把 timescale 归一成结构化数值，`text()` 会输出 `1ns`、单复数也会被抹平。
/// CLI 输出是对外契约（既有调用方按原文比较），因此这里单独从头部声明里取原文。
pub fn declared_timescale(file: &Path, format: &str) -> Option<String> {
    if format != "vcd" {
        return None;
    }
    let text = read_prefix(file)?;
    let header = match text.find("$enddefinitions") {
        Some(position) => &text[..position],
        None => text.as_str(),
    };
    let start = header.find("$timescale")? + "$timescale".len();
    let rest = &header[start..];
    // `$timescale 1 ns $end`：到自己的 `$end` 为止，跨行时把换行折成空格。
    let end = rest.find("$end")?;
    let value = rest[..end].split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then_some(value)
}

/// 解析 `[3]` / `[7:0]` 里的最高位。
fn parse_index(token: &str) -> Option<i64> {
    let inner = token.strip_prefix('[')?.strip_suffix(']')?;
    match inner.split_once(':') {
        Some((left, _right)) => left.parse().ok(),
        None => inner.parse().ok(),
    }
}

/// 按声明顺序抽取符号标识。
pub fn read_symbols(file: &Path, format: &str) -> WaveResult<Vec<String>> {
    declared_vars(file, format)
        .map(|declarations| declarations.into_iter().map(|declaration| declaration.symbol).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp(name: &str, text: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join("svtools-wave-headers");
        std::fs::create_dir_all(&directory).expect("create temp dir");
        let path = directory.join(name);
        std::fs::write(&path, text).expect("write fixture");
        path
    }

    #[test]
    fn extracts_single_line_and_block_headers() {
        let path = write_temp(
            "headers.vcd",
            "$date 2026-11-03 $end\n$version iverilog 13 $end\n$comment\nmulti line\nnote\n$end\n$timescale 1ns $end\n$enddefinitions $end\n",
        );
        let entries = read_headers(&path, "vcd");
        let _ = std::fs::remove_file(&path);
        let kinds: Vec<&str> = entries.iter().map(|entry| entry.kind.as_str()).collect();
        assert_eq!(kinds, vec!["date", "version", "comment"]);
        assert_eq!(entries[0].value, "2026-11-03");
        assert_eq!(entries[2].value, "multi line\nnote");
    }

    #[test]
    fn extracts_var_symbols_in_declaration_order() {
        let path = write_temp(
            "symbols.vcd",
            "$scope module tb $end\n$var wire 1 ! clk $end\n$var wire 8 # bus [7:0] $end\n$var real 1 % temp $end\n$upscope $end\n$enddefinitions $end\nb101 #\n",
        );
        let symbols = read_symbols(&path, "vcd").expect("read symbols");
        let _ = std::fs::remove_file(&path);
        assert_eq!(symbols, vec!["!", "#", "%"]);
    }

    #[test]
    fn non_vcd_formats_yield_no_headers() {
        let path = write_temp("ignored.fst", "$date x $end");
        assert!(read_headers(&path, "fst").is_empty());
        assert!(read_symbols(&path, "fst").expect("fst symbols").is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn oversized_signal_width_is_rejected() {
        let path = write_temp(
            "wide.vcd",
            "$scope module tb $end\n$var wire 4294967295 ! huge $end\n$upscope $end\n$enddefinitions $end\n",
        );
        let error = declared_hierarchy(&path, "vcd").expect_err("位宽超限必须拒绝");
        let _ = std::fs::remove_file(&path);
        assert_eq!(error.code, "VCD_RESOURCE_LIMIT");
    }

    #[test]
    fn overdeep_scope_nesting_is_rejected() {
        let mut text = String::new();
        for depth in 0..300 {
            text.push_str(&format!("$scope module s{} $end\n", depth));
        }
        text.push_str("$enddefinitions $end\n");
        let path = write_temp("deep.vcd", &text);
        let error = declared_hierarchy(&path, "vcd").expect_err("作用域过深必须拒绝");
        let _ = std::fs::remove_file(&path);
        assert_eq!(error.code, "VCD_RESOURCE_LIMIT");
    }
}


