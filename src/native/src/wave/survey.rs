//! 窗口概览查询：多信号统计与合并时间线（形态参考 pywellen-mcp 的 statistics/timeline）。
//! 口径与稳定值查询一致：同一时间戳的ΔCycle 多次变化折叠为组末终值，只报告终值跳变。
use super::{project_packed_source, value_bits, WaveError, WaveResult, WaveSession, WaveVar};
use serde::Serialize;
use std::collections::BTreeMap;

const MAX_SCAN_RECORDS: usize = 2_000_000;
const MAX_DECODED_BYTES: usize = 16 * 1024 * 1024;

/// 单查询共享预算：记录数与译码字节都跨信号扣减，超限信号标不完整并可续查。
struct Budget {
    records: usize,
    bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSeries {
    pub path: String,
    pub width: u32,
    /// 窗口内原始记录数（含同刻重复与同值冗余）。
    pub window_records: usize,
    /// 折叠后的时间戳事件数（与 changes 的口径一致）。
    pub events: usize,
    /// 终值实际跳变数（同值冗余事件不计）。
    pub transitions: usize,
    pub first_change: Option<String>,
    pub last_change: Option<String>,
    pub has_x: bool,
    pub has_z: bool,
    pub complete: bool,
    /// 下一页闭区间 --from；一组同刻事件不会跨页切断。
    pub next: Option<String>,
    pub stop_reason: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineChange {
    pub path: String,
    /// 窗口首事件取窗口前一时刻终值；无前值（from=0 且信号首次出现）为 null。
    pub before: Option<String>,
    pub bits: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineGroup {
    pub t: String,
    pub changes: Vec<TimelineChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub groups: Vec<TimelineGroup>,
    pub scanned_records: usize,
    pub complete: bool,
    pub next: Option<String>,
    pub stop_reason: Option<&'static str>,
}

/// 信号在窗口内按时间戳折叠的终值序列；预算不足时停在完整组边界。
/// 返回 (组列表, 原始记录数, 是否完整, 续查起点时刻, 停止原因)。
fn settled_groups(
    session: &mut WaveSession,
    var: &WaveVar,
    from: u64,
    to: u64,
    budget: &mut Budget,
) -> WaveResult<(Vec<(u64, String)>, usize, bool, Option<u64>, Option<&'static str>)> {
    let target = var
        .packed_source
        .as_ref()
        .map(|source| source.id.as_str())
        .unwrap_or(&var.id);
    let signal_ref = session
        .signal_ref(target)
        .ok_or_else(|| WaveError::new("SIGNAL_NOT_FOUND", format!("信号来源不存在：{}", var.path)))?;
    session.load(&[signal_ref]);
    let signal = session
        .signal(signal_ref)
        .ok_or_else(|| WaveError::new("VCD_PARSE", "信号数据未加载"))?;
    let times = signal.time_indices();
    let first = times.partition_point(|index| session.time_at(*index) < from);
    let last = times.partition_point(|index| session.time_at(*index) <= to);
    let byte_width = var
        .packed_source
        .as_ref()
        .map(|source| source.width)
        .unwrap_or(var.width) as usize;
    let mut groups = Vec::new();
    let mut records = 0usize;
    let mut position = first;
    let mut stop = None;
    while position < last {
        let index = times[position];
        let end = position + times[position..last].partition_point(|other| *other == index);
        let count = end - position;
        let cost = byte_width.saturating_mul(count.saturating_add(2));
        if records + count > MAX_SCAN_RECORDS || cost > budget.bytes {
            stop = Some(if records + count > MAX_SCAN_RECORDS {
                "query-record-budget"
            } else {
                "query-decode-budget"
            });
            break;
        }
        records += count;
        budget.bytes -= cost;
        let Some(offset) = signal.get_offset(index) else {
            return Err(WaveError::new("VCD_PARSE", "信号时间索引缺少数据偏移"));
        };
        let bits = value_bits(signal.get_value_at(&offset, offset.elements.saturating_sub(1)))
            .map(|bits| project_packed_source(bits, var.width, var.packed_source.as_ref()))
            .ok_or_else(|| WaveError::new("INVALID_ARGUMENT", "信号值不是可解析的数字位串"))?;
        groups.push((session.time_at(index), bits));
        position = end;
    }
    let complete = stop.is_none();
    let next = if complete {
        None
    } else {
        Some(session.time_at(times[position]))
    };
    Ok((groups, records, complete, next, stop))
}

/// 窗口前一时刻（from-1）的终值；from=0 或信号此前无记录时为 None。
fn settled_before(session: &mut WaveSession, var: &WaveVar, from: u64) -> WaveResult<Option<String>> {
    if from == 0 {
        return Ok(None);
    }
    let target = var
        .packed_source
        .as_ref()
        .map(|source| source.id.as_str())
        .unwrap_or(&var.id);
    let Some(signal_ref) = session.signal_ref(target) else {
        return Ok(None);
    };
    session.load(&[signal_ref]);
    let Some(signal) = session.signal(signal_ref) else {
        return Ok(None);
    };
    let Some(index) = session.time_index_at(from - 1) else {
        return Ok(None);
    };
    let Some(offset) = signal.get_offset(index) else {
        return Ok(None);
    };
    Ok(value_bits(signal.get_value_at(&offset, offset.elements.saturating_sub(1)))
        .map(|bits| project_packed_source(bits, var.width, var.packed_source.as_ref())))
}

/// 多信号窗口统计：事件数/跳变数/首末跳变/X·Z 出现，供错误窗口分诊"谁最活跃"。
pub fn stats(session: &mut WaveSession, variables: &[&WaveVar], from: u64, to: u64) -> WaveResult<Vec<StatsSeries>> {
    super::catch_library_panic(|| {
        let mut budget = Budget { records: MAX_SCAN_RECORDS, bytes: MAX_DECODED_BYTES };
        let mut series = Vec::with_capacity(variables.len());
        for var in variables {
            let (groups, records, complete, next, stop) =
                settled_groups(session, var, from, to, &mut budget)?;
            let mut previous = settled_before(session, var, from)?;
            let mut transitions = 0usize;
            let (mut first_change, mut last_change) = (None, None);
            let (mut has_x, mut has_z) = (false, false);
            for (time, bits) in &groups {
                has_x |= bits.contains('x');
                has_z |= bits.contains('z');
                if previous.as_ref().is_some_and(|old| old != bits) {
                    transitions += 1;
                    first_change.get_or_insert_with(|| time.to_string());
                    last_change = Some(time.to_string());
                }
                previous = Some(bits.clone());
            }
            series.push(StatsSeries {
                path: var.path.clone(),
                width: var.width,
                window_records: records,
                events: groups.len(),
                transitions,
                first_change,
                last_change,
                has_x,
                has_z,
                complete,
                next: next.map(|time| time.to_string()),
                stop_reason: stop,
            });
        }
        Ok(series)
    })
    .map_err(|detail| WaveError::new("WAVE_FORMAT_UNSUPPORTED", format!("窗口统计失败：{detail}")))?
}

/// 多信号合并时间线：只含终值跳变，按时间戳归组、同刻多信号变化同组返回。
///
/// 预算停止按整查询统一截断：任一信号在 T_b 停下时，其它信号 ≥T_b 的组一并丢弃，
/// 续查 `--from T_b` 从全部信号重新收敛——不重叠、不遗漏。
pub fn timeline(
    session: &mut WaveSession,
    variables: &[&WaveVar],
    from: u64,
    to: u64,
    limit: usize,
) -> WaveResult<Timeline> {
    super::catch_library_panic(|| {
        let mut budget = Budget { records: MAX_SCAN_RECORDS, bytes: MAX_DECODED_BYTES };
        let mut merged: BTreeMap<u64, Vec<TimelineChange>> = BTreeMap::new();
        let mut scanned = 0usize;
        let mut stop_reason = None;
        let mut next_time: Option<u64> = None;
        for var in variables {
            let (groups, records, complete, next, stop) =
                settled_groups(session, var, from, to, &mut budget)?;
            scanned += records;
            if let Some(stop_at) = next.filter(|_| !complete) {
                stop_reason = stop;
                next_time = Some(next_time.map_or(stop_at, |old: u64| old.min(stop_at)));
            }
            let mut previous = settled_before(session, var, from)?;
            for (time, bits) in groups {
                // 无前值（from=0 首次出现）不算跳变，与 stats 的口径一致。
                if previous.as_ref().is_some_and(|old| *old != bits) {
                    merged.entry(time).or_default().push(TimelineChange {
                        path: var.path.clone(),
                        before: previous.clone(),
                        bits: bits.clone(),
                    });
                }
                previous = Some(bits);
            }
        }
        // 统一截断：预算停止之后的所有组（含其它信号已收敛部分）整体留给下一页。
        if let Some(cutoff) = next_time {
            merged.retain(|&time, _| time < cutoff);
        }
        let mut groups_out = Vec::new();
        for (time, mut changes) in merged {
            if groups_out.len() >= limit {
                stop_reason = Some("result-limit");
                next_time = Some(next_time.map_or(time, |old: u64| old.min(time)));
                break;
            }
            changes.sort_by(|a, b| a.path.cmp(&b.path));
            groups_out.push(TimelineGroup { t: time.to_string(), changes });
        }
        let complete = next_time.is_none();
        Ok(Timeline {
            groups: groups_out,
            scanned_records: scanned,
            complete,
            next: next_time.map(|time| time.to_string()),
            stop_reason,
        })
    })
    .map_err(|detail| WaveError::new("WAVE_FORMAT_UNSUPPORTED", format!("合并时间线失败：{detail}")))?
}
