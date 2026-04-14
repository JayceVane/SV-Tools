use std::collections::HashMap;

use regex::Regex;

use crate::config::FormatOptions;
use crate::parser::comments::clean_comment;
use crate::parser::patterns::*;
use crate::tokenizer::Token;

// ── Block State ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum BlockState {
    None,
    Text,
    Decl,
    Module,
    Interface,
    Instance,
    Struct,
    StructAssign,
    Enum,
    Assign,
    Always { always_state: AlwaysState },
    Package,
    Generate,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AlwaysState {
    None,
    If,
    ExpectElse,
    Else,
}

impl BlockState {
    pub fn is_none(&self) -> bool {
        matches!(self, BlockState::None)
    }

    pub fn as_str(&self) -> &str {
        match self {
            BlockState::None => "",
            BlockState::Text => "text",
            BlockState::Decl => "decl",
            BlockState::Module => "module",
            BlockState::Interface => "interface",
            BlockState::Instance => "instance",
            BlockState::Struct => "struct",
            BlockState::StructAssign => "struct_assign",
            BlockState::Enum => "enum",
            BlockState::Assign => "assign",
            BlockState::Always { .. } => "always",
            BlockState::Package => "package",
            BlockState::Generate => "generate",
        }
    }
}

// ── Split Info ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct SplitInfo {
    count: usize,
    text: String,
}

// ── Word History ────────────────────────────────────────────────

/// Circular buffer of last 4 tokens (matching Python's w_d list)
#[derive(Debug, Clone)]
struct WordHistory {
    buf: [String; 4],
}

impl WordHistory {
    fn new() -> Self {
        Self {
            buf: std::array::from_fn(|_| "\n".to_string()),
        }
    }

    fn push(&mut self, w: &str) {
        self.buf[0] = self.buf[1].clone();
        self.buf[1] = self.buf[2].clone();
        self.buf[2] = self.buf[3].clone();
        self.buf[3] = w.to_string();
    }

    /// w_d[-1]
    fn last(&self) -> &str {
        &self.buf[3]
    }
    /// w_d[-2]
    fn prev1(&self) -> &str {
        &self.buf[2]
    }
    /// w_d[-3]
    fn prev2(&self) -> &str {
        &self.buf[1]
    }
    /// w_d[-4]
    fn prev3(&self) -> &str {
        &self.buf[0]
    }
}

// ── Beautifier ──────────────────────────────────────────────────

pub struct VerilogBeautifier {
    options: FormatOptions,
    indent: String,
    indent_space: String,
    kw_block: Vec<String>,

    // State
    states: Vec<String>,
    state: String,
    block_state: BlockState,
    always_state: AlwaysState,
}

impl VerilogBeautifier {
    pub fn new(options: FormatOptions) -> Self {
        let indent_space = " ".repeat(options.nb_space());
        let indent = if options.use_tab() {
            "\t".to_string()
        } else {
            indent_space.clone()
        };

        let kw_block = if options.ignore_tick() {
            KW_BLOCK.iter().map(|s| s.to_string()).collect()
        } else {
            KW_BLOCK_WITH_TICK.iter().map(|s| s.to_string()).collect()
        };

        Self {
            options,
            indent,
            indent_space,
            kw_block,
            states: Vec::new(),
            state: String::new(),
            block_state: BlockState::None,
            always_state: AlwaysState::None,
        }
    }

    /// Main formatting entry point — replicates `beautifyText`
    pub fn beautify_text(&mut self, txt: &str) -> String {
        self.states.clear();
        self.state.clear();
        self.block_state = BlockState::None;
        self.always_state = AlwaysState::None;

        let mut w_d = WordHistory::new();
        let mut line = String::new();
        let mut block = String::new();
        let mut original_indent = String::new();
        let mut block_handled = false;
        let mut block_ended = false;
        let mut txt_new = String::new();
        let mut ilvl = Self::get_indent_level(txt, &self.options, &self.indent, &self.indent_space);
        let mut ilvl_prev = ilvl;
        let mut has_indent = ilvl != 0;
        let mut line_cnt: usize = 1;
        let mut split: HashMap<usize, SplitInfo> = HashMap::new();
        let mut split_always: usize = 0;
        let mut last_split: Option<SplitInfo> = None;
        let mut split_else = false;

        let tokens = crate::tokenizer::tokenize(txt);

        for token in &tokens {
            let w = match token {
                Token::Word(s) => s.as_str(),
                Token::Punct(c) => {
                    let s = c.to_string();
                    // leak to get 'static lifetime - safe because we only use it temporarily
                    Box::leak(s.into_boxed_str())
                }
                Token::Space(s) => s.as_str(),
                Token::Newline => "\n",
            };

            let state_end = self.is_state_end(w);

            // Handle if/else in split statement
            if w == "else" && split_else {
                if let Some(ref ls) = last_split {
                    split.insert(ilvl, ls.clone());
                }
            } else if !w.trim().is_empty() {
                split_else = false;
            }

            // Start of line?
            if w_d.last() == "\n" {
                ilvl_prev = ilvl;
                if w.trim().is_empty() {
                    if w != "\n"
                        && matches!(self.block_state, BlockState::Module | BlockState::Interface)
                    {
                        block.push_str(w);
                    }
                    has_indent = w != "\n";
                }
                if state_end {
                    self.state_update(None);
                    assert!(ilvl > 0, "Block end with no indentation! Line {}", line_cnt);
                    ilvl -= 1;
                }

                // Handle end of block_state
                if matches!(self.block_state, BlockState::Assign)
                    && w != "assign"
                    && !w.starts_with(|c: char| c == ' ' || c == '\t')
                {
                    txt_new.push_str(&self.align_assign(&block, 2));
                    block.clear();
                    self.block_state = BlockState::None;
                } else if matches!(self.block_state, BlockState::Decl)
                    && [
                        "always",
                        "always_ff",
                        "always_comb",
                        "always_latch",
                        "constraint",
                        "assign",
                    ]
                    .contains(&w)
                {
                    if self.options.reindent_only() {
                        txt_new.push_str(&block);
                    } else {
                        txt_new.push_str(&self.align_decl(&block));
                    }
                    block.clear();
                    self.block_state = BlockState::None;
                }

                if self.options.ignore_tick()
                    && ["`ifdef", "`ifndef", "`elsif", "`else", "`endif"].contains(&w)
                {
                    self.state_update(Some("ignore_line".to_string()));
                    line.push_str(&original_indent);
                } else if !has_indent && self.state.starts_with('`') {
                    has_indent = true;
                }

                // Insert indentation
                if !matches!(self.block_state, BlockState::Module)
                    && !w.trim().is_empty()
                    && (!["comment_block", "attribute"].contains(&self.state.as_str())
                        || has_indent)
                    && self.state != "ignore_line"
                {
                    let mut ilvl_tmp = ilvl + split_always;
                    for (k, v) in &split {
                        ilvl_tmp += v.count;
                    }
                    line = self.indent.repeat(ilvl_tmp);
                }
            }

            // Handle end of split
            if split.contains_key(&ilvl) {
                if ![
                    "comment_line",
                    "ignore_line",
                    "comment_block",
                    "attribute",
                    "string",
                ]
                .contains(&self.state.as_str())
                    && (w == ";" || w == "end" || w == "endcase" || line.trim().starts_with('`'))
                {
                    last_split = split.remove(&ilvl);
                    if let Some(ref ls) = last_split {
                        split_else = w == "end" && ls.text.contains(':');
                    }
                }
            }

            // Newline handling
            if w == "\n" {
                block_ended = false;
                if ["comment_line", "ignore_line"].contains(&self.state.as_str()) {
                    self.state_update(None);
                    if self.block_state.is_none() {
                        block_handled = true;
                    }
                }

                // Split line detection
                if !["comment_block", "attribute", "{"].contains(&self.state.as_str())
                    && !matches!(
                        self.block_state,
                        BlockState::Module | BlockState::Instance | BlockState::Struct
                    )
                {
                    let block_c = clean_comment(&block);
                    let idx_eol = block_c.rfind('\n');
                    let mut last_line = line.clone();
                    if let Some(idx) = idx_eol {
                        if idx + 2 < block_c.len() {
                            last_line = format!("{}{}", &block_c[idx + 1..], line);
                        }
                    }
                    let tmp = clean_comment(&last_line).trim().to_string();

                    if !tmp.is_empty() {
                        let m = Regex::new(
                            r"(;|\{|\bend|\bendcase|\bendgenerate)$|^\}$|(begin(\s*\:\s*[\w\$]+)?)$|(case(?:x|z)?)\s*\(.*\)$|(`\w+)\s*(\(.*\))?$|^ *(`\w+)\b"
                        ).unwrap().find(&tmp);

                        if m.is_none() {
                            if tmp.starts_with("always") {
                                split_always = 1;
                            } else if ilvl == ilvl_prev && self.state != "(" {
                                if !split.contains_key(&ilvl) {
                                    if self.state == "case"
                                        && Regex::new(r"^\s*\w+\s*,$").unwrap().is_match(&tmp)
                                    {
                                        // Multiple state case
                                    } else {
                                        split.insert(
                                            ilvl,
                                            SplitInfo {
                                                count: 1,
                                                text: tmp.clone(),
                                            },
                                        );
                                    }
                                } else {
                                    let si = split.get(&ilvl).unwrap();
                                    if !si.text.trim().starts_with('@') {
                                        let m_assign =
                                            Regex::new(r"^\s*(assign\s+)?\w+\s*(<?=)\s*(.*)")
                                                .unwrap()
                                                .is_match(&si.text);
                                        let m_param = Regex::new(r"^\s*(localparam|parameter)\b")
                                            .unwrap()
                                            .is_match(&si.text);
                                        if !m_assign && !m_param {
                                            if let Some(si) = split.get_mut(&ilvl) {
                                                si.count += 1;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if matches!(self.block_state, BlockState::Decl)
                    && !RE_DECL_FULL.is_match(line.trim())
                {
                    if self.options.reindent_only() {
                        txt_new.push_str(&block);
                    } else {
                        txt_new.push_str(&self.align_decl(&block));
                    }
                    block.clear();
                    self.block_state = BlockState::None;
                }

                block.push_str(line.trim_end());
                block.push('\n');
                line.clear();
                original_indent.clear();
                has_indent = false;
                line_cnt += 1;
            } else if w_d.last() == "\n" && w.trim().is_empty() {
                original_indent.push_str(w);
            } else {
                // GNU style: begin on new line
                if ![
                    "comment_line",
                    "ignore_line",
                    "comment_block",
                    "attribute",
                    "string",
                ]
                .contains(&self.state.as_str())
                    && self.options.indent_style() == "gnu"
                {
                    if w == "begin" && !line.trim().is_empty() {
                        let mut ilvl_tmp = ilvl + split_always + 1;
                        for (_, v) in &split {
                            ilvl_tmp += v.count;
                        }
                        if !split.contains_key(&ilvl) {
                            let tmp = clean_comment(&line).trim().to_string();
                            split.insert(
                                ilvl,
                                SplitInfo {
                                    count: 1,
                                    text: tmp,
                                },
                            );
                        } else {
                            if let Some(si) = split.get_mut(&ilvl) {
                                si.count += 1;
                            }
                        }
                        line.push('\n');
                        line.push_str(&self.indent.repeat(ilvl_tmp));
                    } else if w == "else" && w_d.last() != "\n" && w_d.prev1() == "end" {
                        let mut ilvl_tmp = ilvl + split_always;
                        for (_, v) in &split {
                            ilvl_tmp += v.count;
                        }
                        line.push('\n');
                        line.push_str(&self.indent.repeat(ilvl_tmp));
                    }
                }

                if block_ended && !w.trim().is_empty() && (w != "/" || w_d.last() != "/") {
                    line = line.trim_end().to_string();
                    line.push('\n');
                    block_ended = false;
                }
                line.push_str(w);

                if ![
                    "comment_line",
                    "ignore_line",
                    "comment_block",
                    "attribute",
                    "string",
                ]
                .contains(&self.state.as_str())
                {
                    let action = self.process_word(w, &w_d, state_end, &(block.clone() + &line));
                    if action.starts_with("incr_ilvl") {
                        ilvl += 1;
                        if action == "incr_ilvl_flush" {
                            txt_new.push_str(&block);
                            block = line.clone();
                            line.clear();
                        }
                    }
                }
            }

            // Check module block for port declaration
            let mod_import =
                if matches!(self.block_state, BlockState::Module | BlockState::Interface)
                    && w == ";"
                {
                    let tmp = clean_comment(&(block.clone() + &line)).trim().to_string();
                    let m1 = Regex::new(r";\s*\(").unwrap().find(&tmp).is_some();
                    let m2 = Regex::new(r"\bimport\b").unwrap().find(&tmp).is_some();
                    m2 && !m1
                } else {
                    false
                };

            // Handle block_state on semicolon
            if w == ";"
                && ![
                    "comment_line",
                    "ignore_line",
                    "comment_block",
                    "attribute",
                    "string",
                    "(",
                ]
                .contains(&self.state.as_str())
                && !mod_import
            {
                let is_decl_match = RE_DECL_FULL.is_match(line.trim());

                // Handle declaration state - accumulate lines without processing
                // When block_state is Text/Decl/StructAssign and this is a declaration,
                // just set the state and continue (don't process yet)
                if matches!(
                    self.block_state,
                    BlockState::Text | BlockState::Decl | BlockState::StructAssign
                ) && is_decl_match
                {
                    self.block_state = BlockState::Decl;
                    // Don't set block_handled - let lines accumulate
                }
                // Handle other block states that need immediate processing
                else if matches!(
                    self.block_state,
                    BlockState::Module
                        | BlockState::Interface
                        | BlockState::Instance
                        | BlockState::Text
                        | BlockState::Package
                ) || (matches!(
                    self.block_state,
                    BlockState::Struct | BlockState::StructAssign | BlockState::Enum
                ) && self.state != "{")
                {
                    let mut skip_block_handled = false;
                    let block_tmp = match &self.block_state {
                        BlockState::Module | BlockState::Interface => {
                            let (result, remaining) =
                                self.align_module_port(&(block.clone() + &line), ilvl - 1);
                            line.clear();
                            block_ended = true;
                            // If there's remaining content after the module declaration,
                            // output result and set remaining as new block
                            if !remaining.is_empty() && !result.is_empty() {
                                txt_new.push_str(&result);
                                block = remaining;
                                self.block_state = BlockState::None;
                                skip_block_handled = true;
                            }
                            result
                        }
                        _ if self.options.reindent_only() => {
                            let result = block.clone() + &line;
                            line.clear();
                            result
                        }
                        BlockState::Instance => {
                            let input = block.clone() + &line;
                            let result = self.align_instance(&input, ilvl);
                            line.clear();
                            block_ended = true;
                            result
                        }
                        BlockState::Struct => {
                            let result = self.align_decl(&(block.clone() + &line));
                            line.clear();
                            result
                        }
                        BlockState::StructAssign => {
                            let result = self.align_assign(&(block.clone() + &line), 1);
                            line.clear();
                            result
                        }
                        BlockState::Enum => {
                            let result = self.align_assign(&(block.clone() + &line), 4);
                            line.clear();
                            result
                        }
                        _ => {
                            let result = block.clone() + &line;
                            line.clear();
                            result
                        }
                    };

                    if skip_block_handled {
                        continue;
                    }

                    if block_tmp.is_empty() {
                        // Unable to extract block content
                    } else {
                        block = block_tmp;
                    }
                    self.block_state = BlockState::None;
                    block_handled = true;
                }
            }

            // Handle state end
            if state_end {
                match &self.block_state {
                    BlockState::Generate => {
                        let mut block_tmp = block.clone();
                        if !self.options.reindent_only() {
                            for m in RE_INST_FULL.captures_iter(&block[9.min(block.len())..]) {
                                let itype = m.name("itype").map(|x| x.as_str()).unwrap_or("");
                                let iname = m.name("iname").map(|x| x.as_str()).unwrap_or("");
                                if !["else", "begin", "end"].contains(&itype)
                                    && !["if", "for", "foreach"].contains(&iname)
                                {
                                    let inst_start = 9 + m.get(0).unwrap().start();
                                    let inst_end = block[inst_start..]
                                        .find(';')
                                        .map(|p| inst_start + p + 1)
                                        .unwrap_or(block.len());
                                    if inst_end > inst_start {
                                        let inst_block = &block[inst_start..inst_end];
                                        let inst_ilvl = Self::get_indent_level(
                                            inst_block,
                                            &self.options,
                                            &self.indent,
                                            &self.indent_space,
                                        );
                                        let inst_aligned =
                                            self.align_instance(inst_block, inst_ilvl);
                                        block_tmp = block_tmp.replace(inst_block, &inst_aligned);
                                    }
                                }
                            }
                        }
                        block = block_tmp;
                        block_handled = true;
                    }
                    w if [
                        "endtask",
                        "endfunction",
                        "endsequence",
                        "endproperty",
                        "endclass",
                    ]
                    .contains(&w.as_str()) =>
                    {
                        if self.options.reindent_only() {
                            block = block + &line;
                        } else {
                            block = self.align_assign(&(block.clone() + &line), 1);
                        }
                        line.clear();
                        block_handled = true;
                    }
                    _ => {}
                }

                if w_d.last() != "\n" {
                    self.state_update(None);
                    assert!(ilvl > 0, "Block end with no indentation! Line {}", line_cnt);
                    ilvl -= 1;
                    if split.contains_key(&ilvl) && ["end", "endcase"].contains(&w) {
                        last_split = split.remove(&ilvl);
                        if let Some(ref ls) = last_split {
                            split_else = w == "end" && ls.text.contains(':');
                        }
                    }
                }
            }
            // Comment block end
            else if self.state == "comment_block" && w_d.last() == "*" && w == "/" {
                self.state_update(None);
                block.push_str(&line);
                line.clear();
                if self.block_state.is_none() {
                    block_handled = true;
                }
            }
            // Attribute end
            else if self.state == "attribute" && w_d.last() == "*" && w == ")" {
                if ilvl > 0 {
                    ilvl -= 1;
                }
                self.state_update(None); // pop "attribute" → back to "("
                                         // FIX: pop the residual "(" state since ")" was consumed here
                if self.state == "(" {
                    self.state_update(None);
                }
                block.push_str(&line);
                line.clear();
                // Don't flush the block - keep attribute in block so it stays
                // with the subsequent declaration/statement for alignment
            }
            // String end
            else if self.state == "string" && w == "\"" {
                self.state_update(None);
                block.push_str(&line);
                line.clear();
                if self.block_state.is_none() {
                    block_handled = true;
                }
            }
            // Identify start of comments/strings
            else if !["comment_line", "ignore_line", "attribute"].contains(&self.state.as_str()) {
                if w_d.last() == "/" {
                    if w == "/" {
                        self.state_update(Some("comment_line".to_string()));
                        block_ended = false;
                    } else if w == "*" {
                        self.state_update(Some("comment_block".to_string()));
                        block_ended = false;
                    }
                    if (line.trim() == "//" || line.trim() == "/*") && !has_indent {
                        line = line.trim().to_string();
                    }
                } else if w_d.last() == "(" && w == "*" {
                    // NOTE: Do NOT pop "(" here - it will be popped when attribute ends
                    // The "(" state tracks that we're inside parentheses, and "*)"
                    // closes the attribute, not the parenthesis.
                    self.state_update(Some("attribute".to_string()));
                    block_ended = false;
                } else if w == "\"" {
                    self.state_update(Some("string".to_string()));
                }
            }

            // Handle always block_state
            if matches!(self.block_state, BlockState::Always { .. })
                && (self.state.is_empty() || self.state == "module" || self.state == "interface")
            {
                let tmp = clean_comment(&(block.clone() + &line)).trim().to_string();
                let always_begin_re =
                    Regex::new(r"(?s)^\s*always\w*\s+(@\s*(\*|\([^\)]*\)))?\s*begin").unwrap();
                let m = always_begin_re.find(&tmp);

                let current_always_state = match &self.block_state {
                    BlockState::Always { always_state } => always_state.clone(),
                    _ => AlwaysState::None,
                };

                if (m.is_some() && w == "end")
                    || (matches!(current_always_state, AlwaysState::Else | AlwaysState::None)
                        && ["end", ";"].contains(&w))
                {
                    if self.options.reindent_only() {
                        block.push_str(&line);
                    } else {
                        block = self.align_assign(&(block.clone() + &line), 7);
                    }
                    line.clear();
                    block_handled = true;
                    self.always_state = AlwaysState::None;
                    split_always = 0;
                    self.block_state = BlockState::Always {
                        always_state: AlwaysState::None,
                    };
                } else if m.is_none() {
                    if w == "else" {
                        self.block_state = BlockState::Always {
                            always_state: AlwaysState::Else,
                        };
                    } else if matches!(current_always_state, AlwaysState::ExpectElse)
                        && !w.trim().is_empty()
                        && w != "/"
                    {
                        block = block + &line;
                        let last_sc = block.rfind(';').map(|p| p + 1).unwrap_or(0);
                        let last_end = block.rfind("end").map(|p| p + 3).unwrap_or(0);
                        let split_pos = last_sc.max(last_end);
                        line = block[split_pos..].to_string();
                        block = block[..split_pos].to_string();

                        if split_always == 1 {
                            let re_indent = Regex::new(&format!("^{}", self.indent)).unwrap();
                            line = re_indent.replace_all(&line, "").to_string();
                            self.block_state = BlockState::None;
                            let action = self.process_word(w, &w_d, state_end, &line);
                            if action.starts_with("incr_ilvl") {
                                ilvl += 1;
                                if action == "incr_ilvl_flush" {
                                    txt_new.push_str(&block);
                                    block = line.clone();
                                    line.clear();
                                }
                            }
                        }

                        if !self.options.reindent_only() {
                            block = self.align_assign(&block, 7);
                        }
                        if !w.starts_with("always") {
                            self.always_state = AlwaysState::None;
                        }
                        txt_new.push_str(&block);
                        block.clear();
                        split_always = 0;
                    } else if w == "if" {
                        self.block_state = BlockState::Always {
                            always_state: AlwaysState::If,
                        };
                    } else if matches!(current_always_state, AlwaysState::If)
                        && ["end", ";"].contains(&w)
                    {
                        self.block_state = BlockState::Always {
                            always_state: AlwaysState::ExpectElse,
                        };
                    }
                }
            }

            // Add block to text
            if block_handled {
                txt_new.push_str(&block);
                block.clear();
                self.block_state = BlockState::None;
                block_handled = false;
            }

            // Update word history
            if !w.trim().is_empty() || w_d.last() != "\n" {
                w_d.push(w);
            }
        }

        // Handle remaining content
        block.push_str(&line);

        if matches!(
            self.block_state,
            BlockState::Module
                | BlockState::Interface
                | BlockState::Instance
                | BlockState::Text
                | BlockState::Package
                | BlockState::Decl
                | BlockState::Assign
        ) || (matches!(
            self.block_state,
            BlockState::Struct | BlockState::StructAssign | BlockState::Enum
        ) && self.state != "{")
        {
            let block_tmp = match &self.block_state {
                BlockState::Module | BlockState::Interface => {
                    let (result, _remaining) = self.align_module_port(&block, ilvl - 1);
                    result
                }
                _ if self.options.reindent_only() => block.clone(),
                BlockState::Instance => self.align_instance(&block, ilvl),
                BlockState::Struct => self.align_decl(&block),
                BlockState::Assign => self.align_assign(&block, 2),
                BlockState::StructAssign => self.align_assign(&block, 1),
                BlockState::Decl => self.align_decl(&block),
                _ => block.clone(),
            };

            if block_tmp.is_empty() {
                // Unable to extract block content
            } else {
                block = block_tmp;
            }
        }

        txt_new.push_str(&block);
        txt_new
    }

    // ── State Management ────────────────────────────────────────

    fn state_update(&mut self, new_state: Option<String>) {
        if let Some(s) = new_state {
            self.states.push(s);
        } else {
            self.states.pop();
        }
        self.state = self.states.last().cloned().unwrap_or_default();
    }

    fn is_state_end(&self, w: &str) -> bool {
        if self.state == "begin" && w == "end" {
            return true;
        }
        if self.state == "covergroup" && w == "endgroup" {
            return true;
        }
        if self.state == "fork" && w.starts_with("join") {
            return true;
        }
        if self.state == "{" && w == "}" {
            return true;
        }
        if self.state == "(" && w == ")" {
            return true;
        }
        if self.state.starts_with('`') && ["`elsif", "`else", "`endif"].contains(&w) {
            return true;
        }
        if !self.state.is_empty() && w == &format!("end{}", self.state) {
            return true;
        }
        false
    }

    // ── Process Word ────────────────────────────────────────────

    fn process_word(&mut self, w: &str, w_d: &WordHistory, state_end: bool, txt: &str) -> String {
        // Check block keywords
        if self.kw_block.contains(&w.to_string()) {
            // Handle external declarations
            // Note: if w_d.last() is newline, prev1() quote doesn't mean keyword is in string
            // (it could be from a previous line's string that has ended)
            let prev_is_quote = w_d.prev1() == "\"" && w_d.last() != "\n";
            if ["extern", "cover", "assert", "pure"].contains(&w_d.prev1())
                || (["extern", "pure"].contains(&w_d.prev3()) && w_d.prev1() == "virtual")
                || prev_is_quote
            {
                return String::new();
            }
            if (w == "function" || w == "task") && ["import", "export"].contains(&w_d.prev1()) {
                return String::new();
            }

            let state_name = if w.starts_with("case") {
                "case".to_string()
            } else {
                w.to_string()
            };
            self.state_update(Some(state_name));

            if [
                "module",
                "interface",
                "package",
                "generate",
                "function",
                "task",
                "property",
                "sequence",
                "checker",
            ]
            .contains(&w)
            {
                self.block_state = match w {
                    "module" => BlockState::Module,
                    "interface" => BlockState::Interface,
                    "package" => BlockState::Package,
                    "generate" => BlockState::Generate,
                    _ => BlockState::Text,
                };
                return "incr_ilvl_flush".to_string();
            } else {
                return "incr_ilvl".to_string();
            }
        }

        // Identify block_state
        if self.block_state.is_none() {
            if w == "assign" {
                self.block_state = BlockState::Assign;
            } else if w.starts_with("always") {
                self.block_state = BlockState::Always {
                    always_state: AlwaysState::None,
                };
            } else if (w_d.last() == "\n" || w_d.last() == ")") && w != "/" && !state_end {
                self.block_state = BlockState::Text;
            }
        } else if matches!(self.block_state, BlockState::Text) {
            let tmp = clean_comment(txt).trim().to_string();
            // Check for declaration first (before instance)
            if RE_DECL_FULL.is_match(&tmp) {
                self.block_state = BlockState::Decl;
            } else if let Some(m) = RE_INST_FULL.captures(&tmp) {
                let itype = m.name("itype").map(|x| x.as_str()).unwrap_or("");
                let iname = m.name("iname").map(|x| x.as_str()).unwrap_or("");
                // Exclude declaration keywords and control flow keywords
                let decl_keywords = [
                    "wire",
                    "reg",
                    "logic",
                    "bit",
                    "int",
                    "integer",
                    "byte",
                    "shortint",
                    "longint",
                    "real",
                    "shortreal",
                    "time",
                    "string",
                    "localparam",
                    "parameter",
                ];
                if !decl_keywords.contains(&itype)
                    && !["else", "begin", "end", "assert", "cover"].contains(&itype)
                    && !["if", "for", "foreach"].contains(&iname)
                {
                    self.block_state = BlockState::Instance;
                }
            } else if Regex::new(r"^\s*\b(typedef\s+)?(struct|union)\b")
                .unwrap()
                .is_match(&tmp)
            {
                self.block_state = BlockState::Struct;
            } else if Regex::new(r"^\s*\b(typedef\s+)?(enum)\b")
                .unwrap()
                .is_match(&tmp)
            {
                self.block_state = BlockState::Enum;
            } else if Regex::new(r"(?s)^.*=\s*'\{").unwrap().is_match(&tmp) {
                self.block_state = BlockState::StructAssign;
            }
        }

        String::new()
    }

    // ── Helper: Get Indent Level ────────────────────────────────

    fn get_indent_level(
        txt: &str,
        options: &FormatOptions,
        indent: &str,
        indent_space: &str,
    ) -> usize {
        let line = match txt.find('\n') {
            Some(pos) => &txt[..pos],
            None => txt,
        };
        let line = if options.use_tab() {
            line.replace(indent_space, "\t")
        } else {
            line.replace('\t', indent_space)
        };
        let cnt = line.len() - line.trim_start().len();
        if options.use_tab() {
            cnt
        } else {
            cnt / options.nb_space()
        }
    }

    // ── Alignment stubs (delegated to align/ module) ────────────

    fn align_module_port(&self, txt: &str, ilvl: usize) -> (String, String) {
        crate::align::module_port::align_module_port(
            txt,
            ilvl,
            &self.options,
            &self.indent,
            &self.indent_space,
        )
    }

    fn align_decl(&self, txt: &str) -> String {
        crate::align::decl::align_decl(txt, &self.options, &self.indent, &self.indent_space)
    }

    fn align_assign(&self, txt: &str, mask_op: u32) -> String {
        crate::align::assign::align_assign(
            txt,
            mask_op,
            &self.options,
            &self.indent,
            &self.indent_space,
        )
    }

    fn align_instance(&self, txt: &str, ilvl: usize) -> String {
        crate::align::instance::align_instance(
            txt,
            ilvl,
            &self.options,
            &self.indent,
            &self.indent_space,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_attribute_state_management() {
        let options = FormatOptions::default();
        let mut beautifier = VerilogBeautifier::new(options);

        // Test that (* ... *) attribute doesn't leave residual "(" state
        let input = r#"(* mark_debug = "true" *) reg [31:0] dbg_rfu_wreg0;"#;
        let result = beautifier.beautify_text(input);
        println!("Input: {}", input);
        println!("Output: {}", result);

        // After processing, the state should be empty (not "(")
        assert!(
            beautifier.state.is_empty(),
            "State should be empty after processing, but got: {:?}",
            beautifier.state
        );
    }

    #[test]
    fn test_attribute_in_if_block() {
        let options = FormatOptions::default();
        let mut beautifier = VerilogBeautifier::new(options);

        let input = r#"if(DEBUG_EN) begin
    (* mark_debug = "true" *) reg [31:0] dbg_rfu_wreg0   ;
    (* mark_debug = "true" *) reg [31:0] dbg_rfu_wreg1   ;
    (* mark_debug = "true" *) reg        dbg_tx_done_reg ;
end"#;

        let result = beautifier.beautify_text(input);
        println!("Input:\n{}", input);
        println!("\nOutput:\n{}", result);

        // Verify output is valid and doesn't corrupt subsequent processing
        assert!(
            result.contains("mark_debug"),
            "Attribute should be preserved"
        );
        assert!(result.contains("reg"), "reg keyword should be preserved");

        // Check semicolon alignment - all semicolons should be at the same column
        let lines: Vec<&str> = result.lines().collect();
        let reg_lines: Vec<&str> = lines
            .iter()
            .filter(|l| l.contains("reg") && l.contains("dbg_"))
            .copied()
            .collect();

        assert_eq!(reg_lines.len(), 3, "Expected 3 reg declarations");

        // Find position of semicolons
        let semi_positions: Vec<usize> = reg_lines
            .iter()
            .map(|l| l.rfind(';').unwrap_or(0))
            .collect();

        println!("Semicolon positions: {:?}", semi_positions);

        // All semicolons should be at the same position
        let first_pos = semi_positions[0];
        for (i, pos) in semi_positions.iter().enumerate() {
            assert_eq!(
                *pos, first_pos,
                "Semicolon at line {} is not aligned. Expected position {}, got {}",
                i, first_pos, pos
            );
        }
    }

    #[test]
    fn test_if_block_without_attribute() {
        // Test case from test5.sv line 360-385
        let options = FormatOptions::default();
        let mut beautifier = VerilogBeautifier::new(options);

        let input = r#"if(DEBUG_ENABLE) begin
    reg [31:0] dbg_User_Reg_awwaddr ;
    reg [31:0] dbg_User_Reg_awwdata ;
    reg        dbg_User_Reg_awwvalid;
    reg        dbg_User_Reg_awready;
    reg [31:0] dbg_User_Reg_araddr  ;
    reg        dbg_User_Reg_arvalid ;
    reg        dbg_User_Reg_arready ;
    reg [31:0] dbg_User_Reg_rdata   ;
    reg        dbg_User_Reg_rready  ;
    reg        dbg_User_Reg_rvalid  ;

    always @(posedge gp_clk) begin
        dbg_User_Reg_awwaddr  <= User_Reg_awwaddr ; 
        dbg_User_Reg_awwdata  <= User_Reg_awwdata ; 
        dbg_User_Reg_awwvalid <= User_Reg_awwvalid ;
        dbg_User_Reg_awwready <= User_Reg_awwready ;
        dbg_User_Reg_araddr   <= User_Reg_araddr ;  
        dbg_User_Reg_arvalid  <= User_Reg_arvalid ; 
        dbg_User_Reg_arready  <= User_Reg_arready   ;
        dbg_User_Reg_rdata    <= User_Reg_rdata ;   
        dbg_User_Reg_rready   <= User_Reg_rready ;  
        dbg_User_Reg_rvalid   <= User_Reg_rvalid ;  
    end
end"#;

        let result = beautifier.beautify_text(input);
        println!("Input:\n{}", input);
        println!("\nOutput:\n{}", result);

        // Check reg declarations are aligned
        let lines: Vec<&str> = result.lines().collect();
        let reg_decl_lines: Vec<&str> = lines
            .iter()
            .filter(|l| l.trim().starts_with("reg") && l.contains("dbg_User"))
            .copied()
            .collect();

        println!("Reg declaration lines: {:?}", reg_decl_lines.len());

        // Check always block assignments are aligned
        let always_lines: Vec<&str> = lines
            .iter()
            .filter(|l| l.contains("<=") && l.contains("dbg_User"))
            .copied()
            .collect();

        println!("Always assignment lines: {:?}", always_lines.len());

        // Find semicolon positions in always block assignments
        let semi_pos: Vec<usize> = always_lines
            .iter()
            .map(|l| l.rfind(';').unwrap_or(0))
            .collect();
        println!("Always block semicolon positions: {:?}", semi_pos);

        // All semicolons in always block should be aligned
        if !semi_pos.is_empty() {
            let first = semi_pos[0];
            for (i, &pos) in semi_pos.iter().enumerate() {
                assert_eq!(
                    pos, first,
                    "Semicolon at always block line {} not aligned. Expected {}, got {}",
                    i, first, pos
                );
            }
        }
    }
}
