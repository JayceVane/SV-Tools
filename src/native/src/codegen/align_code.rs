use regex::Regex;

/// Normalize text for parsing: remove comments and collapse whitespace.
/// Replicates Python `vg_core.remove_comment_line_space()`.
pub fn normalize_for_parsing(codes: &str) -> String {
    let mut result = codes.to_string();

    // Remove // * style comments
    result = Regex::new(r"//\*.*?$")
        .unwrap()
        .replace_all(&result, "")
        .to_string();

    // Remove block comments, preserving newlines
    let re_block = Regex::new(r"/\*.*?\*/").unwrap();
    result = re_block
        .replace_all(&result, |caps: &regex::Captures| {
            let txt = caps.get(0).unwrap().as_str();
            "\n".repeat(txt.matches('\n').count())
        })
        .to_string();

    // Remove line comments
    result = Regex::new(r"//.*?$")
        .unwrap()
        .replace_all(&result, "")
        .to_string();

    // Remove (* *) attributes
    let re_attr = Regex::new(r"(@\s*?\(\s*?\*\s*?\))|(\(\*.*?\*\))").unwrap();
    result = re_attr
        .replace_all(&result, |caps: &regex::Captures| {
            if let Some(g2) = caps.get(2) {
                "\n".repeat(g2.as_str().matches('\n').count())
            } else {
                String::new()
            }
        })
        .to_string();

    // Normalize whitespace
    result = Regex::new(r"\s*[\n]")
        .unwrap()
        .replace_all(&result, " ")
        .to_string();
    result = Regex::new(r";")
        .unwrap()
        .replace_all(&result, "; ")
        .to_string();
    result = Regex::new(r"\[")
        .unwrap()
        .replace_all(&result, " [")
        .to_string();
    result = Regex::new(r"\s+")
        .unwrap()
        .replace_all(&result, " ")
        .to_string();

    result
}

/// 按首个真实代码构造对齐选区；tab_size为制表宽度，至少按1处理。
/// 完整实例复用正文布局，异常或破坏非排版字符的候选由守卫原样回退。
pub fn align_code(text: &str, tab_size: u32) -> String {
    crate::format_guard::format(text, || align_selection(text, tab_size))
}

#[derive(Clone, Copy)]
enum SelectionKind {
    Assignment,
    PortDeclaration,
    SignalDeclaration,
    InstancePorts,
    Instance,
}

fn selection_kind(text: &str) -> SelectionKind {
    use std::sync::LazyLock;
    static PORT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(input|output|inout)\b").unwrap());
    static SIGNAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(reg|wire|logic)\b").unwrap());
    static BINDING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\.\w+\s*\(").unwrap());
    let code = crate::source_scan::mask_non_code(text);
    let code = code.trim_start();
    if PORT.is_match(code) {
        SelectionKind::PortDeclaration
    } else if SIGNAL.is_match(code) {
        SelectionKind::SignalDeclaration
    } else if BINDING.is_match(code) {
        SelectionKind::InstancePorts
    } else if crate::parser::patterns::RE_INST_PORTS
        .captures(code)
        .is_some_and(|captures| {
            !crate::parser::patterns::KW_BLOCK.contains(&captures.name("itype").unwrap().as_str())
        })
    {
        SelectionKind::Instance
    } else {
        SelectionKind::Assignment
    }
}

fn align_selection(text: &str, tab_size: u32) -> String {
    let tab_size = tab_size.max(1);
    match selection_kind(text) {
        SelectionKind::Assignment => align_assignment(text, tab_size),
        SelectionKind::PortDeclaration => align_port_declaration(text, tab_size),
        SelectionKind::SignalDeclaration => align_signal_declaration(text, tab_size),
        SelectionKind::InstancePorts => align_instance_port(text, tab_size),
        // 完整实例复用正文格式化器，避免参数、嵌套连接与注释出现第二套布局规则。
        SelectionKind::Instance => crate::format_code_segment(
            text,
            &crate::config::FormatOptions {
                nb_space: Some(tab_size),
                ..Default::default()
            },
        ),
    }
}

fn len_tab(stxt: &str, tabs: u32) -> usize {
    let mut slen = 0;
    for c in stxt.chars() {
        if c == '\t' {
            slen += (tabs as usize) - (slen % tabs as usize);
        } else {
            slen += 1;
        }
    }
    slen
}

fn align_assignment(text: &str, tab_size: u32) -> String {
    use std::sync::LazyLock;
    // Rust regex 不支持前瞻；在一次捕获中保留原始左、右区间。
    static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?P<lhs>.*?[\w\]\}])[ \t]*(?P<rhs>(?:\|=|~=|-=|\+=|<=|=[^=]).*)$")
            .expect("valid selection assignment pattern")
    });
    static EXCLUDED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(if|for)\b").unwrap());
    let items: Vec<_> = text
        .split('\n')
        .map(|line| {
            let code = crate::source_scan::mask_for_layout(line);
            let binding = if EXCLUDED.is_match(&code) {
                None
            } else {
                crate::source_scan::captures(&ASSIGNMENT, line, &code).map(|captures| {
                    (
                        captures.name("lhs").unwrap().as_str(),
                        captures.name("rhs").unwrap().as_str(),
                    )
                })
            };
            (line, binding)
        })
        .collect();
    let width = items
        .iter()
        .filter_map(|(_, binding)| binding.map(|(lhs, _)| len_tab(lhs, tab_size)))
        .max()
        .unwrap_or(0);
    items
        .into_iter()
        .map(|(line, binding)| match binding {
            Some((lhs, rhs)) => format!(
                "{}{}{}",
                lhs,
                " ".repeat(width - len_tab(lhs, tab_size) + 1),
                rhs
            ),
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn align_port_declaration(text: &str, tab_size: u32) -> String {
    let rexpdc = Regex::new(
        r"^(?P<indent>\s*)(?P<inout>(input|output|inout))\s*(?P<type>(reg|wire|logic|))\s*(?P<signed>(signed|))\s*(?P<range>(\[.*?\]|))\s*(?P<name>.*?)$"
    ).unwrap();

    let lines: Vec<&str> = text.split('\n').collect();
    let mut items: Vec<(String, Option<String>)> = Vec::new();
    let mut max_len: usize = 0;

    for l in &lines {
        if let Some(caps) = rexpdc.captures(l) {
            let mut prefix = format!(
                "{}{}",
                caps.name("indent").unwrap().as_str(),
                caps.name("inout").unwrap().as_str()
            );
            let tp = caps.name("type").unwrap().as_str();
            if !tp.is_empty() {
                prefix.push(' ');
                prefix.push_str(tp);
            }
            let signed = caps.name("signed").unwrap().as_str();
            if !signed.is_empty() {
                prefix.push(' ');
                prefix.push_str(signed);
            }
            let range = caps.name("range").unwrap().as_str();
            if !range.is_empty() {
                prefix.push('\t');
                prefix.push_str(range);
            }
            let name = caps.name("name").unwrap().as_str().to_string();
            max_len = max_len.max(len_tab(&prefix, tab_size));
            items.push((prefix, Some(name)));
        } else {
            items.push((l.to_string(), None));
        }
    }

    max_len += (tab_size as usize) - max_len % (tab_size as usize);

    let mut result = Vec::new();
    for (prefix, name) in items {
        if let Some(n) = name {
            let tabs = (max_len - len_tab(&prefix, tab_size) + tab_size as usize - 1)
                / (tab_size as usize);
            result.push(format!("{}{}{}", prefix, "\t".repeat(tabs), n));
        } else {
            result.push(prefix);
        }
    }

    result.join("\n")
}

fn align_signal_declaration(text: &str, tab_size: u32) -> String {
    let rexsdc = Regex::new(
        r"^(?P<indent>\s*)(?P<type>(reg|wire|logic))\s*(?P<signed>(signed|))\s*(?P<range>(\[.*?\]|))\s*(?P<name>.*?)$"
    ).unwrap();

    let lines: Vec<&str> = text.split('\n').collect();
    let mut items: Vec<(String, Option<String>)> = Vec::new();
    let mut max_len: usize = 0;

    for l in &lines {
        if let Some(caps) = rexsdc.captures(l) {
            let mut prefix = format!(
                "{}{}",
                caps.name("indent").unwrap().as_str(),
                caps.name("type").unwrap().as_str()
            );
            let signed = caps.name("signed").unwrap().as_str();
            if !signed.is_empty() {
                prefix.push(' ');
                prefix.push_str(signed);
            }
            let range = caps.name("range").unwrap().as_str();
            if !range.is_empty() {
                prefix.push('\t');
                prefix.push_str(range);
            }
            let name = caps.name("name").unwrap().as_str().to_string();
            max_len = max_len.max(len_tab(&prefix, tab_size));
            items.push((prefix, Some(name)));
        } else {
            items.push((l.to_string(), None));
        }
    }

    max_len += (tab_size as usize) - max_len % (tab_size as usize);

    let mut result = Vec::new();
    for (prefix, name) in items {
        if let Some(n) = name {
            let tabs = (max_len - len_tab(&prefix, tab_size) + tab_size as usize - 1)
                / (tab_size as usize);
            result.push(format!("{}{}{}", prefix, "\t".repeat(tabs), n));
        } else {
            result.push(prefix);
        }
    }

    result.join("\n")
}

fn align_instance_port(text: &str, tab_size: u32) -> String {
    let rexins = Regex::new(r"^(?P<indent>\s*)(?P<port>\.\w+)\s*(?P<conn>\(.*?)$").unwrap();

    let lines: Vec<&str> = text.split('\n').collect();
    let mut items: Vec<(String, Option<String>)> = Vec::new();
    let mut max_len: usize = 0;

    for l in &lines {
        if let Some(caps) = rexins.captures(l) {
            let port = format!(
                "{}{}",
                caps.name("indent").unwrap().as_str(),
                caps.name("port").unwrap().as_str()
            );
            let conn = caps.name("conn").unwrap().as_str().to_string();
            max_len = max_len.max(len_tab(&port, tab_size));
            items.push((port, Some(conn)));
        } else {
            items.push((l.to_string(), None));
        }
    }

    max_len += 1;

    let mut result = Vec::new();
    for (port, conn) in items {
        if let Some(c) = conn {
            let padding = " ".repeat(max_len - len_tab(&port, tab_size));
            result.push(format!("{}{}{}", port, padding, c));
        } else {
            result.push(port);
        }
    }

    result.join("\n")
}

#[cfg(test)]
mod regression_tests {
    use super::align_code;

    fn assert_aligned(source: &str) -> String {
        let output = align_code(source, 4);
        let columns: Vec<_> = output
            .lines()
            .filter(|line| line.trim_start().starts_with('.'))
            .map(|line| line.find('(').unwrap())
            .collect();
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0], columns[1], "{output}");
        assert_eq!(align_code(&output, 4), output);
        output
    }

    #[test]
    fn port_selection_uses_first_code_line_after_comments() {
        let source = "// ports (not code)\n/* .fake(x) */\n    .a( x ), // note (ignored),\n    .long_port( y )\n";
        let output = assert_aligned(source);
        assert!(output.starts_with("// ports (not code)\n/* .fake(x) */\n"));
        assert!(output.contains("// note (ignored),"));
    }

    #[test]
    fn full_instance_selection_uses_shared_formatter() {
        let source = "// group\n    child #(.W(4)) u_child (\n        .a( x ),\n        .long_port( y )\n    );\n";
        let output = assert_aligned(source);
        assert!(output.contains("child #(.W(4)) u_child ("));
        assert!(output.starts_with("// group\n"));
    }

    #[test]
    fn assignment_selection_does_not_panic_or_match_protected_operators() {
        let source = "a=1;\nlong_name += 2;\n// fake = preserved\n$display(\"a = b\");\n";
        let output = align_code(source, 4);
        let lines: Vec<_> = output.lines().collect();
        assert_eq!(lines[0].find('='), lines[1].find('+'), "{output}");
        assert!(output.contains("// fake = preserved"));
        assert!(output.contains("$display(\"a = b\");"));
        assert_eq!(align_code(&output, 4), output);
    }
}
