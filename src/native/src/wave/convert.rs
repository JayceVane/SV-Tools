//! 仿真后的 VCD→FST 流式转换。目标必须为新文件，原始 VCD 始终由宿主管理。
use super::{WaveError, WaveResult};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use wavefst::{
    ChainCompression, FstWriter, GeomEntry, Header, MiscAttributeType, ScopeType, SignalValue,
    VarDir, VarType,
};

const MAX_TOKEN: usize = 16 * 1024 * 1024;
const MAX_HEADER: usize = 64 * 1024 * 1024;
const MAX_STATE: usize = 256 * 1024 * 1024;

fn invalid(message: impl Into<String>) -> WaveError {
    WaveError::new("WAVE_CONVERT", message)
}
fn limit() -> WaveError {
    invalid("VCD 转换超过资源预算（头部 64 MiB、单值 16 MiB、信号状态 256 MiB）")
}
fn mapped<T>(result: Result<T, impl std::fmt::Display>) -> WaveResult<T> {
    result.map_err(|e| invalid(e.to_string()))
}

/// 重用 token 缓冲区，避免把几百 MB 的正文或全部事件装入内存。
struct Tokens<R> {
    input: R,
    consumed: usize,
}
impl<R: BufRead> Tokens<R> {
    fn next(&mut self, out: &mut Vec<u8>) -> WaveResult<bool> {
        out.clear();
        loop {
            let chunk = mapped(self.input.fill_buf())?;
            if chunk.is_empty() {
                return Ok(!out.is_empty());
            }
            let start = if out.is_empty() {
                chunk
                    .iter()
                    .position(|b| !b.is_ascii_whitespace())
                    .unwrap_or(chunk.len())
            } else {
                0
            };
            let stop = chunk[start..]
                .iter()
                .position(u8::is_ascii_whitespace)
                .map(|n| start + n)
                .unwrap_or(chunk.len());
            if out.len() + stop - start > MAX_TOKEN {
                return Err(limit());
            }
            out.extend_from_slice(&chunk[start..stop]);
            let done = stop < chunk.len();
            let used = stop + usize::from(done);
            self.input.consume(used);
            self.consumed += used;
            if self.consumed > 2 * 1024 * 1024 * 1024 {
                return Err(limit());
            }
            if done && !out.is_empty() {
                return Ok(true);
            }
        }
    }
    fn word(&mut self) -> WaveResult<String> {
        let mut out = Vec::new();
        if !self.next(&mut out)? {
            return Err(invalid("VCD 意外结束"));
        }
        mapped(String::from_utf8(out)).and_then(|s| {
            if s.contains('\0') {
                Err(invalid("VCD 含 NUL 字符"))
            } else {
                Ok(s)
            }
        })
    }
    fn end(&mut self) -> WaveResult<()> {
        if self.word()? != "$end" {
            return Err(invalid("VCD 声明缺少 $end"));
        }
        Ok(())
    }
    fn text(&mut self) -> WaveResult<String> {
        let mut text = String::new();
        loop {
            let word = self.word()?;
            if word == "$end" {
                return Ok(text);
            }
            if text.len() + word.len() > 65536 {
                return Err(limit());
            }
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&word);
        }
    }
}

enum Declaration {
    Scope(ScopeType, String),
    Up,
    Var(VarType, u32, String, String),
    Comment(String),
}
struct Metadata {
    declarations: Vec<Declaration>,
    exponent: i8,
    version: String,
    date: String,
}

fn var_type(text: &str) -> WaveResult<VarType> {
    Ok(match text {
        "event" => VarType::VcdEvent,
        "integer" => VarType::VcdInteger,
        "parameter" => VarType::VcdParameter,
        "real" => VarType::VcdReal,
        "real_parameter" => VarType::VcdRealParameter,
        "realtime" => VarType::VcdRealtime,
        "reg" => VarType::VcdReg,
        "supply0" => VarType::VcdSupply0,
        "supply1" => VarType::VcdSupply1,
        "time" => VarType::VcdTime,
        "tri" => VarType::VcdTri,
        "triand" => VarType::VcdTriand,
        "trior" => VarType::VcdTrior,
        "trireg" => VarType::VcdTrireg,
        "tri0" => VarType::VcdTri0,
        "tri1" => VarType::VcdTri1,
        "wand" => VarType::VcdWand,
        "wire" => VarType::VcdWire,
        "wor" => VarType::VcdWor,
        "string" => VarType::GenString,
        "bit" => VarType::SvBit,
        "logic" => VarType::SvLogic,
        "int" => VarType::SvInt,
        "shortint" => VarType::SvShortInt,
        "longint" => VarType::SvLongInt,
        "byte" => VarType::SvByte,
        "enum" => VarType::SvEnum,
        "shortreal" => VarType::SvShortReal,
        _ => return Err(invalid(format!("暂不转换 VCD 类型 {text}（保留原文件）"))),
    })
}
fn scope_type(text: &str) -> WaveResult<ScopeType> {
    Ok(match text {
        "module" => ScopeType::VcdModule,
        "task" => ScopeType::VcdTask,
        "function" => ScopeType::VcdFunction,
        "begin" => ScopeType::VcdBegin,
        "fork" => ScopeType::VcdFork,
        "generate" => ScopeType::VcdGenerate,
        "struct" => ScopeType::VcdStruct,
        "union" => ScopeType::VcdUnion,
        "class" => ScopeType::VcdClass,
        "interface" => ScopeType::VcdInterface,
        "package" => ScopeType::VcdPackage,
        "program" => ScopeType::VcdProgram,
        _ => return Err(invalid(format!("暂不转换作用域类型 {text}"))),
    })
}
fn geometry(kind: VarType, width: u32) -> GeomEntry {
    match kind {
        VarType::VcdReal
        | VarType::VcdRealParameter
        | VarType::VcdRealtime
        | VarType::SvShortReal => GeomEntry::Real,
        VarType::GenString => GeomEntry::Variable,
        _ => GeomEntry::Fixed(width),
    }
}
fn read_metadata<R: BufRead>(tokens: &mut Tokens<R>) -> WaveResult<Metadata> {
    let mut metadata = Metadata {
        declarations: Vec::new(),
        exponent: -9,
        version: String::new(),
        date: String::new(),
    };
    let (mut depth, mut variables, mut scopes) = (0usize, 0usize, 0usize);
    let mut timescale = false;
    loop {
        if tokens.consumed > MAX_HEADER {
            return Err(limit());
        }
        match tokens.word()?.as_str() {
            "$scope" => {
                let kind = scope_type(&tokens.word()?)?;
                let name = tokens.word()?;
                tokens.end()?;
                depth += 1;
                scopes += 1;
                if depth > super::header::MAX_SCOPE_DEPTH
                    || scopes > super::header::MAX_VARIABLES
                    || name.len() > 65536
                {
                    return Err(limit());
                }
                metadata.declarations.push(Declaration::Scope(kind, name));
            }
            "$upscope" => {
                if depth == 0 {
                    return Err(invalid("VCD 作用域栈下溢"));
                }
                depth -= 1;
                tokens.end()?;
                metadata.declarations.push(Declaration::Up);
            }
            "$var" => {
                let kind = var_type(&tokens.word()?)?;
                let width: u32 = mapped(tokens.word()?.parse())?;
                if (width == 0 && kind != VarType::GenString) || width as usize >= MAX_TOKEN {
                    return Err(limit());
                }
                let id = tokens.word()?;
                let name = tokens.text()?;
                variables += 1;
                if depth == 0
                    || variables > super::header::MAX_VARIABLES
                    || id.len() > 65536
                    || name.is_empty()
                {
                    return Err(invalid("无效 VCD 变量声明"));
                }
                metadata
                    .declarations
                    .push(Declaration::Var(kind, width, id, name));
            }
            "$timescale" => {
                if timescale {
                    return Err(invalid("VCD 重复声明 timescale"));
                }
                let value = tokens.text()?.replace(' ', "");
                let boundary = value
                    .find(|c: char| !c.is_ascii_digit())
                    .ok_or_else(|| invalid("无效 timescale"))?;
                let power = match &value[..boundary] {
                    "1" => 0,
                    "10" => 1,
                    "100" => 2,
                    _ => return Err(invalid("无效 timescale 倍数")),
                };
                let unit = match &value[boundary..] {
                    "s" => 0,
                    "ms" => -3,
                    "us" => -6,
                    "ns" => -9,
                    "ps" => -12,
                    "fs" => -15,
                    _ => return Err(invalid("无效 timescale 单位")),
                };
                metadata.exponent = unit + power;
                timescale = true;
            }
            "$date" => {
                metadata.date = tokens.text()?;
                if metadata.date.len() >= 119 {
                    return Err(invalid("VCD 日期超过 FST 字段容量"));
                }
            }
            "$version" => {
                metadata.version = tokens.text()?;
                if metadata.version.len() >= 128 {
                    return Err(invalid("VCD 版本超过 FST 字段容量"));
                }
            }
            "$comment" => metadata
                .declarations
                .push(Declaration::Comment(tokens.text()?)),
            "$enddefinitions" => {
                tokens.end()?;
                if depth != 0 || variables == 0 {
                    return Err(invalid("VCD 层级未闭合或没有信号"));
                }
                if !timescale {
                    return Err(invalid("VCD 未声明时间单位，保留原文件以免改变时间含义"));
                }
                return Ok(metadata);
            }
            other => return Err(invalid(format!("未知 VCD 头部命令 {other}"))),
        }
    }
}

struct Signal {
    handle: u32,
    geometry: GeomEntry,
    event: bool,
    initialized: bool,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversion {
    source_bytes: u64,
    output_bytes: u64,
    signals: usize,
    changes: u64,
}

/// 只创建新目标；错误路径不删除/覆盖调用方文件。
pub fn convert(source: &Path, target: &Path) -> WaveResult<Conversion> {
    let input = mapped(File::open(source))?;
    let before = mapped(input.metadata())?;
    if !before.is_file() || before.len() > 2 * 1024 * 1024 * 1024 {
        return Err(limit());
    }
    let mut tokens = Tokens {
        input: BufReader::with_capacity(256 * 1024, input),
        consumed: 0,
    };
    let metadata = read_metadata(&mut tokens)?;
    let output = mapped(OpenOptions::new().write(true).create_new(true).open(target))?;
    let result =
        super::catch_library_panic(|| convert_body(&mut tokens, output, metadata, before.len()));
    let converted = result.map_err(|detail| invalid(format!("FST 编码失败：{detail}")))??;
    let after = mapped(std::fs::metadata(source))?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(invalid("转换期间源 VCD 发生变化"));
    }
    // 用独立读取器验证头部/层级可读；数据语义由跨格式回归测试验证。
    let checked = super::catch_library_panic(|| {
        wellen::viewers::read_header_from_file(
            target,
            &wellen::LoadOptions {
                multi_thread: false,
                ..Default::default()
            },
        )
    })
    .map_err(|detail| invalid(format!("FST 验证失败：{detail}")))?;
    mapped(checked)?;
    Ok(converted)
}

fn convert_body<R: BufRead>(
    tokens: &mut Tokens<R>,
    output: File,
    metadata: Metadata,
    source_bytes: u64,
) -> WaveResult<Conversion> {
    let mut writer = mapped(
        FstWriter::builder(BufWriter::with_capacity(256 * 1024, output))
            .timescale_exponent(metadata.exponent)
            .chain_compression(ChainCompression::Lz4)
            .block_size_limit(16 * 1024 * 1024)
            .block_change_limit(500_000)
            .build(),
    )?;
    let mut signals: HashMap<String, Signal> = HashMap::new();
    let mut state_bytes = 0usize;
    for declaration in metadata.declarations {
        match declaration {
            Declaration::Scope(kind, name) => {
                mapped(writer.begin_scope(kind, name, None))?;
            }
            Declaration::Up => mapped(writer.end_scope())?,
            Declaration::Comment(text) => {
                mapped(writer.add_misc_attribute(MiscAttributeType::Comment, text, 0))?;
            }
            Declaration::Var(kind, width, id, name) => {
                let geom = geometry(kind, width);
                if let Some(signal) = signals.get(&id) {
                    if signal.geometry != geom {
                        return Err(invalid("VCD 别名位宽/类型不一致"));
                    }
                    mapped(writer.add_alias(kind, VarDir::Implicit, name, signal.handle))?;
                } else {
                    state_bytes += match geom {
                        GeomEntry::Fixed(width) => width as usize,
                        GeomEntry::Real => 8,
                        GeomEntry::Variable => 8,
                    };
                    if state_bytes > MAX_STATE {
                        return Err(limit());
                    }
                    let handle =
                        mapped(writer.add_variable(kind, VarDir::Implicit, name, geom.clone()))?;
                    signals.insert(
                        id,
                        Signal {
                            handle,
                            geometry: geom,
                            event: kind == VarType::VcdEvent,
                            initialized: false,
                        },
                    );
                }
            }
        }
    }
    mapped(writer.write_header(Header {
        version: metadata.version,
        date: metadata.date,
        ..Default::default()
    }))?;
    let (mut token, mut id, mut expanded) = (Vec::new(), Vec::new(), String::new());
    let (mut time, mut changes, mut initialized) = (0u64, 0u64, 0usize);
    let mut first_time = None;
    let mut anchor: Option<(u32, SignalValue<'static>)> = None;
    let mut block = false;
    let mut seen_time = false;
    while tokens.next(&mut token)? {
        match token[0] {
            b'#' => {
                if block {
                    return Err(invalid("VCD dump 块未闭合"));
                }
                let next: u64 = mapped(mapped(std::str::from_utf8(&token[1..]))?.parse())?;
                if next < time || next > i64::MAX as u64 {
                    return Err(invalid("VCD 时间戳倒退或溢出"));
                }
                if (first_time.is_some() || seen_time)
                    && next > time
                    && initialized != signals.len()
                {
                    return Err(invalid(
                        "存在未初始化/延迟初始化信号，保留 VCD 以避免引入虚假的初始值",
                    ));
                }
                time = next;
                seen_time = true;
            }
            b'$' => match token.as_slice() {
                b"$comment" => {
                    tokens.text()?;
                }
                b"$dumpvars" | b"$dumpall" | b"$dumpon" | b"$dumpoff" => {
                    if block {
                        return Err(invalid("VCD dump 块嵌套"));
                    }
                    block = true;
                    if token == b"$dumpon" || token == b"$dumpoff" {
                        if initialized != signals.len() {
                            return Err(invalid("dump 活动切换前信号未初始化，保留 VCD"));
                        }
                        mapped(writer.emit_dump_active(time, token == b"$dumpon"))?;
                    }
                }
                b"$end" => {
                    if !block {
                        return Err(invalid("VCD 孤立的 $end"));
                    }
                    block = false;
                }
                _ => {
                    return Err(invalid(format!(
                        "暂不转换 VCD 命令 {}",
                        String::from_utf8_lossy(&token)
                    )))
                }
            },
            prefix => {
                let scalar = matches!(prefix, b'0' | b'1' | b'x' | b'X' | b'z' | b'Z');
                let id_slice = if scalar {
                    &token[1..]
                } else {
                    if !matches!(prefix, b'b' | b'B' | b'r' | b'R' | b's' | b'S') {
                        return Err(invalid("未知 VCD 值编码"));
                    }
                    if !tokens.next(&mut id)? {
                        return Err(invalid("VCD 值缺少信号标识"));
                    }
                    &id
                };
                let signal = signals
                    .get_mut(mapped(std::str::from_utf8(id_slice))?)
                    .ok_or_else(|| invalid("VCD 值引用了未声明的信号"))?;
                let value = match (&signal.geometry, prefix) {
                    (GeomEntry::Fixed(width), _) if scalar && *width == 1 => {
                        SignalValue::Bit(prefix.to_ascii_lowercase() as char)
                    }
                    (GeomEntry::Fixed(width), b'b' | b'B') => {
                        let bits = &token[1..];
                        if bits.is_empty()
                            || bits.len() > *width as usize
                            || !bits
                                .iter()
                                .all(|b| matches!(b, b'0' | b'1' | b'x' | b'X' | b'z' | b'Z'))
                        {
                            return Err(invalid("VCD 向量宽度或值无效"));
                        }
                        expanded.clear();
                        let pad = match bits[0].to_ascii_lowercase() {
                            b'x' => 'x',
                            b'z' => 'z',
                            _ => '0',
                        };
                        expanded.extend(std::iter::repeat_n(pad, *width as usize - bits.len()));
                        expanded.extend(bits.iter().map(|b| b.to_ascii_lowercase() as char));
                        SignalValue::Vector(Cow::Borrowed(&expanded))
                    }
                    (GeomEntry::Real, b'r' | b'R') => SignalValue::Real(mapped(
                        mapped(std::str::from_utf8(&token[1..]))?.parse(),
                    )?),
                    // VCD 字符串扩展的反斜杠转义存在厂商差异，首版拒绝自动转换而不冒险丢失字节。
                    (GeomEntry::Variable, _) => {
                        return Err(invalid("字符串波形暂保留 VCD，不自动转换"))
                    }
                    _ => return Err(invalid("VCD 值编码与声明类型不一致")),
                };
                mapped(writer.emit_change(time, signal.handle, value.clone()))?;
                if !signal.initialized {
                    signal.initialized = true;
                    initialized += 1;
                }
                if !signal.event
                    && anchor
                        .as_ref()
                        .is_none_or(|(handle, _)| *handle == signal.handle)
                {
                    anchor = Some((signal.handle, value.into_owned()));
                }
                first_time.get_or_insert(time);
                changes += 1;
            }
        }
    }
    if block || changes == 0 || initialized != signals.len() {
        return Err(invalid("VCD 不完整或存在未初始化信号"));
    }
    // 时间终点可能只有 #tick 没有值变化；重复当前值保留视图的完整时域。
    if let Some((handle, value)) = anchor {
        mapped(writer.emit_change(time, handle, value))?;
    } else {
        mapped(writer.emit_dump_active(time, true))?;
    }
    let mut output = mapped(writer.finish())?;
    mapped(output.flush())?;
    mapped(output.get_ref().sync_all())?;
    let output_bytes = mapped(output.get_ref().metadata())?.len();
    Ok(Conversion {
        source_bytes,
        output_bytes,
        signals: signals.len(),
        changes,
    })
}
