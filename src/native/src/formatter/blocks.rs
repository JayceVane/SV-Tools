use super::*;

impl Engine {
    pub(super) fn handle_semicolon(&mut self, session: &mut FormatSession, word: &str) -> bool {
        if word != ";"
            || matches!(
                self.syntax.current(),
                ContextKind::IgnoreLine | ContextKind::Attribute | ContextKind::Parenthesis
            )
            || self.is_module_import(session)
        {
            return false;
        }
        let is_instance = RE_INST_PORTS.is_match(session.buffer.line.trim_start());
        if matches!(self.block_state, BlockState::Decl) && is_instance {
            if !session.buffer.block.trim().is_empty() {
                session
                    .buffer
                    .output
                    .push_str(&self.align_decl(&session.buffer.block));
                session.buffer.block.clear();
            }
            session
                .buffer
                .output
                .push_str(&self.align_instance(&session.buffer.line, session.indentation.level));
            session.buffer.line.clear();
            self.block_state = BlockState::None;
            session.buffer.block_ended = true;
            return false;
        }
        let is_declaration = !is_instance && is_decl_line_excl_blocks(session.buffer.line.trim());
        if matches!(
            self.block_state,
            BlockState::Text | BlockState::Decl | BlockState::StructAssign
        ) && is_declaration
        {
            self.block_state = BlockState::Decl;
            return false;
        }
        if self.syntax.current() == ContextKind::Brace
            || !matches!(
                self.block_state,
                BlockState::None
                    | BlockState::Module
                    | BlockState::Interface
                    | BlockState::Instance
                    | BlockState::Text
                    | BlockState::Package
                    | BlockState::TaskFuncDecl
                    | BlockState::Struct
                    | BlockState::StructAssign
                    | BlockState::Enum
            )
        {
            return false;
        }
        self.flush_pending_block(session)
    }

    fn is_module_import(&self, session: &FormatSession) -> bool {
        if !matches!(self.block_state, BlockState::Module | BlockState::Interface) {
            return false;
        }
        static IMPORT: std::sync::LazyLock<Regex> =
            std::sync::LazyLock::new(|| Regex::new(r"\bimport\b").expect("valid import pattern"));
        static PORT_OPEN: std::sync::LazyLock<Regex> =
            std::sync::LazyLock::new(|| Regex::new(r";\s*\(").expect("valid header pattern"));
        let code = crate::source_scan::mask_non_code(
            &(session.buffer.block.clone() + &session.buffer.line),
        );
        IMPORT.is_match(&code) && !PORT_OPEN.is_match(&code)
    }

    fn flush_pending_block(&mut self, session: &mut FormatSession) -> bool {
        if matches!(
            self.block_state,
            BlockState::Module | BlockState::Interface | BlockState::TaskFuncDecl
        ) {
            return self.flush_header(session);
        }
        let input = session.buffer.block.clone() + &session.buffer.line;
        let formatted = match self.block_state {
            _ if self.options.reindent_only() => input,
            BlockState::Instance => {
                session.buffer.block_ended = true;
                self.align_pending_instance(&input, session.indentation.level)
            }
            BlockState::Struct => self.align_decl(&input),
            BlockState::StructAssign => self.align_assign(&input, AssignmentKind::Case),
            _ => input,
        };
        session.buffer.line.clear();
        if !formatted.is_empty() {
            session.buffer.block = formatted;
        }
        self.block_state = BlockState::None;
        session.buffer.should_flush = true;
        false
    }

    fn flush_header(&mut self, session: &mut FormatSession) -> bool {
        let input = session.buffer.block.clone() + &session.buffer.line;
        let level = session.indentation.level.saturating_sub(1);
        let (formatted, remaining) = if matches!(self.block_state, BlockState::TaskFuncDecl) {
            self.align_task_func_param(&input, level)
        } else {
            self.align_module_port(&input, level)
        };
        session.buffer.line.clear();
        session.buffer.block_ended = true;
        if !remaining.is_empty() && !formatted.is_empty() {
            session.buffer.output.push_str(&formatted);
            session.buffer.skip_terminator = formatted.ends_with('\n');
            session.buffer.block = remaining;
            self.block_state = BlockState::None;
            return true;
        }
        session.buffer.block = if formatted.is_empty() {
            input
        } else {
            formatted
        };
        self.block_state = BlockState::None;
        session.buffer.should_flush = true;
        false
    }

    fn align_pending_instance(&self, input: &str, level: usize) -> String {
        let code = crate::source_scan::mask_non_code(input);
        let start = code
            .lines()
            .scan(0, |offset, line| {
                let start = *offset;
                *offset += line.len() + 1;
                Some((start, line))
            })
            .find_map(|(offset, line)| RE_INST_FULL.is_match(line.trim()).then_some(offset))
            .unwrap_or(0);
        if start == 0 {
            return self.align_instance(input, level);
        }
        format!(
            "{}{}",
            &input[..start],
            self.align_instance(&input[start..], level)
        )
    }
    pub(super) fn handle_close(
        &mut self,
        session: &mut FormatSession,
        word: &str,
        state_end: bool,
    ) {
        if !state_end {
            return;
        }
        match self.block_state {
            BlockState::Generate => {
                session.buffer.block = self.align_embedded_instances(&session.buffer.block);
                session.buffer.should_flush = true;
            }
            _ if word == "end" && !matches!(self.block_state, BlockState::Always { .. }) => {
                let text = session.buffer.block.clone() + &session.buffer.line;
                session.buffer.block = self.align_embedded_instances(&text);
                if !session.buffer.block.ends_with('\n') {
                    session.buffer.block.push('\n');
                }
                session.buffer.line.clear();
                session.buffer.should_flush = true;
                session.buffer.block_ended = true;
            }
            _ => {}
        }
        if session.history.last() != "\n" {
            self.syntax.update(None);
            session.indentation.level = session.indentation.level.saturating_sub(1);
        }
    }
    pub(super) fn finish_file(&mut self, session: &mut FormatSession) -> String {
        // Handle remaining content
        session.buffer.block.push_str(&session.buffer.line);

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
        ) && self.syntax.current() != ContextKind::Brace)
        {
            let block_tmp = match &self.block_state {
                BlockState::Module | BlockState::Interface => {
                    let (result, _remaining) = self.align_module_port(
                        &session.buffer.block,
                        session.indentation.level.saturating_sub(1),
                    );
                    result
                }
                _ if self.options.reindent_only() => session.buffer.block.clone(),
                BlockState::Instance => {
                    self.align_instance(&session.buffer.block, session.indentation.level)
                }
                BlockState::Struct => self.align_decl(&session.buffer.block),
                BlockState::Assign => {
                    self.align_assign(&session.buffer.block, AssignmentKind::Continuous)
                }
                BlockState::StructAssign => {
                    self.align_assign(&session.buffer.block, AssignmentKind::Case)
                }
                BlockState::Decl => self.align_decl(&session.buffer.block),
                _ => session.buffer.block.clone(),
            };

            if block_tmp.is_empty() {
                // Unable to extract block content
            } else {
                session.buffer.block = block_tmp;
            }
        }

        session.buffer.output.push_str(&session.buffer.block);

        // 语句级赋值运算符对齐（语句块内逐条流式写出，此处统一后处理）：
        // "arbase<=expr;" / "arvalid<=expr;" → '<=' 列对齐（ex3 的 for 体）
        if !self.options.reindent_only() {
            session.buffer.output = crate::align::assign::align_stmt_ops(
                &session.buffer.output,
                &self.options,
                &self.indent,
            );
        }

        std::mem::take(&mut session.buffer.output)
    }
    pub(super) fn align_module_port(&self, txt: &str, ilvl: usize) -> (String, String) {
        crate::align::module_port::align_module_port(
            txt,
            ilvl,
            &self.options,
            &self.indent,
            &self.indent_space,
        )
    }

    pub(super) fn align_task_func_param(&self, txt: &str, ilvl: usize) -> (String, String) {
        crate::align::task_func_param::align_task_func_param(txt, ilvl, &self.options, &self.indent)
    }

    pub(super) fn align_decl(&self, txt: &str) -> String {
        crate::align::decl::align_decl(txt, &self.options, &self.indent, &self.indent_space)
    }

    pub(super) fn align_assign(&self, txt: &str, kind: AssignmentKind) -> String {
        crate::align::assign::align_assign(
            txt,
            kind,
            &self.options,
            &self.indent,
            &self.indent_space,
        )
    }

    pub(super) fn align_instance(&self, txt: &str, ilvl: usize) -> String {
        crate::align::instance::align_instance(
            txt,
            ilvl,
            &self.options,
            &self.indent,
            &self.indent_space,
        )
    }
}
