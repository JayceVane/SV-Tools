use regex::Regex;
use std::sync::LazyLock;

// ── Regex patterns from verilogutil.py ──────────────────────────

/// Bitwidth pattern - used inline in regex patterns
pub const RE_BW: &str = r"[\w\*\(\)\/><\:\-\+`\$\s]+";

/// Signal/variable declaration pattern
pub static RE_DECL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|,|(?:\w|\)|#)\s*\(|;)\s*(?:const\s+)?(\w+\s+)?(\w+\s+)?(\w+\s+)?\
         ([A-Za-z_][\w\:\.]*\b\s*)((?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\]\s*)*)\
         ((?:[A-Za-z_]\w*(?:\s*\[[^=\^\&\|,;]*?\]\s*)?(?:\=\s*[\w\.\:]+\s*)?,\s*)*)\b",
    )
    .unwrap()
});

/// Enum declaration pattern
pub static RE_ENUM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*(typedef\s+)?(enum)\s+(\w+\s*)?(\[[\w\*\(\)\/><\:\-\+`\$\s]+\])?\s*(\{[^\}]+\})\s*([A-Za-z_][\w=,\s]*,\s*)?\b"
    )
    .unwrap()
});

/// Struct/union declaration pattern
pub static RE_UNION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*(typedef\s+)?(struct|union|`\w+)\s+(packed\s+)?(signed|unsigned)?\s*\
         (\{[\w,;\s`\[\:\]\/\*\+\-><\(\)\$]+\})\s*([A-Za-z_][\w=,\s]*,\s*)?\b",
    )
    .unwrap()
});

/// Typedef pattern
pub static RE_TDP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(typedef\s+)(\w+)\s*(#\s*\(.*?\))?\s*()\b").unwrap());

/// Instance pattern
pub static RE_INST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(virtual)?(\s*)()(\w+)\s*(#\s*\([^;]+\))?\s*()\b").unwrap());

/// Parameter definition pattern
pub static RE_PARAM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*parameter\b((?:\s*(?:\w+\s+)?(?:[A-Za-z_]\w+)\s*=\s*(?:[^,;]*)\s*,)*\
         )(\s*(\w+\s+)?([A-Za-z_]\w+)\s*=\s*([^,;]*)\s*;)",
    )
    .unwrap()
});

/// Port direction list
pub const PORT_DIRS: &[&str] = &["input", "output", "inout", "ref"];

/// Full signal declaration regex (from VerilogBeautifier.__init__)
pub static RE_DECL_FULL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^[ \t]*(?:\(\*.*?\*\)[ \t]*)*(?:(?P<param>localparam|parameter|local|protected)\s+)?(?P<scope>\w+\:\:)?(?P<type>[A-Za-z_]\w*)[ \t]+(?P<sign>signed\b|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)?[ \t]*(?P<name>[A-Za-z_]\w*)[ \t]*(?P<array>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)?(=\s*(?P<init>[^;]+))?(?P<sig_list>,[\w, \t]*)?;[ \t]*(?P<comment>.*)"#,
    )
    .unwrap()
});

/// 紧凑声明（类型与位宽之间无空格、无初值）：`logic[ID_W-1:0] awid;`
/// 命中后由 align_decl 规范化（补类型后空格、位宽右对齐、名字/分号列对齐）；
/// 带初值的紧凑声明（`logic[7:0] sum=0;`）不匹配，保持原样。
pub static RE_DECL_COMPACT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^[ \t]*(?:\(\*.*?\*\)[ \t]*)*(?:(?P<param>localparam|parameter|local|protected)\s+)?(?P<scope>\w+\:\:)?(?P<type>[A-Za-z_]\w*)(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)+)(?P<name>[A-Za-z_]\w*)[ \t]*(?P<array>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)?;[ \t]*(?P<comment>.*)"#,
    )
    .unwrap()
});

/// 声明行判定：完整声明（类型与位宽之间可有空格）或紧凑声明。
pub fn is_decl_line(line: &str) -> bool {
    RE_DECL_FULL.is_match(line) || RE_DECL_COMPACT.is_match(line)
}

/// 紧凑声明规范化：在类型与位宽之间补一个空格，使既有的 align_decl
/// （要求 `type` 后跟空白）可以识别并参与对齐。非紧凑声明原样返回。
pub fn normalize_compact_decl(line: &str) -> String {
    if !RE_DECL_COMPACT.is_match(line) {
        return line.to_string();
    }
    if let Some(c) = RE_DECL_COMPACT.captures(line) {
        let type_m = c.name("type").unwrap();
        let bw_m = c.name("bw").unwrap();
        if type_m.end() == bw_m.start() {
            let mut out = String::with_capacity(line.len() + 1);
            out.push_str(&line[..type_m.end()]);
            out.push(' ');
            out.push_str(&line[type_m.end()..]);
            return out;
        }
    }
    line.to_string()
}

/// Module instance regex (supports with/without port connections)
/// Matches: type [params] name ( or type [params] name ;
pub static RE_INST_FULL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)^[ \t]*\b(?P<itype>\w+)\s*(#\s*\([^;]+\))?\s*\b(?P<iname>\w+)\s*(\(|;)")
        .unwrap()
});

// ── Beautifier block keywords ───────────────────────────────────

pub const KW_BLOCK: &[&str] = &[
    "module",
    "class",
    "interface",
    "program",
    "function",
    "task",
    "package",
    "case",
    "casex",
    "casez",
    "generate",
    "covergroup",
    "property",
    "sequence",
    "checker",
    "fork",
    "begin",
    "{",
    "(",
];

pub const KW_BLOCK_WITH_TICK: &[&str] = &[
    "module",
    "class",
    "interface",
    "program",
    "function",
    "task",
    "package",
    "case",
    "casex",
    "casez",
    "generate",
    "covergroup",
    "property",
    "sequence",
    "checker",
    "fork",
    "begin",
    "{",
    "(",
    "`ifdef",
    "`ifndef",
    "`elsif",
    "`else",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_re_decl_full() {
        // Test the actual RE_DECL_FULL
        let test_cases = vec!["wire [511:0] pl_awdata ;", "wire pl_awlast ;"];
        for tc in test_cases {
            assert!(RE_DECL_FULL.is_match(tc), "Failed to match: {}", tc);
        }
    }
}

/// 行尾悬空运算符（assign/表达式破行续行判定，issue #3）：
/// "a ||" / "a +" / "a ?" 等行尾运算符表示语句未写完，下一行仍是同一语句。
pub static RE_LINE_ENDS_WITH_OP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\|\||&&|<<|>>|\*\*|[-+*/%&|^:?])\s*$").unwrap()
});
