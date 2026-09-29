//! 空行规则 pass —— `docs/FORMAT_SPEC.md` §6 的权威实现。
//!
//! 在 beautifier 输出之后统一裁决空行（替代单纯折叠的 postprocess）：
//! - **块内无空行**：task/function/property/sequence/covergroup/clocking 体、
//!   begin/end、fork/join、case/endcase 体、`()/{}` 多行续行内，删除所有空行；
//! - **块间空行分隔**：容器级相邻内容中有一方是块级行（块头/块闭合/多行语句
//!   收尾 `);`）时，保证空行数在 `[1, max]`；
//! - **语句间保留折叠**：声明类语句之间不插入空行，用户空行折叠至 max；
//! - `max < 0`：完全不处理（原样返回）。
//!
//! 注释与字符串字面量不参与结构判定；`/* */` 内部空行原样保留。

/// 上下文种类。Container 之间的空行受规则管辖；其余（NoBlank 族）体内删空行。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Ctx {
    Container,
    Begin,
    Fork,
    Case,
    Task,
    Func,
    Prop,
    Seq,
    Cov,
    Clk,
    Table,
    Spec,
}

impl Ctx {
    fn is_container(self) -> bool {
        matches!(self, Ctx::Container)
    }
}

/// 声明修饰字：寻找行首有效关键字时跳过。
const QUALIFIERS: &[&str] = &[
    "virtual",
    "static",
    "protected",
    "local",
    "automatic",
    "unique",
    "priority",
    "rand",
    "randc",
    "const",
];

/// 容器开启关键字（成员间空行受 §6.2/6.3 管辖）。
const CONTAINER_OPEN: &[&str] = &[
    "module",
    "interface",
    "package",
    "class",
    "program",
    "config",
    "checker",
    "generate",
];

/// 块头关键字（§6.2 块级行之"块头行"）。
const BLOCK_OPEN_KW: &[&str] = &[
    "task",
    "function",
    "always",
    "always_ff",
    "always_comb",
    "always_latch",
    "initial",
    "final",
    "covergroup",
    "clocking",
    "property",
    "sequence",
    "generate",
    "fork",
];

/// 块闭合关键字（§6.2 块级行之"块闭合行"）。容器闭合（endmodule 等）不算：
/// 容器末尾空行只保留折叠、不插入。
const BLOCK_CLOSE_KW: &[&str] = &[
    "end", "endtask", "endfunction", "endproperty", "endsequence", "endgroup", "endclocking",
    "endgenerate", "join", "join_any", "join_none",
];

fn close_kw_ctx(w: &str) -> Option<Ctx> {
    match w {
        "endmodule" | "endinterface" | "endpackage" | "endclass" | "endprogram" | "endconfig"
        | "endchecker" | "endgenerate" => Some(Ctx::Container),
        "end" => Some(Ctx::Begin),
        "join" | "join_any" | "join_none" => Some(Ctx::Fork),
        "endcase" => Some(Ctx::Case),
        "endtask" => Some(Ctx::Task),
        "endfunction" => Some(Ctx::Func),
        "endproperty" => Some(Ctx::Prop),
        "endsequence" => Some(Ctx::Seq),
        "endgroup" => Some(Ctx::Cov),
        "endclocking" => Some(Ctx::Clk),
        "endtable" => Some(Ctx::Table),
        "endspecify" => Some(Ctx::Spec),
        _ => None,
    }
}

/// 头部类开启关键字：只在行首有效字位置生效（避免 `with function sample`、
/// `assert property (...)` 的中途出现被误判为块开始）。
fn header_kw_ctx(w: &str) -> Option<Ctx> {
    match w {
        "task" => Some(Ctx::Task),
        "function" => Some(Ctx::Func),
        "property" => Some(Ctx::Prop),
        "sequence" => Some(Ctx::Seq),
        "covergroup" => Some(Ctx::Cov),
        "clocking" => Some(Ctx::Clk),
        "table" => Some(Ctx::Table),
        "specify" => Some(Ctx::Spec),
        "module" | "interface" | "package" | "class" | "program" | "config" | "checker"
        | "generate" => Some(Ctx::Container),
        _ => None,
    }
}

/// 中途也可生效的配对关键字（begin/fork/case 常出现在行中）。
fn inline_open_kw_ctx(w: &str) -> Option<Ctx> {
    match w {
        "begin" => Some(Ctx::Begin),
        "fork" => Some(Ctx::Fork),
        "case" | "casex" | "casez" => Some(Ctx::Case),
        _ => None,
    }
}

/// 注释/字符串剔除后的行 + 跨行块注释状态。
/// 保留原行长度与结构（注释与字符串字面量内容置为空格），
/// 使括号计数与关键字提取不受字面量干扰。
fn strip_comments(line: &str, in_block: bool) -> (String, bool) {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut in_block = in_block;
    let mut in_str = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_block {
            if c == '*' && i + 1 < chars.len() && chars[i + 1] == '/' {
                out.push(' ');
                out.push(' ');
                i += 2;
                in_block = false;
            } else {
                out.push(' ');
                i += 1;
            }
        } else if in_str {
            if c == '\\' && i + 1 < chars.len() {
                out.push(' ');
                out.push(' ');
                i += 2;
            } else {
                if c == '"' {
                    in_str = false;
                }
                out.push(' ');
                i += 1;
            }
        } else if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            // 行注释：本行剩余部分全部置空
            for _ in i..chars.len() {
                out.push(' ');
            }
            break;
        } else if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            out.push(' ');
            out.push(' ');
            i += 2;
            in_block = true;
        } else if c == '"' {
            in_str = true;
            out.push(' ');
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    (out, in_block)
}

/// 提取标识符/关键字序列（SV 标识符含字母数字下划线与 `$`）。
fn extract_words(clean: &str) -> Vec<&str> {
    let mut words = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in clean.char_indices() {
        if c.is_alphanumeric() || c == '_' || c == '$' {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start.take() {
            words.push(&clean[s..i]);
        }
    }
    if let Some(s) = start {
        words.push(&clean[s..]);
    }
    words
}

struct LineInfo {
    /// 行首第一个词（未跳过修饰字），用于块闭合判定。
    first_word: String,
    /// 行首第一个有效关键字（跳过修饰字），用于块头判定。
    first_sig: String,
    /// 该词之前是否出现 pure/extern（原型声明，无块体）。
    proto: bool,
    is_comment: bool,
    ends_semi: bool,
    has_begin: bool,
    /// 本行把括号深度从 >0 收到 0 且以 `)` 开头（多行语句收尾行，如 `);`）。
    paren_closed: bool,
    /// 本行处理完后的状态快照。
    ctx: Vec<Ctx>,
    paren: i32,
    brace: i32,
    in_block: bool,
}

impl LineInfo {
    fn is_blank(line: &str) -> bool {
        line.trim().is_empty()
    }

    /// §6.2 块级行（作为相邻内容的后者 / 块头侧）。
    fn block_open_side(&self) -> bool {
        !self.is_comment
            && (BLOCK_OPEN_KW.contains(&self.first_sig.as_str())
                || BLOCK_CLOSE_KW.contains(&self.first_word.as_str())
                || self.paren_closed)
    }

    /// §6.2 块级行（作为相邻内容的前者 / 块收尾侧）：块闭合行、多行语句收尾，
    /// 或"完整"的块头行（以 `;` 结束的单行块头 / 带 begin 的块头）。
    fn block_close_side(&self) -> bool {
        !self.is_comment
            && (BLOCK_CLOSE_KW.contains(&self.first_word.as_str())
                || self.paren_closed
                || (BLOCK_OPEN_KW.contains(&self.first_sig.as_str())
                    && !self.proto
                    && (self.ends_semi || self.has_begin)))
    }

    fn in_noblank(&self) -> bool {
        self.ctx.iter().any(|c| !c.is_container()) || self.paren > 0 || self.brace > 0
    }
}

/// 空行规则主入口。`max_empty` 语义见 spec §3/§6。
pub fn normalize_blank_lines(text: &str, max_empty: i32) -> String {
    if max_empty < 0 {
        return text.to_string();
    }
    let max = max_empty as usize;

    let lines: Vec<&str> = text.split('\n').collect();
    if lines.is_empty() {
        return text.to_string();
    }

    // ── 第一遍：逐行扫描，得到结构信息与行后状态快照 ──
    let mut in_block = false;
    let mut paren = 0i32;
    let mut brace = 0i32;
    let mut ctx: Vec<Ctx> = Vec::new();
    let mut infos: Vec<LineInfo> = Vec::with_capacity(lines.len());

    for line in &lines {
        let (clean, nb) = strip_comments(line, in_block);
        let paren_before = paren;
        let brace_open = clean.matches('{').count() as i32;
        let brace_close = clean.matches('}').count() as i32;
        paren += clean.matches('(').count() as i32 - clean.matches(')').count() as i32;
        brace += brace_open - brace_close;

        let words = extract_words(&clean);
        let mut first_word = String::new();
        let mut first_sig = String::new();
        let mut proto = false;
        let mut has_begin = false;

        for w in &words {
            if first_word.is_empty() {
                first_word = w.to_string();
            }
            if *w == "pure" || *w == "extern" {
                proto = true;
            }
            if *w == "begin" {
                has_begin = true;
            }
            if first_sig.is_empty() {
                if QUALIFIERS.contains(w) {
                    continue;
                }
                first_sig = w.to_string();
            }
        }

        // 上下文栈推进：闭合词逐词弹，开启词按位置规则压。
        // 头部类关键字只在"行首深度 0"时压——多行列表（modport 的
        // `clocking drv_cb`、`import "DPI-C"` 等）续行中的同名关键字
        // 不是块头，误压会导致上下文永不闭合、后续空行被整段删除
        for w in &words {
            if let Some(kind) = close_kw_ctx(w) {
                // 防御：栈不匹配时仍弹栈顶（畸形输入不崩溃）
                if ctx.last() == Some(&kind) || ctx.iter().any(|c| *c == kind) {
                    while let Some(top) = ctx.pop() {
                        if top == kind {
                            break;
                        }
                    }
                }
            } else if let Some(kind) = inline_open_kw_ctx(w) {
                ctx.push(kind);
            } else if !w.is_empty() && *w == first_sig && paren_before == 0 {
                // 头部类关键字仅行首有效字位置压栈；pure/extern 原型无体不压
                if !proto {
                    if let Some(kind) = header_kw_ctx(w) {
                        ctx.push(kind);
                    }
                }
            }
        }

        let is_comment = !LineInfo::is_blank(line) && clean.trim().is_empty();
        infos.push(LineInfo {
            first_word,
            first_sig,
            proto,
            is_comment,
            ends_semi: clean.trim_end().ends_with(';'),
            has_begin,
            paren_closed: paren_before > 0 && paren == 0 && clean.trim_start().starts_with(')'),
            ctx: ctx.clone(),
            paren,
            brace,
            in_block: nb,
        });

        in_block = nb;
    }

    // ── 第二遍：按间隔（空行串）裁决输出 ──
    // 预计算：每个非空行的"组头"——其后第一行非注释代码（注释归属后随语句，§6.4）
    let n = lines.len();
    let mut next_code: Vec<Option<usize>> = vec![None; n];
    let mut pending_code: Option<usize> = None;
    for i in (0..n).rev() {
        next_code[i] = pending_code;
        if !LineInfo::is_blank(lines[i]) && !infos[i].is_comment {
            pending_code = Some(i);
        }
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut pending_blanks: Vec<&str> = Vec::new();
    // 上一个非空行的下标（infos 中）
    let mut last_nonblank: Option<usize> = None;
    // split 的最后一个空元素是行尾终止符（文本以 \n 结尾时），不是空行
    let terminator = lines.len() - 1;

    for (i, line) in lines.iter().enumerate() {
        // split 的最后一个空元素是行尾终止符（文本以 \n 结尾时），不是空行。
        // 文件末尾不留空行（spec §6.5）：仅块注释未闭合时原样保留
        if i == terminator && line.is_empty() {
            if let Some(a) = last_nonblank.map(|k| &infos[k]) {
                if a.in_block {
                    for l in &pending_blanks {
                        out.push((*l).to_string());
                    }
                }
            }
            out.push(String::new());
            pending_blanks.clear();
            continue;
        }
        if LineInfo::is_blank(line) {
            pending_blanks.push(line);
            continue;
        }
        flush_gap(
            &infos,
            &next_code,
            last_nonblank,
            i,
            &pending_blanks,
            max,
            &mut out,
        );
        pending_blanks.clear();
        out.push((*line).to_string());
        last_nonblank = Some(i);
    }
    // EOF（文本不以 \n 结尾时的残余空行）：不留（§6.5）

    out.join("\n")
}

/// 裁决非空行 i（A）与非空行 j（B）之间的空行串。
#[allow(clippy::too_many_arguments)]
fn flush_gap(
    infos: &[LineInfo],
    next_code: &[Option<usize>],
    a_idx: Option<usize>,
    b_idx: usize,
    blanks: &[&str],
    max: usize,
    out: &mut Vec<String>,
) {
    let run = blanks.len();
    let a = a_idx.map(|i| &infos[i]);

    // 文件首：只折叠、不插入
    let Some(a) = a else {
        let keep = run.min(max);
        for l in blanks.iter().take(keep) {
            out.push((*l).to_string());
        }
        return;
    };

    // 块注释内部：原样保留（spec §10.2）
    if a.in_block {
        for l in blanks {
            out.push((*l).to_string());
        }
        return;
    }

    // 块内（NoBlank 上下文 / 括号花括号续行）：删除所有空行（spec §6.1）
    if a.in_noblank() {
        return;
    }

    let b = &infos[b_idx];

    // if/else 链延续：行首 `else`/`else if` 与其前的 `end` 同属一条语句，
    // 中间不留空行（spec §6.2 注）
    if b.first_word == "else" {
        return;
    }

    // 容器级（spec §6.2 / §6.3）。注释归属其后随语句（§6.4）：
    // B 为注释串时，块头判定看向注释串之后的第一行代码。
    // 容器头与其首个成员之间、容器闭合行之前不插入（§6.2 注）。
    let a_opens_container = CONTAINER_OPEN.contains(&a.first_sig.as_str());
    let b_closes_container = matches!(close_kw_ctx(&b.first_word), Some(Ctx::Container));
    let b_group_opens = if b.is_comment {
        next_code
            .get(b_idx)
            .and_then(|k| *k)
            .map(|k| infos[k].block_open_side())
            .unwrap_or(false)
    } else {
        b.block_open_side()
    };
    let need = (a.block_close_side() && !b_closes_container)
        || (b_group_opens && !a.is_comment && !a_opens_container);
    let keep = if need {
        run.max(1).min(max)
    } else {
        run.min(max)
    };
    for l in blanks.iter().take(keep) {
        out.push((*l).to_string());
    }
    // run < keep（插入）时补空行
    if run < keep {
        for _ in 0..(keep - run) {
            out.push(String::new());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(s: &str) -> String {
        normalize_blank_lines(s, 1)
    }

    #[test]
    fn test_task_body_blanks_deleted() {
        let input = "module m;\n    task t();\n\n        int a;\n\n        a = 1;\n\n    endtask\nendmodule\n";
        let out = norm(input);
        assert_eq!(
            out,
            "module m;\n    task t();\n        int a;\n        a = 1;\n    endtask\nendmodule\n"
        );
    }

    #[test]
    fn test_blank_inserted_after_block_close() {
        let input = "module m;\n    task t();\n        a = 1;\n    endtask\n    constraint c { x > 0; }\nendmodule\n";
        let out = norm(input);
        assert!(out.contains("    endtask\n\n    constraint c"), "{}", out);
    }

    #[test]
    fn test_statements_stay_adjacent() {
        let input = "module m;\n    logic a;\n    logic b;\n    constraint c1 { x > 0; }\n    constraint c2 { y > 0; }\nendmodule\n";
        let out = norm(input);
        assert_eq!(input, out);
    }

    #[test]
    fn test_decl_blanks_collapsed_not_inserted() {
        let input = "module m;\n    logic a;\n\n\n    logic b;\n    logic c;\nendmodule\n";
        let out = norm(input);
        assert_eq!(
            out,
            "module m;\n    logic a;\n\n    logic b;\n    logic c;\nendmodule\n"
        );
    }

    #[test]
    fn test_comment_attaches_to_following_block() {
        // 注释与 task 之间不插入；endtask 与注释之间插入（注释归属后随语句）
        let input = "module m;\n    task t();\n        a = 1;\n    endtask\n    // next\n    task u();\n        b = 2;\n    endtask\nendmodule\n";
        let out = norm(input);
        assert!(out.contains("    endtask\n\n    // next\n    task u();"), "{}", out);
    }

    #[test]
    fn test_begin_end_interior_deleted() {
        let input = "module m;\n    always @(posedge clk) begin\n\n        a <= b;\n\n    end\nendmodule\n";
        let out = norm(input);
        assert_eq!(
            out,
            "module m;\n    always @(posedge clk) begin\n        a <= b;\n    end\nendmodule\n"
        );
    }

    #[test]
    fn test_clocking_interior_deleted() {
        let input = "interface bus_if;\n    clocking cb @(posedge clk);\n        input ready;\n\n    endclocking\n\n    modport drv(cb);\nendinterface\n";
        let out = norm(input);
        assert!(!out.contains("input ready;\n\n    endclocking"), "{}", out);
        assert!(out.contains("    endclocking\n\n    modport"), "{}", out);
    }

    #[test]
    fn test_instance_port_interior_deleted() {
        let input = "module m;\n    bus_if i (\n\n        .clk(clk)\n\n    );\n\n    logic a;\nendmodule\n";
        let out = norm(input);
        assert_eq!(
            out,
            "module m;\n    bus_if i (\n        .clk(clk)\n    );\n\n    logic a;\nendmodule\n"
        );
    }

    #[test]
    fn test_block_comment_interior_untouched() {
        let input = "module m;\n/* head\n\n\nbody */\n    logic a;\nendmodule\n";
        let out = norm(input);
        assert_eq!(input, out);
    }

    #[test]
    fn test_max_zero_removes_allowed_blanks() {
        let input = "module m;\n    task t();\n        a = 1;\n    endtask\n\n    task u();\n        b = 2;\n    endtask\nendmodule\n";
        let out = normalize_blank_lines(input, 0);
        assert_eq!(
            out,
            "module m;\n    task t();\n        a = 1;\n    endtask\n    task u();\n        b = 2;\n    endtask\nendmodule\n"
        );
    }

    #[test]
    fn test_negative_passthrough() {
        let input = "module m;\n\n\n\n    logic a;\nendmodule\n";
        assert_eq!(normalize_blank_lines(input, -1), input);
    }

    #[test]
    fn test_module_close_no_insertion() {
        // endmodule 前不插入空行，已有的保留折叠
        let input = "module m;\n    logic a;\nendmodule\n";
        assert_eq!(norm(input), input);
        let input2 = "module m;\n    task t();\n        a = 1;\n    endtask\nendmodule\n";
        let out = norm(input2);
        assert!(out.contains("    endtask\nendmodule"), "{}", out);
    }

    #[test]
    fn test_covergroup_sample_clause_not_pushed() {
        // `with function sample(...)` 的中途 function 不应开启 Func 上下文
        let input = "module m;\n    covergroup cg with function sample(int p);\n        option.per_instance = 1;\n    endgroup\n\n    logic a;\nendmodule\n";
        let out = norm(input);
        // covergroup 体内无空行（已有规则）；endgroup 后与 logic 之间保留
        assert!(out.contains("option.per_instance = 1;\n    endgroup\n\n    logic a;"), "{}", out);
    }

    #[test]
    fn test_consecutive_blocks_blank_kept() {
        let input = "module m;\n    always #5 clk = ~clk;\n\n    logic a;\nendmodule\n";
        let out = norm(input);
        assert_eq!(input, out);
        // 缺失时插入（always 单行块头是完整块级行）
        let input2 = "module m;\n    always #5 clk = ~clk;\n    logic a;\nendmodule\n";
        let out2 = norm(input2);
        assert!(out2.contains("always #5 clk = ~clk;\n\n    logic a;"), "{}", out2);
    }
}
