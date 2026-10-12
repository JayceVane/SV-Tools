//! 单次格式化的输出、缩进与续行状态，不跨请求共享。
use super::*;

#[derive(Debug, Clone)]
pub(super) struct SplitInfo {
    pub(super) count: usize,
    pub(super) text: String,
}

// ── Word History ────────────────────────────────────────────────

/// Circular buffer of last 4 tokens (matching Python's w_d list)
#[derive(Debug, Clone)]
pub(super) struct WordHistory {
    pub(super) buf: [String; 4],
}

impl WordHistory {
    pub(super) fn new() -> Self {
        Self {
            buf: std::array::from_fn(|_| "\n".to_string()),
        }
    }

    pub(super) fn push(&mut self, w: &str) {
        self.buf.rotate_left(1);
        self.buf[3].clear();
        self.buf[3].push_str(w);
    }

    /// w_d[-1]
    pub(super) fn last(&self) -> &str {
        &self.buf[3]
    }
    /// w_d[-2]
    pub(super) fn prev1(&self) -> &str {
        &self.buf[2]
    }
    /// w_d[-4]
    pub(super) fn prev3(&self) -> &str {
        &self.buf[0]
    }
}
#[derive(Default)]
pub(super) struct OutputBuffer {
    pub(super) line: String,
    pub(super) block: String,
    pub(super) output: String,
    pub(super) original_indent: String,
    pub(super) should_flush: bool,
    pub(super) block_ended: bool,
    pub(super) skip_terminator: bool,
}
pub(super) struct Indentation {
    pub(super) level: usize,
    pub(super) previous: usize,
    pub(super) has_indent: bool,
}
#[derive(Default)]
pub(super) struct Continuation {
    pub(super) splits: HashMap<usize, SplitInfo>,
    pub(super) always_indent: usize,
    pub(super) last_split: Option<SplitInfo>,
    pub(super) else_pending: bool,
}
pub(super) struct FormatSession {
    pub(super) buffer: OutputBuffer,
    pub(super) indentation: Indentation,
    pub(super) continuation: Continuation,
    pub(super) history: WordHistory,
}
impl FormatSession {
    pub(super) fn new(level: usize) -> Self {
        Self {
            buffer: OutputBuffer::default(),
            indentation: Indentation {
                level,
                previous: level,
                has_indent: level != 0,
            },
            continuation: Continuation::default(),
            history: WordHistory::new(),
        }
    }
}
