use crate::parser::module::{ModuleInfo, Param, Port};

/// Generate module instantiation code with port declarations.
/// Replicates Python `vg_core.module_inst()` + `generate_port_declarations()`.
pub fn generate_module_inst(
    info: &ModuleInfo,
    include_declarations: bool,
    inst_prefix: &str,
) -> String {
    let mut result = String::new();

    // Generate parameter declarations as localparam
    if include_declarations {
        for p in &info.params {
            if p.kind == "parameter" {
                if !p.ptype.is_empty() {
                    result.push_str(&format!(
                        "localparam {} {} = {};\n",
                        p.ptype, p.name, p.value
                    ));
                } else {
                    result.push_str(&format!("localparam {} = {};\n", p.name, p.value));
                }
            }
        }

        // Generate signal declarations for ports
        for p in &info.ports {
            match p.direction.as_str() {
                "input" => {
                    if !p.size.is_empty() {
                        result.push_str(&format!("reg {} {};\n", p.size, p.name));
                    } else {
                        result.push_str(&format!("reg  {};\n", p.name));
                    }
                }
                "output" | "inout" => {
                    if !p.size.is_empty() {
                        result.push_str(&format!("wire {} {};\n", p.size, p.name));
                    } else {
                        result.push_str(&format!("wire {};\n", p.name));
                    }
                }
                _ => {}
            }
        }
    }

    if include_declarations && !result.is_empty() {
        result = format!("\n// Signal declarations\n{}", result);
    }

    // Generate instantiation
    let inst = build_instance(info, inst_prefix);
    result.push_str(&format!("\n{}", inst));
    result
}

fn build_instance(info: &ModuleInfo, iprefix: &str) -> String {
    let prmonly: Vec<&Param> = info
        .params
        .iter()
        .filter(|p| p.kind == "parameter")
        .collect();
    let plen = prmonly.len();

    // Estimate total chars to decide compact vs expanded
    let mut nchars = 0;
    for p in &prmonly {
        nchars += p.name.len() * 2 + 5;
    }
    for p in &info.ports {
        nchars += p.name.len() * 2 + 5;
    }

    let lmax = info.ports.iter().map(|p| p.name.len()).max().unwrap_or(0);

    if nchars > 80 {
        // Multi-line format
        let mut s = format!("\t{} ", info.name);
        if plen > 0 {
            s.push_str("#(\n");
            for (i, p) in prmonly.iter().enumerate() {
                s.push_str(&format!("\t\t\t.{}({})", p.name, p.name));
                if i != plen - 1 {
                    s.push_str(",\n");
                } else {
                    s.push('\n');
                }
            }
            s.push_str(&format!("\t\t) {}{} (\n", iprefix, info.name));
        } else {
            s.push_str(&format!("{}{}\n\t\t(\n", iprefix, info.name));
        }

        for (i, p) in info.ports.iter().enumerate() {
            let pmap = get_port_mapping(p, &info.clocks, &info.resets);
            let sp = lmax - p.name.len();
            s.push_str(&format!("\t\t\t.{}{} ({})", p.name, " ".repeat(sp), pmap));
            if i != info.ports.len() - 1 {
                s.push_str(",\n");
            } else {
                s.push('\n');
            }
        }
        s.push_str("\t\t);\n");
        s
    } else {
        // Compact format
        let mut s = format!("\t{} ", info.name);
        if plen > 0 {
            s.push('#');
            s.push('(');
            for (i, p) in prmonly.iter().enumerate() {
                s.push_str(&format!(".{}({})", p.name, p.name));
                if i != plen - 1 {
                    s.push_str(", ");
                }
            }
            s.push_str(") ");
        }
        s.push_str(&format!("{}{} (", iprefix, info.name));
        for (i, p) in info.ports.iter().enumerate() {
            let pmap = get_port_mapping(p, &info.clocks, &info.resets);
            s.push_str(&format!(".{}({})", p.name, pmap));
            if i != info.ports.len() - 1 {
                s.push_str(", ");
            }
        }
        s.push_str(");\n");
        s
    }
}

/// Generate only the port declarations (input→reg, output→wire) without instantiation.
/// Used by the napi `generate_module_inst` function.
pub fn generate_port_declarations_only(info: &ModuleInfo) -> String {
    let mut result = String::new();

    // Generate parameter declarations as localparam
    for p in &info.params {
        if p.kind == "parameter" {
            if !p.ptype.is_empty() {
                result.push_str(&format!(
                    "localparam {} {} = {};\n",
                    p.ptype, p.name, p.value
                ));
            } else {
                result.push_str(&format!("localparam {} = {};\n", p.name, p.value));
            }
        }
    }

    // Generate signal declarations for ports
    for p in &info.ports {
        match p.direction.as_str() {
            "input" => {
                if !p.size.is_empty() {
                    result.push_str(&format!("reg {} {};\n", p.size, p.name));
                } else {
                    result.push_str(&format!("reg  {};\n", p.name));
                }
            }
            "output" | "inout" => {
                if !p.size.is_empty() {
                    result.push_str(&format!("wire {} {};\n", p.size, p.name));
                } else {
                    result.push_str(&format!("wire {};\n", p.name));
                }
            }
            _ => {}
        }
    }

    result
}

/// Build module instantiation code (public wrapper for napi layer).
pub fn build_instance_code(info: &ModuleInfo, iprefix: &str) -> String {
    build_instance(info, iprefix)
}

fn get_port_mapping(port: &Port, clocks: &[String], resets: &[String]) -> String {
    if port.direction == "input" {
        if clocks.contains(&port.name) {
            return clocks.first().cloned().unwrap_or_else(|| port.name.clone());
        }
        if resets.contains(&port.name) {
            return resets.first().cloned().unwrap_or_else(|| port.name.clone());
        }
    }
    port.name.clone()
}
