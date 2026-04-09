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
        r"^[ \t]*(?:(?P<param>localparam|parameter|local|protected)\s+)?\
         (?P<scope>\w+\:\:)?\
         (?P<type>[A-Za-z_]\w*)[ \t]+\
         (?P<sign>signed\b|unsigned\b)?[ \t]*\
         (?P<bw>(?:\[([\w\*\(\)\/><\:\-\+`\$\s]+)\][ \t]*)*)\
         [ \t]*(?P<name>[A-Za-z_]\w*)[ \t]*\
         (?P<array>(?:\[([\w\*\(\)\/><\:\-\+`\$\s]+)\][ \t]*)*)\
         (=\s*(?P<init>[^;]+))?\
         (?P<sig_list>,[\w, \t]*)?;\
         [ \t]*(?P<comment>.*)",
    )
    .unwrap()
});

/// Module instance regex
pub static RE_INST_FULL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)^[ \t]*\b(?P<itype>\w+)\s*(#\s*\([^;]+\))?\s*\b(?P<iname>\w+)\s*\(").unwrap()
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
