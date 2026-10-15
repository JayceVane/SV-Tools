use super::*;

impl Engine {
    pub(super) fn prepare_line(&mut self, session: &mut FormatSession, w: &str, state_end: bool) {
        session.indentation.previous = session.indentation.level;
        if w.trim().is_empty() {
            if w != "\n" && matches!(self.block_state, BlockState::Module | BlockState::Interface) {
                session.buffer.block.push_str(w);
            }
            session.indentation.has_indent = w != "\n";
        }
        if state_end && self.syntax.current() != ContextKind::Parenthesis {
            self.state_update(None);

            session.indentation.level = session.indentation.level.saturating_sub(1);
        }

        // Handle end of block_state
        if matches!(self.block_state, BlockState::Assign)
            && w != "assign"
            && !w.starts_with(|c: char| c == ' ' || c == '\t')
            && self.syntax.current() != ContextKind::Parenthesis
            && self.syntax.current() != ContextKind::Brace
            && !assign_block_unbalanced(&session.buffer.block)
            && !RE_LINE_ENDS_WITH_OP.is_match(&last_nonempty_line(&session.buffer.block))
        {
            // 注：state == "(" / "{"、块内括号未闭合（多行拼接
            // "assign x = {\n  a,\n  b};" 的 `};` 独占一行时，行首 state_end
            // 已先弹出 "{"，须靠括号深度兜底）或块尾行以悬空运算符结尾，
            // 都表示 assign 表达式破行未写完，此时不能切断块——否则块只剩
            // 已写部分，align_assign 会因尾部换行多补一个空行（issue #3
            // 及其花括号变体）
            session
                .buffer
                .output
                .push_str(&self.align_assign(&session.buffer.block, AssignmentKind::Continuous));
            session.buffer.block.clear();
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
                session.buffer.output.push_str(&session.buffer.block);
            } else {
                session
                    .buffer
                    .output
                    .push_str(&self.align_decl(&session.buffer.block));
            }
            session.buffer.block.clear();
            self.block_state = BlockState::None;
        }

        if self.options.ignore_tick()
            && ["`ifdef", "`ifndef", "`elsif", "`else", "`endif"].contains(&w)
        {
            self.state_update(Some(ContextKind::IgnoreLine));
            session
                .buffer
                .line
                .push_str(&session.buffer.original_indent);
        } else if !session.indentation.has_indent && self.syntax.current().is_directive() {
            session.indentation.has_indent = true;
        }

        // Insert indentation
        if !matches!(self.block_state, BlockState::Module | BlockState::Interface)
            && !w.trim().is_empty()
            && (![ContextKind::Attribute].contains(&self.syntax.current())
                || session.indentation.has_indent)
            && self.syntax.current() != ContextKind::IgnoreLine
        {
            let mut ilvl_tmp = session.indentation.level + session.continuation.always_indent;
            for v in session.continuation.splits.values() {
                ilvl_tmp += v.count;
            }
            session.buffer.line = self.indent.repeat(ilvl_tmp);
        }

        // Handle delayed state_end for parentheses
        if state_end && self.syntax.current() == ContextKind::Parenthesis {
            self.state_update(None);
            session.indentation.level = session.indentation.level.saturating_sub(1);
        }
    }
    pub(super) fn emit_token(&mut self, session: &mut FormatSession, w: &str, state_end: bool) {
        // Newline handling
        if w == "\n" {
            session.buffer.block_ended = false;
            if [ContextKind::IgnoreLine].contains(&self.syntax.current()) {
                self.state_update(None);
                if self.block_state.is_none() {
                    session.buffer.should_flush = true;
                }
            }

            // Split line detection
            if ![ContextKind::Attribute, ContextKind::Brace].contains(&self.syntax.current())
                && !matches!(
                    self.block_state,
                    BlockState::Module | BlockState::Instance | BlockState::Struct
                )
            {
                let block_c = clean_comment(&session.buffer.block);
                let idx_eol = block_c.rfind('\n');
                let mut last_line = session.buffer.line.clone();
                if let Some(idx) = idx_eol {
                    if idx + 2 < block_c.len() {
                        last_line = format!("{}{}", &block_c[idx + 1..], session.buffer.line);
                    }
                }
                let tmp = clean_comment(&last_line).trim().to_string();

                if !tmp.is_empty() {
                    // 行尾 `\}`（constraint { ...; } 等单行花括号块）视为
                    // 语句结束，不给后续行 +1 缩进
                    let m = Regex::new(
                            r"(;|\}|\{|\bend|\bendcase|\bendgenerate)$|^\}$|(begin(\s*\:\s*[\w\$]+)?)$|(case(?:x|z)?)\s*\(.*\)$|(`\w+)\s*(\(.*\))?$|^ *(`\w+)\b"
                        ).unwrap().find(&tmp);

                    if m.is_none() {
                        if tmp.starts_with("always") {
                            session.continuation.always_indent = 1;
                        } else if session.indentation.level == session.indentation.previous
                            && self.syntax.current() != ContextKind::Parenthesis
                            && ![
                                ContextKind::Task,
                                ContextKind::Function,
                                ContextKind::Property,
                                ContextKind::Sequence,
                                ContextKind::Checker,
                            ]
                            .contains(&self.syntax.current())
                        {
                            if !session
                                .continuation
                                .splits
                                .contains_key(&session.indentation.level)
                            {
                                if self.syntax.current() == ContextKind::Case
                                    && Regex::new(r"^\s*\w+\s*,$").unwrap().is_match(&tmp)
                                {
                                    // Multiple state case
                                } else {
                                    session.continuation.splits.insert(
                                        session.indentation.level,
                                        SplitInfo {
                                            count: 1,
                                            text: tmp.clone(),
                                        },
                                    );
                                }
                            } else {
                                let si = session
                                    .continuation
                                    .splits
                                    .get(&session.indentation.level)
                                    .unwrap();
                                if !si.text.trim().starts_with('@') {
                                    let m_assign =
                                        Regex::new(r"^\s*(assign\s+)?\w+\s*(<?=)\s*(.*)")
                                            .unwrap()
                                            .is_match(&si.text);
                                    let m_param = Regex::new(r"^\s*(localparam|parameter)\b")
                                        .unwrap()
                                        .is_match(&si.text);
                                    if !m_assign && !m_param {
                                        if let Some(si) = session
                                            .continuation
                                            .splits
                                            .get_mut(&session.indentation.level)
                                        {
                                            si.count += 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Decl 组边界判定：非声明行、或实例化头（名字后紧跟 `(`）
            // 触发 flush。空行不作为组边界（块内空行会被 blank_rules
            // 删除，两遍格式化需一致的分组——sfp_dma_rx 的 dbg 声明组
            // 幂等）；滞留声明组遇到实例行由 `;` 处理的专门分支善后
            let decl_boundary = !session.buffer.line.trim().is_empty()
                && (!is_decl_line_excl_blocks(session.buffer.line.trim())
                    || RE_INST_PORTS.is_match(session.buffer.line.trim_start()));
            if matches!(self.block_state, BlockState::Decl) && decl_boundary {
                if self.options.reindent_only() {
                    session.buffer.output.push_str(&session.buffer.block);
                } else {
                    session
                        .buffer
                        .output
                        .push_str(&self.align_decl(&session.buffer.block));
                }
                session.buffer.block.clear();
                self.block_state = BlockState::None;
            }

            // 多行 constraint 块的内联 `}`（"...; }"）：拆到独立行，
            // 缩进取块首行。`constraint` 开头的行是块头（单行块整行
            // 保持）；`}` 前无内容（已独立成行）不动。
            if session.buffer.line.trim_end().ends_with('}')
                && session.buffer.line.trim_end() != "}"
                && !session.buffer.line.trim_start().starts_with("constraint")
            {
                let first = session.buffer.block.lines().find(|l| !l.trim().is_empty());
                if let Some(first) = first {
                    if first.trim_start().starts_with("constraint") {
                        let cur = session.buffer.line.trim_end();
                        if let Some(pos) = cur.rfind('}') {
                            let before = cur[..pos].trim_end();
                            if !before.is_empty() {
                                let base_indent = &first[..first.len() - first.trim_start().len()];
                                session.buffer.line = format!("{}\n{}}}", before, base_indent);
                            }
                        }
                    }
                }
            }

            // 行中 flush 已含终止符时，本行的换行 token 不再向 block 播种
            // 空行（skip_terminator_nl 恰好跳过一个——用户紧随的空行
            // （连续第二个 \n）不受影响）
            let skip_seed = session.buffer.skip_terminator
                && session.buffer.line.trim().is_empty()
                && session.buffer.block.is_empty();
            session.buffer.skip_terminator = false;
            if !skip_seed {
                session
                    .buffer
                    .block
                    .push_str(session.buffer.line.trim_end());
                session.buffer.block.push('\n');
            }

            session.buffer.line.clear();
            session.buffer.original_indent.clear();
            session.indentation.has_indent = false;
        } else if session.history.last() == "\n" && w.trim().is_empty() {
            session.buffer.original_indent.push_str(w);
        } else {
            // GNU style: begin on new line
            if ![ContextKind::IgnoreLine, ContextKind::Attribute].contains(&self.syntax.current())
                && self.options.indent_style() == "gnu"
            {
                if w == "begin" && !session.buffer.line.trim().is_empty() {
                    let mut ilvl_tmp =
                        session.indentation.level + session.continuation.always_indent + 1;
                    for (_, v) in &session.continuation.splits {
                        ilvl_tmp += v.count;
                    }
                    if !session
                        .continuation
                        .splits
                        .contains_key(&session.indentation.level)
                    {
                        let tmp = clean_comment(&session.buffer.line).trim().to_string();
                        session.continuation.splits.insert(
                            session.indentation.level,
                            SplitInfo {
                                count: 1,
                                text: tmp,
                            },
                        );
                    } else {
                        if let Some(si) = session
                            .continuation
                            .splits
                            .get_mut(&session.indentation.level)
                        {
                            si.count += 1;
                        }
                    }
                    session.buffer.line.push('\n');
                    session.buffer.line.push_str(&self.indent.repeat(ilvl_tmp));
                } else if w == "else"
                    && session.history.last() != "\n"
                    && session.history.prev1() == "end"
                {
                    let mut ilvl_tmp =
                        session.indentation.level + session.continuation.always_indent;
                    for (_, v) in &session.continuation.splits {
                        ilvl_tmp += v.count;
                    }
                    session.buffer.line.push('\n');
                    session.buffer.line.push_str(&self.indent.repeat(ilvl_tmp));
                }
            }

            if session.buffer.block_ended
                && !w.trim().is_empty()
                && (w != "/" || session.history.last() != "/")
            {
                session.buffer.line = session.buffer.line.trim_end().to_string();
                session.buffer.line.push('\n');
                // `end else ...`：end 在行中触发 state_end flush 后，else
                // 分支被移到新行——须补当前层级缩进，否则落在第 0 列
                // （buf_sync_addr 的 generate 链）。其余续行保持原行为。
                if w == "else" {
                    let mut ilvl_tmp =
                        session.indentation.level + session.continuation.always_indent;
                    for (_, v) in &session.continuation.splits {
                        ilvl_tmp += v.count;
                    }
                    session.buffer.line.push_str(&self.indent.repeat(ilvl_tmp));
                }
                session.buffer.block_ended = false;
            }
            session.buffer.line.push_str(w);

            if ![ContextKind::IgnoreLine, ContextKind::Attribute].contains(&self.syntax.current()) {
                let action = self.process_word(
                    w,
                    &session.history,
                    state_end,
                    &(session.buffer.block.clone() + &session.buffer.line),
                );
                if action.increases_indent() {
                    session.indentation.level += 1;
                    if action == WordAction::IndentAndFlush {
                        session.buffer.output.push_str(&session.buffer.block);
                        session.buffer.block = session.buffer.line.clone();
                        session.buffer.line.clear();
                    }
                }
            }
        }
    }
    pub(super) fn commit_block(&mut self, session: &mut FormatSession, w: &str) {
        // Add block to text
        if session.buffer.should_flush {
            // 仅行中 flush（词 token 触发，如 `;`/`end`）需要跳过紧随的
            // 终止符换行——注释行等在换行 token 处理中 flush 的块已含
            // 终止符，再设标志会吃掉紧随的用户空行
            if session.buffer.block.ends_with('\n') && w != "\n" {
                session.buffer.skip_terminator = true;
            }
            session.buffer.output.push_str(&session.buffer.block);
            session.buffer.block.clear();
            self.block_state = BlockState::None;
            session.buffer.should_flush = false;
        }
    }
}
