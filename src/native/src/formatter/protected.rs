use super::*;

impl Engine {
    /// 保护区不参与结构识别或排版；只允许调整其外部的行缩进。
    pub(super) fn emit_protected(
        &mut self,
        session: &mut FormatSession,
        kind: crate::source_scan::SegmentKind,
        text: &str,
    ) {
        if kind == crate::source_scan::SegmentKind::Directive {
            session.buffer.block.push_str(&session.buffer.line);
            session
                .buffer
                .block
                .push_str(&session.buffer.original_indent);
            session.buffer.block.push_str(text);
            session.buffer.line.clear();
            session.buffer.original_indent.clear();
            session
                .history
                .push(if text.ends_with('\n') { "\n" } else { text });
            return;
        }
        if session.history.last() == "\n" {
            self.prepare_line(session, text, false);
        }
        session.buffer.line.push_str(text);
        session.history.push(text);
    }
    /// 属性附着于后续声明；其内部文字已由保护 token 保真。
    pub(super) fn handle_attribute(
        &mut self,
        session: &mut FormatSession,
        word: &str,
        _state_end: bool,
    ) {
        if self.syntax.current() == ContextKind::Attribute
            && session.history.last() == "*"
            && word == ")"
        {
            session.indentation.level = session.indentation.level.saturating_sub(1);
            self.syntax.update(None);
            if self.syntax.current() == ContextKind::Parenthesis {
                self.syntax.update(None);
            }
            session.buffer.block.push_str(&session.buffer.line);
            session.buffer.line.clear();
        } else if ![ContextKind::IgnoreLine, ContextKind::Attribute]
            .contains(&self.syntax.current())
            && session.history.last() == "("
            && word == "*"
        {
            self.syntax.update(Some(ContextKind::Attribute));
        }
    }
}
