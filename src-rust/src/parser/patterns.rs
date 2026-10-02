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
/// 行中块注释（`wire x /* synthesis */;`）会遮蔽声明形态，导致 Decl 组
/// 提前 flush、属性前缀与声明被拆到两组——判定前先剥离块注释。
pub fn is_decl_line(line: &str) -> bool {
    let stripped = strip_block_comments(line);
    RE_DECL_FULL.is_match(&stripped) || RE_DECL_COMPACT.is_match(&stripped)
}

/// 剥离行内 `/* */` 块注释（替换为单个空格；未闭合的保守返回原文）。
fn strip_block_comments(line: &str) -> String {
    if !line.contains("/*") {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("*/") {
            Some(end) => {
                out.push(' ');
                rest = &rest[start + 2 + end + 2..];
            }
            None => return line.to_string(),
        }
    }
    out.push_str(rest);
    out
}

/// SV 块构造头（sequence/property/checker，由 endsequence/endproperty/
/// endchecker 闭合）。形如声明（`sequence s_handshake;`）但不是数据声明，
/// 不得进 Decl 对齐——否则块头与块体之间会多出一个空行。
pub fn is_sv_block_header(line: &str) -> bool {
    let t = line.trim_start();
    ["sequence", "property", "checker"].iter().any(|k| {
        t.starts_with(k)
            && t[k.len()..]
                .starts_with(|c: char| c.is_whitespace() || c == '(')
    })
}

/// 声明行判定（排除块构造头）。
pub fn is_decl_line_excl_blocks(line: &str) -> bool {
    is_decl_line(line) && !is_sv_block_header(line)
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

/// 实例化头（带端口括号）：`itype [#(params)] iname (`。
/// 比 RE_INST_FULL 窄——不含 `iname ;` 备选，普通声明（含 `mailbox #(...) mb;`
/// 这类无端口括号的参数化声明）不匹配。用于把实例行从声明分类中排除：
/// 实例行曾被 is_decl_line 误判为声明，走了"置 Decl 状态不 flush"分支，
/// 连续单行实例被攒进同一次对齐调用（粘连/展开错误的根源）。
pub static RE_INST_PORTS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)^[ \t]*\b(?P<itype>\w+)\s*(#\s*\([^;]+\))?\s*\b(?P<iname>\w+)\s*\(")
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
    "clocking",
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
    "clocking",
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
