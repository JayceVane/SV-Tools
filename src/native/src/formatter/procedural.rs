use super::*;

impl Engine {
    pub(super) fn handle_always(&mut self, session: &mut FormatSession, w: &str, state_end: bool) {
        // Handle always block_state
        if matches!(self.block_state, BlockState::Always { .. })
            && (self.syntax.current() == ContextKind::Code
                || self.syntax.current() == ContextKind::Module
                || self.syntax.current() == ContextKind::Interface)
        {
            let tmp = clean_comment(&(session.buffer.block.clone() + &session.buffer.line))
                .trim()
                .to_string();
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
                    session.buffer.block.push_str(&session.buffer.line);
                } else {
                    session.buffer.block = self.align_assign(
                        &(session.buffer.block.clone() + &session.buffer.line),
                        AssignmentKind::All,
                    );
                }
                // Ensure block ends with newline so subsequent code starts on a new line
                if !session.buffer.block.ends_with('\n') {
                    session.buffer.block.push('\n');
                }
                session.buffer.line.clear();
                session.buffer.should_flush = true;
                session.buffer.block_ended = true;

                session.continuation.always_indent = 0;
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
                    && !(w == "end" && state_end)
                {
                    session.buffer.block =
                        std::mem::take(&mut session.buffer.block) + &session.buffer.line;
                    let last_sc = session.buffer.block.rfind(';').map(|p| p + 1).unwrap_or(0);
                    let last_end = Self::rfind_standalone_end(&session.buffer.block)
                        .map(|p| p + 3)
                        .unwrap_or(0);
                    let split_pos = last_sc.max(last_end);
                    session.buffer.line = session.buffer.block[split_pos..].to_string();
                    session.buffer.block = session.buffer.block[..split_pos].to_string();

                    if session.continuation.always_indent == 1 {
                        let re_indent = Regex::new(&format!("(?m)^{}", self.indent)).unwrap();
                        session.buffer.line =
                            re_indent.replace_all(&session.buffer.line, "").to_string();
                        self.block_state = BlockState::None;
                        let action =
                            self.process_word(w, &session.history, state_end, &session.buffer.line);
                        if action.increases_indent() {
                            session.indentation.level += 1;
                            if action == WordAction::IndentAndFlush {
                                session.buffer.output.push_str(&session.buffer.block);
                                session.buffer.block = session.buffer.line.clone();
                                session.buffer.line.clear();
                            }
                        }
                    }

                    if !self.options.reindent_only() {
                        session.buffer.block =
                            self.align_assign(&session.buffer.block, AssignmentKind::All);
                    }
                    if !w.starts_with("always") {}
                    session.buffer.output.push_str(&session.buffer.block);
                    session.buffer.block.clear();
                    session.continuation.always_indent = 0;
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
    }
}
