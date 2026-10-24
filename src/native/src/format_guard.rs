//! 格式化只能调整 ASCII 空格、Tab、CR、LF；其余原文序列是不可破坏的提交条件。
use std::panic::{catch_unwind, UnwindSafe};

fn is_layout_byte(byte: &u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

/// 比较 UTF-8 原文字节序列，不分配副本、不把其它 Unicode 空白当作布局字符。
fn preserves_content(source: &str, candidate: &str) -> bool {
    source
        .bytes()
        .filter(|byte| !is_layout_byte(byte))
        .eq(candidate.bytes().filter(|byte| !is_layout_byte(byte)))
}

/// 执行单次布局，非布局字符序列、词法 token 及有语义的保护区都不变时才提交。
/// 回调异常或校验失败时记录原因并逐字返回原文，不依赖输入语法是否有效。
pub(crate) fn format(source: &str, layout: impl FnOnce() -> String + UnwindSafe) -> String {
    match catch_unwind(layout) {
        Ok(candidate)
            if preserves_content(source, &candidate)
                && crate::source_scan::preserves_syntax(source, &candidate) =>
        {
            candidate
        }
        Ok(_) => {
            eprintln!(
                "[svtools] Formatting changed source characters or lexical tokens; original text preserved."
            );
            source.to_owned()
        }
        Err(_) => {
            eprintln!("[svtools] Formatting failed; original text preserved.");
            source.to_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_four_ascii_layout_characters_may_change() {
        assert!(preserves_content("\r\n a\tb c ", "abc\n"));
        assert!(preserves_content("\r \t\n", ""));
        for character in [
            '\0', '\u{b}', '\u{c}', '\u{85}', '\u{a0}', '\u{1680}', '\u{200b}', '\u{2028}',
            '\u{2029}', '\u{202f}', '\u{3000}', '\u{feff}', '�', '🚀',
        ] {
            let source = format!("a{character}b");
            assert!(!preserves_content(&source, "ab"), "{character:?}");
            assert!(preserves_content(&source, &format!(" a{character}\tb\n")));
        }
    }

    #[test]
    fn rejects_insertions_deletions_replacements_reordering_and_unicode_normalization() {
        for (source, candidate) in [
            ("ab", "a"),
            ("a", "ab"),
            ("ab", "ac"),
            ("aba", "baa"),
            ("e\u{301}", "é"),
            ("�乱🚀码�", "�乱码🚀�"),
        ] {
            assert!(!preserves_content(source, candidate));
        }
    }

    #[test]
    fn rejected_layout_restores_the_original_line_endings_and_whitespace() {
        let source = "\r\n 乱码\t🚀 \r\n";
        assert_eq!(format(source, || "乱码🚀!\n".into()), source);
        assert_eq!(format(source, || "乱码🚀\n".into()), "乱码🚀\n");
    }

    #[test]
    fn panicking_layout_keeps_the_original_text() {
        let source = "不完整语法\r\n\t";
        assert_eq!(
            format(source, || panic!("malformed layout fixture")),
            source
        );
    }

    #[test]
    fn public_rust_formatters_preserve_unknown_input_and_decl_rewrite_options() {
        let options = crate::config::FormatOptions {
            one_decl_per_line: Some(true),
            ..Default::default()
        };
        for source in [
            "\u{b}\u{c}\u{a0}\u{3000}\u{feff}�乱码🚀\r\n",
            "module m;\nlogic [7:0] a, b;\nendmodule\n",
            "module m;\n`pragma protect begin_protected\nABC\n`pragma protect end_protected\n\u{a0}endmodule\r\n",
        ] {
            let full = crate::format_with_protect_passthrough(source, &options);
            let segment = crate::format_code_segment(source, &options);
            let direct = crate::beautifier::VerilogBeautifier::new(options.clone()).beautify_text(source);
            for candidate in [full, segment, direct] {
                assert!(preserves_content(source, &candidate));
            }
        }
    }
}

#[cfg(test)]
mod semantic_tests {
    use super::*;

    #[test]
    fn character_conservation_alone_is_not_enough_to_commit_layout() {
        for (source, unsafe_candidate) in [
            ("logic [8 + +1:0] a;", "logic [8++1:0] a;"),
            ("a = a === 1;", "a = a == = 1;"),
            ("// note\na = 1;", "// note a = 1;"),
            ("$display(\"a  b\");", "$display(\"a b\");"),
        ] {
            assert!(preserves_content(source, unsafe_candidate));
            assert_eq!(format(source, || unsafe_candidate.to_owned()), source);
        }
    }

    #[test]
    fn existing_goldens_keep_the_same_lexical_tokens() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../example");
        for entry in std::fs::read_dir(&root).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "sv") {
                continue;
            }
            let target = root.join("target").join(path.file_name().unwrap());
            let source = std::fs::read_to_string(&path).unwrap();
            let expected = std::fs::read_to_string(&target).unwrap();
            assert!(
                crate::source_scan::preserves_syntax(&source, &expected),
                "{}",
                path.display()
            );
            let options = crate::config::FormatOptions::default();
            assert_eq!(
                crate::format_with_protect_passthrough(&source, &options).replace("\r\n", "\n"),
                expected.replace("\r\n", "\n"),
                "{}",
                path.display()
            );
        }
    }

    #[test]
    fn complete_formatter_keeps_required_operator_boundaries_and_formats_layout() {
        for source in [
            "module m;\nlogic [8 + +1:0] a;\nendmodule\n",
            "module m(input logic [8 + +1:0] a);\nendmodule\n",
            "module m;\nlogic [31:0] a [8 - -1:0];\nendmodule\n",
            "module m;\ninteger i,a;\ninitial begin\nfor(i=0;i<1;i++) a = a === 1;\nend\nendmodule\n",
            "module m;\ninteger i,a;\ninitial begin\nfor(i=0;i<1;i++) a = a >>> 1;\nend\nendmodule\n",
        ] {
            let options = crate::config::FormatOptions::default();
            let output = crate::format_with_protect_passthrough(source, &options);
            assert_ne!(output, source, "layout must not fall back: {source}");
            assert!(preserves_content(source, &output));
            assert!(crate::source_scan::preserves_syntax(source, &output));
            assert_eq!(crate::format_with_protect_passthrough(&output, &options), output);
        }
    }
}
