//! 波形会话句柄：让同一文件的多次查询复用一次解析结果。
//!
//! 背景：`WaveSession::open` 是完整解析（read + describe，还要逐信号统计变化次数）。
//! 实测 7.1 MiB 文件单次 78.8 ms——若每个查询都重开，webview 的 window/values/edge
//! 与 CLI `sample` 的每一页都要付一次完整解析代价。
//!
//! 为什么不按「文件路径 + size/mtime」做隐式缓存：那会重新引入边界问题
//! （文件被替换但 mtime 未变、多个 worker 同时打开同一文件时谁是主），
//! 而这些正是删掉 JS 索引缓存时想摆脱的东西。这里改为**显式句柄**：
//! 调用方 open 一次拿到 handle，查询时带 handle，用完 close——生命周期清晰。
//!
//! 并发：句柄表用 `Mutex` 保护；`WaveSession` 的查询需要 `&mut`，因此每个句柄
//! 包一层 `Mutex`。查询是同步调用（或 `AsyncTask` 的 compute），不跨 await 持锁。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use super::WaveSession;

/// 一个可复用的波形会话。
pub type SharedSession = Arc<Mutex<WaveSession>>;

/// 句柄表。句柄是单调递增的整数，close 后立即失效（不做地址复用）。
fn registry() -> &'static Mutex<HashMap<u64, SharedSession>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, SharedSession>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_handle() -> u64 {
    static COUNTER: AtomicUsize = AtomicUsize::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed) as u64
}

/// 登记一个新会话，返回句柄。
pub fn insert(session: WaveSession) -> u64 {
    let handle = next_handle();
    registry()
        .lock()
        .expect("wave session registry poisoned")
        .insert(handle, Arc::new(Mutex::new(session)));
    handle
}

/// 按句柄取出会话；句柄无效返回 None。
pub fn get(handle: u64) -> Option<SharedSession> {
    registry()
        .lock()
        .expect("wave session registry poisoned")
        .get(&handle)
        .cloned()
}

/// 释放句柄。重复 close 不报错（幂等），返回是否真的移除了条目。
pub fn remove(handle: u64) -> bool {
    registry()
        .lock()
        .expect("wave session registry poisoned")
        .remove(&handle)
        .is_some()
}

/// 当前活跃句柄数（测试与诊断用）。
pub fn active_count() -> usize {
    registry().lock().expect("wave session registry poisoned").len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_are_unique_and_removal_is_idempotent() {
        // 不构造真实 WaveSession（需要文件），只验证句柄编号与表行为。
        let a = next_handle();
        let b = next_handle();
        assert_ne!(a, b);
        assert!(!remove(u64::MAX), "不存在的句柄应返回 false");
        assert!(get(u64::MAX).is_none());
    }
}
