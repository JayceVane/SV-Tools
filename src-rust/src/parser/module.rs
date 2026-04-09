use regex::Regex;

use crate::config::GadgetOptions;

/// Parse module definition and extract ports, parameters, clock, and reset signals.
/// Replicates Python `vg_core.parse_module()`.
pub struct ModuleInfo {
    pub name: String,
    pub ports: Vec<Port>,
    pub params: Vec<Param>,
    pub clocks: Vec<String>,
    pub resets: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Port {
    pub direction: String, // input, output, inout
    pub size: String,      // [7:0], signed, etc.
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct Param {
    pub kind: String,  // parameter, localparam
    pub ptype: String, // type (e.g., integer, logic)
    pub name: String,
    pub value: String,
}

/// Parse a module from source text.
pub fn parse_module(text: &str, options: &GadgetOptions) -> Option<ModuleInfo> {
    let remove_comments = crate::parser::comments::clean_comment(text);

    let mcodes = regex_search(r"(?s)\bmodule\b.+?\bendmodule\b", &remove_comments)?;
    let moddef = regex_search(r"module[^;]+;", &mcodes)?;
    let prmtmp = regex_search(r"#\s*\([^)]+\)\s*\(", &moddef);
    let prmtxt = prmtmp.as_deref().and_then(|p| extract_parens_content(p));

    let moddef_clean = if prmtmp.is_some() {
        Regex::new(r"#\s*\([^)]+\)\s*\(")
            .unwrap()
            .replace(&moddef, "(")
            .to_string()
    } else {
        moddef.clone()
    };

    let modmch = Regex::new(r"module\s+?(?P<name>\w+)")
        .unwrap()
        .captures(&moddef_clean)?;
    let module = modmch.name("name")?.as_str().to_string();

    let prttxt = extract_parens_content(&moddef_clean);

    // Parse parameters
    let mut params = Vec::new();
    if let Some(ref pt) = prmtxt {
        parse_param(pt, "parameter", &mut params);
    }

    // Parse ports from module header
    let mut ports = Vec::new();
    if let Some(ref pt) = prttxt {
        parse_ports(pt, &mut ports);
    }

    // Parse ports declared in module body (non-ANSI style)
    let mcodes_body = Regex::new(r"module[^;]+;").unwrap().replace(&mcodes, "");

    for caps in Regex::new(r"\binput\b[^;]+;|\boutput\b[^;]+;|\binout\b[^;]+;")
        .unwrap()
        .captures_iter(&mcodes_body)
    {
        let ports_decl = caps.get(0).unwrap().as_str();
        let mut p_dir = String::new();
        let mut psize = String::new();
        for strl in ports_decl.split(',') {
            let strl = Regex::new(r"=.*").unwrap().replace(strl, "");
            let pntmp: Vec<&str> = Regex::new(r"\w+")
                .unwrap()
                .find_iter(&strl)
                .map(|m| m.as_str())
                .collect();
            let pname = pntmp.last().unwrap_or(&"").to_string();
            let pdtmp = regex_search(r"\binput\b|\boutput\b|\binout\b", &strl);
            let pstmp = regex_search(r"\[.*\]|\bsigned\s*\[.*\]|\bsigned\b", &strl);
            if let Some(ref dir) = pdtmp {
                p_dir = dir.clone();
            }
            if !pname.is_empty() {
                if pdtmp.is_some() {
                    if let Some(ref size) = pstmp {
                        psize = size.clone();
                    }
                }
                // Update existing port or add
                if let Some(p) = ports.iter_mut().find(|p| p.name == pname) {
                    if !p_dir.is_empty() {
                        p.direction = p_dir.clone();
                    }
                    if !psize.is_empty() {
                        p.size = psize.clone();
                    }
                }
            }
        }
    }

    // Parse inline parameters
    for caps in Regex::new(r"\bparameter\b[^;]+;")
        .unwrap()
        .captures_iter(&mcodes_body)
    {
        let m = caps.get(0).unwrap().as_str();
        // Remove trailing semicolon for parsing
        parse_param(m.trim_end_matches(';'), "parameter", &mut params);
    }
    for caps in Regex::new(r"\blocalparam\b[^;]+;")
        .unwrap()
        .captures_iter(&mcodes_body)
    {
        let m = caps.get(0).unwrap().as_str();
        // Remove trailing semicolon for parsing
        parse_param(m.trim_end_matches(';'), "localparam", &mut params);
    }

    // Get clock and reset from always blocks
    let port_names: Vec<&str> = ports.iter().map(|p| p.name.as_str()).collect();
    let (clks, rsts) = get_clock_reset(&mcodes_body);

    let mut clock_list: Vec<String> = Vec::new();
    for e in &clks {
        if port_names.contains(&e.as_str()) {
            clock_list.push(e.clone());
        }
    }
    let mut reset_list: Vec<String> = Vec::new();
    for e in &rsts {
        if port_names.contains(&e.as_str()) {
            reset_list.push(e.clone());
        }
    }

    // Add from settings
    for p in &port_names {
        if options.clock().contains(&p.to_string()) {
            clock_list.push(p.to_string());
        }
        if options.reset().contains(&p.to_string()) {
            reset_list.push(p.to_string());
        }
    }

    Some(ModuleInfo {
        name: module,
        ports,
        params,
        clocks: clock_list,
        resets: reset_list,
    })
}

fn regex_search(pattern: &str, text: &str) -> Option<String> {
    Regex::new(pattern)
        .ok()
        .and_then(|re| re.find(text).map(|m| m.as_str().to_string()))
}

/// Extract content between outermost parentheses (e.g., "(a, b, c)" -> "a, b, c")
fn extract_parens_content(text: &str) -> Option<String> {
    let start = text.find('(')?;
    let mut depth = 0;
    let mut end = start;
    for (i, c) in text[start..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    if end > start {
        Some(text[start + 1..end].to_string())
    } else {
        None
    }
}

fn parse_param(text: &str, prefix: &str, param_list: &mut Vec<Param>) {
    let mut ptype = String::new();
    let mut is_prm = false;
    let re = Regex::new(&format!(
        r"(?P<prefix>{}\s+)?(?P<type>.*?)(?P<name>\w+)\s*=(?P<value>.*)",
        regex::escape(prefix)
    ))
    .unwrap();

    for strl in text.split(',') {
        if let Some(caps) = re.captures(strl) {
            let raw_type = caps.name("type").map(|x| x.as_str().trim()).unwrap_or("");
            ptype = Regex::new(r"\s{2,}")
                .unwrap()
                .replace_all(raw_type, " ")
                .trim()
                .to_string();
            let pname = caps.name("name").unwrap().as_str().to_string();
            let p_val = caps.name("value").unwrap().as_str().trim().to_string();
            param_list.push(Param {
                kind: prefix.to_string(),
                ptype: ptype.clone(),
                name: pname,
                value: p_val,
            });
            is_prm = true;
        } else {
            let simple_re = Regex::new(r"(?P<name>\w+)\s*=(?P<value>.*)").unwrap();
            if let Some(caps) = simple_re.captures(strl) {
                if is_prm {
                    let pname = caps.name("name").unwrap().as_str().to_string();
                    let p_val = caps.name("value").unwrap().as_str().trim().to_string();
                    param_list.push(Param {
                        kind: prefix.to_string(),
                        ptype: ptype.clone(),
                        name: pname,
                        value: p_val,
                    });
                }
            }
        }
    }
}

fn parse_ports(text: &str, ports_list: &mut Vec<Port>) {
    let mut p_dir = String::new();
    let mut psize = String::new();

    for strl in text.split(',') {
        let strl = Regex::new(r"=.*").unwrap().replace(strl, "").to_string();
        let stra = Regex::new(r"\[.*?\]").unwrap().replace_all(&strl, " ");
        let pntmp: Vec<&str> = Regex::new(r"\w+")
            .unwrap()
            .find_iter(&stra)
            .map(|m| m.as_str())
            .collect();
        let pname = pntmp.last().unwrap_or(&"").to_string();
        let pdtmp = regex_search(r"\binput\b|\boutput\b|\binout\b", &strl);
        let pstmp = regex_search(r"\[.*?\]|\bsigned\s*\[.*?\]|\bsigned\b", &strl);

        if let Some(ref dir) = pdtmp {
            p_dir = dir.clone();
        }
        if !pname.is_empty() {
            if pdtmp.is_some() {
                if let Some(ref size) = pstmp {
                    psize = size.clone();
                }
            }
            ports_list.push(Port {
                direction: p_dir.clone(),
                size: psize.clone(),
                name: pname,
            });
        }
    }
}

fn get_clock_reset(text: &str) -> (Vec<String>, Vec<String>) {
    let mut clks = Vec::new();
    let mut rsts = Vec::new();

    for caps in Regex::new(r"always\s*@\s*\(.+?\)")
        .unwrap()
        .captures_iter(text)
    {
        let strl = caps.get(0).unwrap().as_str();
        for m in Regex::new(r"(?:posedge)\s+([\w\d]+)")
            .unwrap()
            .captures_iter(strl)
        {
            clks.push(m.get(1).unwrap().as_str().to_string());
        }
        for m in Regex::new(r"(?:negedge)\s+([\w\d]+)")
            .unwrap()
            .captures_iter(strl)
        {
            rsts.push(m.get(1).unwrap().as_str().to_string());
        }
    }

    // Deduplicate
    clks.sort();
    clks.dedup();
    rsts.sort();
    rsts.dedup();

    (clks, rsts)
}
