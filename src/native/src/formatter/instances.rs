//! 实例识别与块内实例布局。只在代码区寻找头部，替换使用原文区间。
use super::*;

impl Engine {
    pub(super) fn is_instance_header(captures: &regex::Captures<'_>) -> bool {
        let module_type = captures.name("itype").map_or("", |part| part.as_str());
        let name = captures.name("iname").map_or("", |part| part.as_str());
        ![
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
            "else",
            "begin",
            "end",
            "assert",
            "cover",
            "if",
            "fork",
            "join",
            "join_any",
            "join_none",
            "task",
            "function",
            "property",
            "sequence",
            "checker",
        ]
        .contains(&module_type)
            && !["if", "for", "foreach"].contains(&name)
    }

    pub(super) fn align_embedded_instances(&self, text: &str) -> String {
        if self.options.reindent_only() {
            return text.to_string();
        }
        let code = crate::source_scan::mask_non_code(text);
        let mut edits = Vec::new();
        for header in RE_INST_FULL.captures_iter(&code) {
            if !Self::is_instance_header(&header) {
                continue;
            }
            let name_start = header
                .name("itype")
                .expect("instance pattern has type")
                .start();
            let start = text[..name_start]
                .rfind('\n')
                .map_or(0, |offset| offset + 1);
            let Some(semicolon) = crate::source_scan::find_code_char(text, name_start, ';') else {
                continue;
            };
            let end = semicolon + 1;
            if edits
                .last()
                .is_some_and(|(range, _): &(std::ops::Range<usize>, String)| range.end > start)
            {
                continue;
            }
            let instance = &text[start..end];
            let level =
                Self::get_indent_level(instance, &self.options, &self.indent, &self.indent_space);
            edits.push((start..end, self.align_instance(instance, level)));
        }
        let mut result = text.to_string();
        for (range, replacement) in edits.into_iter().rev() {
            result.replace_range(range, &replacement);
        }
        result
    }
}
