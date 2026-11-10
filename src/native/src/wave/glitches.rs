//! 诊断文件实际记录的同刻多次变化；序号不是仿真调度区/真实 delta 编号。
use super::{project_packed_source, value_bits, WaveError, WaveResult, WaveSession, WaveVar};
use serde::Serialize;

const MAX_SCAN_RECORDS: usize = 2_000_000;
const MAX_DECODED_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedValue {
    record_index: usize,
    bits: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    t: String,
    before: Option<String>,
    settled: String,
    recorded_changes: usize,
    effective_transitions: usize,
    classification: &'static str,
    has_unknown: bool,
    sequence: Vec<RecordedValue>,
    sequence_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    path: String,
    width: u32,
    window_records: usize,
    scanned_records: usize,
    matched: usize,
    complete: bool,
    /// 下一段闭区间 --from；一组同刻事件不会跨页切断。
    next: Option<String>,
    stop_reason: Option<&'static str>,
    findings: Vec<Finding>,
}

struct Budget {
    records: usize,
    bytes: usize,
}

pub fn scan(
    session: &mut WaveSession,
    variables: &[&WaveVar],
    from: u64,
    to: u64,
    limit: usize,
    max_values: usize,
) -> WaveResult<Vec<Series>> {
    super::catch_library_panic(|| scan_impl(session, variables, from, to, limit, max_values))
        .map_err(|detail| {
            WaveError::new(
                "WAVE_FORMAT_UNSUPPORTED",
                format!("同刻变化诊断失败：{detail}"),
            )
        })?
}

fn scan_impl(
    session: &mut WaveSession,
    variables: &[&WaveVar],
    from: u64,
    to: u64,
    limit: usize,
    max_values: usize,
) -> WaveResult<Vec<Series>> {
    if variables.iter().any(|var| {
        var.width == 0
            || matches!(
                var.var_type.as_str(),
                "real" | "realtime" | "string" | "event"
            )
    }) {
        return Err(WaveError::new(
            "INVALID_ARGUMENT",
            "wave glitches 仅检查数字信号；实数、字符串和 event 不作电平毛刺判断",
        ));
    }
    let refs: Vec<_> = variables
        .iter()
        .filter_map(|var| {
            session.signal_ref(
                var.packed_source
                    .as_ref()
                    .map(|source| source.id.as_str())
                    .unwrap_or(&var.id),
            )
        })
        .collect();
    session.load(&refs);
    let mut budget = Budget {
        records: MAX_SCAN_RECORDS,
        bytes: MAX_DECODED_BYTES,
    };
    variables
        .iter()
        .map(|var| scan_signal(session, var, from, to, limit, max_values, &mut budget))
        .collect()
}

fn scan_signal(
    session: &WaveSession,
    var: &WaveVar,
    from: u64,
    to: u64,
    limit: usize,
    max_values: usize,
    budget: &mut Budget,
) -> WaveResult<Series> {
    let signal_ref = session
        .signal_ref(
            var.packed_source
                .as_ref()
                .map(|source| source.id.as_str())
                .unwrap_or(&var.id),
        )
        .ok_or_else(|| {
            WaveError::new("SIGNAL_NOT_FOUND", format!("信号来源不存在：{}", var.path))
        })?;
    let signal = session
        .signal(signal_ref)
        .ok_or_else(|| WaveError::new("VCD_PARSE", "信号数据未加载"))?;
    let times = signal.time_indices();
    let first = times.partition_point(|index| session.time_at(*index) < from);
    let last = times.partition_point(|index| session.time_at(*index) <= to);
    let mut series = Series {
        path: var.path.clone(),
        width: var.width,
        window_records: last - first,
        scanned_records: 0,
        matched: 0,
        complete: true,
        next: None,
        stop_reason: None,
        findings: Vec::new(),
    };
    let decode = |position| {
        value_bits(signal.data().get_value_at(position))
            .map(|bits| project_packed_source(bits, var.width, var.packed_source.as_ref()))
            .ok_or_else(|| WaveError::new("INVALID_ARGUMENT", "信号值不是可解析的数字位串"))
    };
    let mut position = first;
    while position < last {
        let index = times[position];
        let end = position + times[position..last].partition_point(|other| *other == index);
        let records = end - position;
        // 预算不足时不消费半组，续查仍能得到完整证据。
        let decoded_bytes = if records > 1 {
            (var.packed_source
                .as_ref()
                .map(|source| source.width)
                .unwrap_or(var.width) as usize)
                .saturating_mul(records.saturating_add(2))
        } else {
            0
        };
        if records > budget.records
            || decoded_bytes > budget.bytes
            || series.findings.len() >= limit
        {
            series.stop_reason = Some(if records > budget.records {
                "query-record-budget"
            } else if decoded_bytes > budget.bytes {
                "query-decode-budget"
            } else {
                "result-limit"
            });
            series.complete = false;
            series.next = Some(session.time_at(index).to_string());
            break;
        }
        budget.records -= records;
        budget.bytes -= decoded_bytes;
        series.scanned_records += records;
        if records > 1 {
            let before = if position > 0 {
                Some(decode(position - 1)?)
            } else {
                None
            };
            let mut previous = before.clone();
            let mut transitions = 0;
            let mut has_unknown = before
                .as_ref()
                .is_some_and(|bits| bits.contains(['x', 'z']));
            let mut sequence = Vec::new();
            for offset in 0..records {
                let bits = decode(position + offset)?;
                has_unknown |= bits.contains(['x', 'z']);
                if previous.as_ref().is_some_and(|old| old != &bits) {
                    transitions += 1;
                }
                if offset < max_values.saturating_sub(1) || offset == records - 1 {
                    sequence.push(RecordedValue {
                        record_index: offset,
                        bits: bits.clone(),
                    });
                }
                previous = Some(bits);
            }
            // 没有前值时属于初始化活动，不能冒充正常运行期间的脉冲。
            if transitions > 1 || (before.is_none() && transitions > 0) {
                let settled = previous.expect("nonempty timestamp group");
                let classification = if before.is_none() {
                    "initialization"
                } else if before.as_ref() == Some(&settled) {
                    "returning"
                } else {
                    "settling"
                };
                series.findings.push(Finding {
                    t: session.time_at(index).to_string(),
                    before,
                    settled,
                    recorded_changes: records,
                    effective_transitions: transitions,
                    classification,
                    has_unknown,
                    sequence_truncated: records > sequence.len(),
                    sequence,
                });
                series.matched += 1;
            }
        }
        position = end;
    }
    Ok(series)
}
