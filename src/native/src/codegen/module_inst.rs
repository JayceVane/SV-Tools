use crate::parser::module::{ModuleInfo, Param};

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

    // Calculate max port name length for alignment
    let port_max_len = info.ports.iter().map(|p| p.name.len()).max().unwrap_or(0);

    // 例化按端口原名生成连接；时钟/复位分类不能把多个域折叠成首个信号。
    // Always use expanded multi-line format with aligned ports and comments
    let mut s = if plen > 0 {
        let mut s = format!("{} #(\n", info.name);

        // Calculate max param name length for alignment
        let param_max_len = prmonly.iter().map(|p| p.name.len()).max().unwrap_or(0);

        for (i, p) in prmonly.iter().enumerate() {
            let pad = param_max_len - p.name.len();
            s.push_str(&format!("    .{}{} ({})", p.name, " ".repeat(pad), p.name));
            if i != plen - 1 {
                s.push_str(",\n");
            } else {
                s.push('\n');
            }
        }
        s.push_str(&format!(") {}{} (\n", iprefix, info.name));
        s
    } else {
        format!("{} {}{} (\n", info.name, iprefix, info.name)
    };

    // Calculate max direction and size lengths for comment alignment
    let dir_max_len = info
        .ports
        .iter()
        .map(|p| p.direction.len())
        .max()
        .unwrap_or(0);
    let size_max_len = info
        .ports
        .iter()
        .map(|p| p.size.trim().len())
        .max()
        .unwrap_or(0);

    for (i, p) in info.ports.iter().enumerate() {
        // Align port name (right-pad with spaces)
        let port_padding = port_max_len - p.name.len();

        // Build comment with aligned columns: // direction  [width]  port_name
        let dir_pad = dir_max_len - p.direction.len();
        let sz = p.size.trim();
        let comment = if sz.is_empty() {
            // No size: direction + padding + spaces for size column + port name
            format!(
                "// {}{}  {}{}",
                p.direction,
                " ".repeat(dir_pad),
                " ".repeat(size_max_len),
                p.name
            )
        } else {
            let size_pad = size_max_len - sz.len();
            format!(
                "// {}{} {}{} {}",
                p.direction,
                " ".repeat(dir_pad),
                sz,
                " ".repeat(size_pad),
                p.name
            )
        };

        // Format: .port_name          (signal_name          ), // comment
        // Last port: no comma, extra space
        if i != info.ports.len() - 1 {
            s.push_str(&format!(
                "    .{}{} ({}{}), {}\n",
                p.name,
                " ".repeat(port_padding),
                p.name,
                " ".repeat(port_padding),
                comment
            ));
        } else {
            s.push_str(&format!(
                "    .{}{} ({}{})  {}\n",
                p.name,
                " ".repeat(port_padding),
                p.name,
                " ".repeat(port_padding),
                comment
            ));
        }
    }
    s.push_str(");\n");
    s
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GadgetOptions;
    use crate::parser::module::parse_module;

    #[test]
    fn instance_connections_preserve_distinct_clock_reset_domains() {
        let source = "module cdc(input clk_a, rst_n_a, clk_b, rst_n_b, data, output q);\n\
            always @(posedge clk_a or negedge rst_n_a) q<=data;\n\
            always @(posedge clk_b or negedge rst_n_b) q<=data;\nendmodule";
        let info = parse_module(source, &GadgetOptions::default()).unwrap();
        assert_eq!(info.clocks, ["clk_a", "clk_b"]);
        assert_eq!(info.resets, ["rst_n_a", "rst_n_b"]);
        let output = build_instance_code(&info, "u_");
        let binding = regex::Regex::new(r"(?m)^\s*\.(\w+)\s*\(\s*(\w+)\s*\)").unwrap();
        let bindings: Vec<_> = binding.captures_iter(&output).collect();
        assert_eq!(bindings.len(), info.ports.len());
        for (binding, port) in bindings.iter().zip(&info.ports) {
            assert_eq!(&binding[1], port.name);
            assert_eq!(&binding[2], port.name, "{output}");
        }
    }
}
