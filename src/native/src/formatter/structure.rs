use super::*;

impl Engine {
    pub(super) fn update_else_continuation(&mut self, session: &mut FormatSession, w: &str) {
        if w == "else" && session.continuation.else_pending {
            if let Some(ref ls) = session.continuation.last_split {
                session
                    .continuation
                    .splits
                    .insert(session.indentation.level, ls.clone());
            }
        } else if !w.trim().is_empty() {
            session.continuation.else_pending = false;
        }
    }
    pub(super) fn finish_continuation(&mut self, session: &mut FormatSession, w: &str) {
        // Handle end of split
        if session
            .continuation
            .splits
            .contains_key(&session.indentation.level)
        {
            if ![ContextKind::IgnoreLine, ContextKind::Attribute].contains(&self.syntax.current())
                && (w == ";"
                    || w == "end"
                    || w == "endcase"
                    || session.buffer.line.trim().starts_with('`'))
            {
                session.continuation.last_split = session
                    .continuation
                    .splits
                    .remove(&session.indentation.level);
                if let Some(ref ls) = session.continuation.last_split {
                    session.continuation.else_pending = w == "end" && ls.text.contains(':');
                }
            }
        }
    }
    pub(super) fn state_update(&mut self, next: Option<ContextKind>) {
        self.syntax.update(next);
    }
    pub(super) fn process_word(
        &mut self,
        w: &str,
        w_d: &WordHistory,
        state_end: bool,
        txt: &str,
    ) -> WordAction {
        // Check block keywords
        if ContextKind::from_keyword(w).is_some()
            && (self.options.ignore_tick() == false || !w.starts_with('`'))
        {
            // Handle external declarations
            // Note: if w_d.last() is newline, prev1() quote doesn't mean keyword is in string
            // (it could be from a previous line's string that has ended)
            let prev_is_quote = w_d.prev1() == "\"" && w_d.last() != "\n";
            if ["extern", "cover", "assert", "pure"].contains(&w_d.prev1())
                || (["extern", "pure"].contains(&w_d.prev3()) && w_d.prev1() == "virtual")
                || prev_is_quote
            {
                return WordAction::Stay;
            }
            // import/export function = 外部声明；with function sample(..) =
            // covergroup 采样头子句，都不是块
            if (w == "function" || w == "task")
                && ["import", "export", "with"].contains(&w_d.prev1())
            {
                return WordAction::Stay;
            }
            // `disable fork;` / `wait fork;` are statements, not a fork block
            if w == "fork" && ["disable", "wait"].contains(&w_d.prev1()) {
                return WordAction::Stay;
            }
            // modport 列表里的 clocking 是接口句柄引用，不是 clocking 块
            if w == "clocking" && self.syntax.current() == ContextKind::Parenthesis {
                return WordAction::Stay;
            }

            // For parentheses after task/function declaration, don't push state
            // The parameters are part of the declaration, not a nested block
            let skip_state_push = w == "("
                && [
                    ContextKind::Task,
                    ContextKind::Function,
                    ContextKind::Property,
                    ContextKind::Sequence,
                    ContextKind::Checker,
                ]
                .contains(&self.syntax.current());

            let state_name = ContextKind::from_keyword(w).expect("recognized block keyword");
            if !skip_state_push {
                self.state_update(Some(state_name));
            }

            if ["module", "interface", "package", "generate"].contains(&w) {
                self.block_state = match w {
                    "module" => BlockState::Module,
                    "interface" => BlockState::Interface,
                    "package" => BlockState::Package,
                    "generate" => BlockState::Generate,
                    _ => BlockState::None,
                };
                return WordAction::IndentAndFlush;
            } else if ["function", "task"].contains(&w) {
                self.block_state = BlockState::TaskFuncDecl;
                return WordAction::Indent;
            } else if ["property", "sequence", "checker"].contains(&w) {
                self.block_state = BlockState::Text;
                return WordAction::Indent;
            } else if w == "(" {
                // For parentheses after task/function declaration, don't increase indent
                // The parameters should align at the same level as the task body
                if [
                    ContextKind::Task,
                    ContextKind::Function,
                    ContextKind::Property,
                    ContextKind::Sequence,
                    ContextKind::Checker,
                ]
                .contains(&self.syntax.current())
                {
                    return WordAction::Stay;
                }
                return WordAction::Indent;
            } else {
                return WordAction::Indent;
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
            } else if (w_d.last() == "\n" || w_d.last() == ")" || w_d.last() == ";")
                && w != "/"
                && !state_end
            {
                self.block_state = BlockState::Text;
            }
        } else if matches!(self.block_state, BlockState::Text) {
            let tmp = clean_comment(txt).trim().to_string();
            // Check for declaration first (before instance).
            // 实例化头（名字后紧跟 `(`）排除——否则实例行滞留 Decl 状态
            // 不 flush，连续单行实例被攒进同一次对齐调用
            if is_decl_line_excl_blocks(&tmp) && !RE_INST_PORTS.is_match(&tmp) {
                self.block_state = BlockState::Decl;
            } else {
                // Try to match instance pattern on the full text first,
                // then on each line (handles if...begin prefix wrapping)
                let mut inst_match: Option<regex::Captures<'_>> = None;
                if let Some(m) = RE_INST_FULL.captures(&tmp) {
                    inst_match = Some(m);
                } else if tmp.contains('\n') {
                    // Try each line for instance pattern
                    for ln in tmp.split('\n') {
                        let ln_trimmed = ln.trim();
                        if !ln_trimmed.is_empty() {
                            if let Some(m) = RE_INST_FULL.captures(ln_trimmed) {
                                inst_match = Some(m);
                                break;
                            }
                        }
                    }
                }
                if let Some(m) = inst_match {
                    if Self::is_instance_header(&m) {
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
        }

        WordAction::Stay
    }
    pub(super) fn get_indent_level(
        txt: &str,
        options: &FormatOptions,
        _indent: &str,
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

    /// Find the last standalone `end` keyword — not part of `endmodule`, `endtask`, etc.
    pub(super) fn rfind_standalone_end(s: &str) -> Option<usize> {
        let mut search_from = s.len();
        while let Some(pos) = s[..search_from].rfind("end") {
            let before_ok = pos == 0 || {
                let b = s.as_bytes()[pos - 1];
                !b.is_ascii_alphanumeric() && b != b'_'
            };
            let after_pos = pos + 3;
            let after_ok = after_pos >= s.len() || {
                let b = s.as_bytes()[after_pos];
                !b.is_ascii_alphanumeric() && b != b'_'
            };
            if before_ok && after_ok {
                return Some(pos);
            }
            search_from = pos;
        }
        None
    }

    // ── Alignment stubs (delegated to align/ module) ────────────
}
