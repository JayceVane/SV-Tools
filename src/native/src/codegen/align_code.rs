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

/// Align Verilog code based on assignment operators.
/// Replicates Python `vg_core.align_code()`.
pub fn align_code(text: &str, tab_size: u32) -> String {
    let lines: Vec<&str> = text.split('\n').collect();

    // Determine alignment type from first non-empty line
    let atyp = lines
        .iter()
        .find(|l| !l.trim().is_empty())
        .map(|l| {
            let lstr = l.trim();
            if Regex::new(r"^\s*(input|output|inout)")
                .unwrap()
                .is_match(lstr)
            {
                1
            } else if Regex::new(r"^\s*(reg|wire|logic)").unwrap().is_match(lstr) {
                2
            } else if Regex::new(r"^\s*\.\w+\s*\(").unwrap().is_match(lstr) {
                3
            } else {
                0
            }
        })
        .unwrap_or(0);

    match atyp {
        0 => align_assignment(text, tab_size),
        1 => align_port_declaration(text, tab_size),
        2 => align_signal_declaration(text, tab_size),
        3 => align_instance_port(text, tab_size),
        _ => text.to_string(),
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
    let regexc = r"\s*if[^\w]|\s*for[^\w]";
    let rexlhs = r".*?[\w\]\}](?=\s*\|=)|.*?[\w\]\}](?=\s*~=)|.*?[\w\]\}](?=\s*-=)|.*?[\w\]\}](?=\s*\+=)|.*?[\w\]\}](?=\s*<=)|.*?[\w\]\}](?=\s*=[^=])";
    let rexrhs = r"\|=.*|~=.*|-=.*|\+=.*|<=.*|=.*";

    let re_exc = Regex::new(regexc).unwrap();
    let re_lhs = Regex::new(rexlhs).unwrap();
    let re_rhs = Regex::new(rexrhs).unwrap();

    let lines: Vec<&str> = text.split('\n').collect();
    let mut max_lhs: usize = 0;

    // First pass
    for l in &lines {
        if re_exc.is_match(l) {
            continue;
        }
        if let Some(m) = re_lhs.find(l) {
            max_lhs = max_lhs.max(len_tab(m.as_str(), tab_size));
        }
    }

    // Second pass
    let mut result = Vec::new();
    for l in &lines {
        if re_exc.is_match(l) {
            result.push(l.to_string());
            continue;
        }
        if let (Some(lhs), Some(rhs)) = (re_lhs.find(l), re_rhs.find(l)) {
            let padding = " ".repeat(max_lhs - len_tab(lhs.as_str(), tab_size) + 1);
            result.push(format!("{}{}{}", lhs.as_str(), padding, rhs.as_str()));
        } else {
            result.push(l.to_string());
        }
    }

    result.join("\n")
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
