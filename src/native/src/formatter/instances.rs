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

#[cfg(test)]
mod regression_tests {
    use crate::{config::FormatOptions, format_with_protect_passthrough};

    #[test]
    fn split_parameter_instance_after_comment_is_aligned() {
        let source = "module demo;\n// Signal declarations\n\nchild #( .WIDTH(8)\n) u_child (\n.a( x ),\n.long_port( y )\n    );\nendmodule\n";
        let output = format_with_protect_passthrough(source, &FormatOptions::default());
        assert!(output.contains(".a        (x)"), "{output}");
        assert!(output.contains("\n    );\nendmodule"), "{output}");
        assert_eq!(
            format_with_protect_passthrough(&output, &FormatOptions::default()),
            output
        );
    }

    #[test]
    fn instances_after_multiple_generate_processes_are_aligned() {
        let source = "module demo;\ngenerate\nalways @(posedge clk) begin\nq<=d;\nend\nassign delay=q;\nalways @(posedge clk) begin\nq1<=q;\nif (!a && b) x<=1;\nelse if (x) x<=0;\nif(x) cnt<=cnt+1;\nend\nendgenerate\n// ports group\nchild u_child (\n.a( short_sig ), // comment (ignored),\n.long_port( longer_sig )\n);\nendmodule\n";
        let output = format_with_protect_passthrough(source, &FormatOptions::default());
        let columns: Vec<_> = output
            .lines()
            .filter(|line| line.trim_start().starts_with('.'))
            .map(|line| line.find('(').unwrap())
            .collect();
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0], columns[1], "{output}");
        assert!(output.contains("\n    child u_child ("), "{output}");
        assert_eq!(
            format_with_protect_passthrough(&output, &FormatOptions::default()),
            output
        );
        let significant = |text: &str| {
            text.bytes()
                .filter(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
                .collect::<Vec<_>>()
        };
        assert_eq!(significant(source), significant(&output));
    }
}
