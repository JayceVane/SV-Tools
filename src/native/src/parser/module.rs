use regex::Regex;
use std::collections::HashMap;

use crate::config::GadgetOptions;
use crate::source_scan;

/// 代码生成需要的模块头与输入控制事实；不进行预处理或详细化。
pub struct ModuleInfo {
    pub name: String,
    pub ports: Vec<Port>,
    pub params: Vec<Param>,
    pub clocks: Vec<String>,
    pub resets: Vec<String>,
    /// 异步控制事件沿给出的有效电平；true表示低有效，冲突沿不作推断。
    pub reset_polarities: HashMap<String, bool>,
}

#[derive(Debug, Clone)]
pub struct Port {
    pub direction: String,
    pub size: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct Param {
    pub kind: String,
    pub ptype: String,
    pub name: String,
    pub value: String,
}

/// 解析首个模块；括号不匹配或头部不完整时返回None，不把参数猜成端口。
pub fn parse_module(text: &str, options: &GadgetOptions) -> Option<ModuleInfo> {
    parse_module_checked(text, options).ok()
}

/// 模板生成入口；不支持的接口明确返回错误，禁止静默省略端口或猜测位宽。
pub fn parse_module_checked(text: &str, options: &GadgetOptions) -> Result<ModuleInfo, String> {
    let cleaned = crate::parser::comments::clean_comment(text);
    let masked = syntax_mask(&cleaned);
    let declaration =
        Regex::new(r"\bmodule\s+(?:(?:automatic|static)\s+)?(?P<name>[a-zA-Z_$][\w$]*)").unwrap();
    let header = declaration
        .captures(&masked)
        .ok_or("未找到可解析的module声明")?;
    let module = header.name("name").unwrap().as_str().to_string();
    let mut cursor = source_scan::next_code_offset(&cleaned, header.get(0).unwrap().end());
    let mut params = Vec::new();
    if cleaned.as_bytes().get(cursor) == Some(&b'#') {
        cursor = source_scan::next_code_offset(&cleaned, cursor + 1);
        if cleaned.as_bytes().get(cursor) != Some(&b'(') {
            return Err("模块参数列表缺少左括号".into());
        }
        let end = source_scan::find_matching(&masked, cursor).ok_or("模块参数或端口括号不完整")?;
        parse_param(&cleaned[cursor + 1..end], "parameter", &mut params);
        cursor = source_scan::next_code_offset(&cleaned, end + 1);
    }
    let mut ports = Vec::new();
    if cleaned.as_bytes().get(cursor) == Some(&b'(') {
        let end = source_scan::find_matching(&masked, cursor).ok_or("模块参数或端口括号不完整")?;
        parse_ports(&cleaned[cursor + 1..end], &mut ports)?;
        cursor = source_scan::next_code_offset(&cleaned, end + 1);
    }
    if cleaned.as_bytes().get(cursor) != Some(&b';') {
        return Err("模块头不完整或包含暂不支持的接口语法".into());
    }
    let body_start = cursor + 1;
    let body_end = Regex::new(r"\bendmodule\b")
        .unwrap()
        .find(&masked[body_start..])
        .ok_or("模块缺少endmodule")?
        .start()
        + body_start;
    let body = &cleaned[body_start..body_end];
    let body_mask = mask_subprograms(&masked[body_start..body_end]);

    // 非ANSI端口只补全模块头已有名称；子程序形参不新增模块接口。
    for found in Regex::new(r"\b(?:input|output|inout)\b[^;]*;")
        .unwrap()
        .find_iter(&body_mask)
    {
        let mut declarations = Vec::new();
        parse_ports(
            body[found.start()..found.end()].trim_end_matches(';'),
            &mut declarations,
        )?;
        for declaration in declarations {
            if let Some(port) = ports.iter_mut().find(|port| port.name == declaration.name) {
                port.direction = declaration.direction;
                port.size = declaration.size;
            }
        }
    }
    for found in Regex::new(r"\b(?:parameter|localparam)\b[^;]*;")
        .unwrap()
        .find_iter(&body_mask)
    {
        parse_param(
            body[found.start()..found.end()].trim_end_matches(';'),
            "parameter",
            &mut params,
        );
    }
    if let Some(port) = ports.iter().find(|port| port.direction.is_empty()) {
        return Err(format!(
            "无法生成模板：端口{}缺少可解析的input/output/inout声明；接口或modport暂不支持",
            port.name
        ));
    }
    let (clocks, resets, reset_polarities) = get_clock_reset(body, &ports, options);
    Ok(ModuleInfo {
        name: module,
        ports,
        params,
        clocks,
        resets,
        reset_polarities,
    })
}

fn syntax_mask(text: &str) -> String {
    // 宏名按原文保留；只遮住反引号，避免同一行的后续括号/逗号被当成整行指令。
    source_scan::mask_non_code(&text.replace('`', " "))
}

/// 分隔位置来自共享平衡扫描，参数字符串与宏名始终从原文切片。
fn split_declarations(text: &str, separator: char) -> Vec<&str> {
    let masked = syntax_mask(text);
    let mut cursor = 0;
    source_scan::split_top_level(&masked, separator)
        .into_iter()
        .map(|part| {
            let source = &text[cursor..cursor + part.len()];
            cursor += part.len() + separator.len_utf8();
            source
        })
        .collect()
}

fn parse_param(text: &str, prefix: &str, params: &mut Vec<Param>) {
    let declaration = Regex::new(r"(?s)^\s*(?:(?P<kind>parameter|localparam)\s+)?(?P<type>.*?)(?P<name>[a-zA-Z_$][\w$]*)\s*$").unwrap();
    let mut inherited_type = String::new();
    let mut kind = prefix.to_string();
    for part in split_declarations(text, ',') {
        let parts = split_declarations(part, '=');
        if parts.len() < 2 {
            continue;
        }
        let left = parts[0];
        let Some(captures) = declaration.captures(left) else {
            continue;
        };
        let ptype = captures.name("type").unwrap().as_str().trim();
        if let Some(keyword) = captures.name("kind") {
            kind = keyword.as_str().to_string();
            inherited_type = ptype.to_string();
        } else if !ptype.is_empty() {
            inherited_type = ptype.to_string();
        }
        params.push(Param {
            kind: kind.clone(),
            ptype: inherited_type.clone(),
            name: captures.name("name").unwrap().as_str().to_string(),
            value: part[left.len() + 1..].trim().to_string(),
        });
    }
}

fn unsupported_port(declaration: &str) -> String {
    let snippet: String = declaration.chars().take(160).collect();
    format!("无法生成模板：暂不支持端口声明 `{snippet}`；数组、接口或用户类型需要先转换为明确的位向量接口")
}

fn parse_ports(text: &str, ports: &mut Vec<Port>) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let direction = Regex::new(r"\b(input|output|inout)\b").unwrap();
    let identifier = Regex::new(r"(?P<name>[a-zA-Z_$][\w$]*)\s*$").unwrap();
    let mut current_direction = String::new();
    let mut size = String::new();
    for part in split_declarations(text, ',') {
        let declaration = split_declarations(part, '=')[0].trim();
        let name = identifier
            .captures(declaration)
            .and_then(|captures| captures.name("name"))
            .ok_or_else(|| unsupported_port(declaration))?;
        let prefix = &declaration[..name.start()];
        let found_direction = direction.find(prefix);
        let ptype = if let Some(found) = found_direction {
            current_direction = found.as_str().to_string();
            if !prefix[..found.start()].trim().is_empty() {
                return Err(unsupported_port(declaration));
            }
            &prefix[found.end()..]
        } else {
            prefix
        };
        if found_direction.is_some() || !ptype.trim().is_empty() {
            if current_direction.is_empty() {
                return Err(unsupported_port(declaration));
            }
            size = port_size(ptype).ok_or_else(|| unsupported_port(declaration))?;
        }
        ports.push(Port {
            direction: current_direction.clone(),
            size: size.clone(),
            name: name.as_str().to_string(),
        });
    }
    Ok(())
}

/// 当前Port模型只表达位向量；明确builtin整数按标准固定宽度映射，其余类型拒绝猜测。
fn port_size(prefix: &str) -> Option<String> {
    let prefix_mask = syntax_mask(prefix);
    let mut masked = prefix_mask.clone().into_bytes();
    let mut ranges = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = prefix_mask[cursor..].find('[') {
        let open = cursor + offset;
        let close = source_scan::find_matching(&prefix_mask, open)?;
        ranges.push(prefix[open..=close].to_string());
        masked[open..=close].fill(b' ');
        cursor = close + 1;
    }
    let remaining = String::from_utf8(masked).ok()?;
    let words: Vec<_> = remaining.split_whitespace().collect();
    if words.iter().any(|word| {
        !matches!(
            *word,
            "wire"
                | "reg"
                | "logic"
                | "bit"
                | "var"
                | "signed"
                | "unsigned"
                | "integer"
                | "int"
                | "byte"
                | "shortint"
                | "longint"
                | "time"
        )
    }) {
        return None;
    }
    let integer_types: Vec<_> = words
        .iter()
        .filter(|word| {
            matches!(
                **word,
                "integer" | "int" | "byte" | "shortint" | "longint" | "time"
            )
        })
        .collect();
    if integer_types.len() > 1 {
        return None;
    }
    let mut signed = words.contains(&"signed");
    if let Some(kind) = integer_types.first() {
        if !ranges.is_empty() {
            return None;
        }
        let width = match **kind {
            "byte" => 8,
            "shortint" => 16,
            "longint" | "time" => 64,
            _ => 32,
        };
        ranges.push(format!("[{}:0]", width - 1));
        signed |= **kind != "time" && !words.contains(&"unsigned");
    }
    let mut result = if signed {
        vec!["signed".to_string()]
    } else {
        Vec::new()
    };
    result.extend(ranges);
    Some(result.join(" "))
}

fn mask_subprograms(masked: &str) -> String {
    Regex::new(r"(?s)\b(?:task\b.*?\bendtask|function\b.*?\bendfunction)\b")
        .unwrap()
        .replace_all(masked, |captures: &regex::Captures| {
            " ".repeat(captures[0].len())
        })
        .into_owned()
}

fn is_reset_name(name: &str) -> bool {
    Regex::new(r"(?i)(?:^|_)(?:a?rst|a?reset|srst|sreset)n?(?:_|$)")
        .unwrap()
        .is_match(name)
}
fn is_clock_name(name: &str) -> bool {
    Regex::new(r"(?i)(?:^|_)(?:clk|clock)(?:_|$)")
        .unwrap()
        .is_match(name)
}

fn get_clock_reset(
    text: &str,
    ports: &[Port],
    options: &GadgetOptions,
) -> (Vec<String>, Vec<String>, HashMap<String, bool>) {
    let inputs: Vec<_> = ports
        .iter()
        .filter(|port| port.direction == "input")
        .map(|port| port.name.as_str())
        .collect();
    let mut clocks = Vec::new();
    let mut resets = Vec::new();
    let mut edges: HashMap<String, Option<bool>> = HashMap::new();
    let masked = syntax_mask(text);
    let process = Regex::new(r"\balways(?:_ff)?\s*@\s*\(").unwrap();
    let event = Regex::new(r"\b(posedge|negedge)\s*\(?\s*([a-zA-Z_$][\w$]*)").unwrap();
    for found in process.find_iter(&masked) {
        let open = found.end() - 1;
        let Some(close) = source_scan::find_matching(&masked, open) else {
            continue;
        };
        let mut has_clock = false;
        for capture in event.captures_iter(&masked[open + 1..close]) {
            let name = capture.get(2).unwrap().as_str();
            if !inputs.contains(&name) {
                continue;
            }
            let configured_reset = options
                .reset()
                .iter()
                .chain(options.sreset())
                .any(|reset| reset == name);
            let configured_clock = options.clock().iter().any(|clock| clock == name);
            if configured_reset
                || is_reset_name(name)
                || has_clock && !configured_clock && !is_clock_name(name)
            {
                resets.push(name.to_string());
                let low = capture.get(1).unwrap().as_str() == "negedge";
                edges
                    .entry(name.to_string())
                    .and_modify(|existing| {
                        if *existing != Some(low) {
                            *existing = None;
                        }
                    })
                    .or_insert(Some(low));
            } else {
                clocks.push(name.to_string());
                has_clock = true;
            }
        }
    }
    for name in inputs {
        if options
            .reset()
            .iter()
            .chain(options.sreset())
            .any(|reset| reset == name)
            || is_reset_name(name)
        {
            resets.push(name.to_string());
        } else if options.clock().iter().any(|clock| clock == name) || is_clock_name(name) {
            clocks.push(name.to_string());
        }
    }
    clocks.retain(|clock| !resets.contains(clock));
    clocks.sort();
    clocks.dedup();
    resets.sort();
    resets.dedup();
    (
        clocks,
        resets,
        edges
            .into_iter()
            .filter_map(|(name, low)| low.map(|low| (name, low)))
            .collect(),
    )
}

#[cfg(test)]
mod param_dbg {
    use super::*;
    use crate::config::GadgetOptions;
    #[test]
    fn test_param_no_keyword_in_ptype() {
        // normalize 后参数表单行、片段带前导空格——ptype 不得残留 parameter 关键字
        let text = "module sfifo #(\n    parameter DATA_WIDTH = 8,\n    parameter DEPTH = 4\n) (\n    input i_clk\n);\nendmodule\n";
        let info = parse_module(text, &GadgetOptions::default()).unwrap();
        assert_eq!(info.params.len(), 2, "params: {:?}", info.params);
        for p in &info.params {
            assert!(p.ptype.is_empty(), "ptype 残留关键字: {:?}", p);
        }
        assert_eq!(info.params[0].name, "DATA_WIDTH");
        assert_eq!(info.params[1].name, "DEPTH");
    }
}

#[cfg(test)]
mod release_tests {
    use super::*;

    #[test]
    fn nested_parameter_values_do_not_become_ports() {
        let source = r#"module nested #(parameter W=$clog2(16), parameter PAIR={8'd1,8'd2}, parameter LABEL="a,b)")(input clk, input [W-1:0] d, output [W-1:0] q); assign q=d; endmodule"#;
        let info = parse_module(source, &GadgetOptions::default()).unwrap();
        assert_eq!(
            info.ports
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["clk", "d", "q"]
        );
        assert_eq!(
            info.params
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["W", "PAIR", "LABEL"]
        );
        assert_eq!(info.params[1].value, "{8'd1,8'd2}");
        assert_eq!(info.params[2].value, "\"a,b)\"");
    }

    #[test]
    fn inherited_parameter_type_survives_nested_commas() {
        let info = parse_module(
            "module typed #(parameter integer A=1, B=$clog2(8), parameter C=3)(input d); endmodule",
            &GadgetOptions::default(),
        )
        .unwrap();
        assert_eq!(
            info.params
                .iter()
                .map(|p| p.ptype.as_str())
                .collect::<Vec<_>>(),
            ["integer", "integer", ""]
        );
    }

    #[test]
    fn always_ff_negative_clock_and_positive_reset_are_distinct() {
        let info = parse_module("module sample(input sample_clk, input rst, input d, output logic q); always_ff @(negedge sample_clk or posedge rst) if(rst) q<=0; else q<=d; endmodule", &GadgetOptions::default()).unwrap();
        assert_eq!(info.clocks, ["sample_clk"]);
        assert_eq!(info.resets, ["rst"]);
    }

    #[test]
    fn configured_output_controls_are_never_driven() {
        let mut options = GadgetOptions::default();
        options.clock = Some(vec!["clk_out".into()]);
        options.reset = Some(vec!["reset_out".into()]);
        let info = parse_module("module source(input d, output clk_out, output reset_out); assign clk_out=d; assign reset_out=d; endmodule", &options).unwrap();
        assert!(info.clocks.is_empty());
        assert!(info.resets.is_empty());
    }

    #[test]
    fn header_macros_keep_following_parameters_and_ports() {
        let source = "module macro_defaults #(parameter W=`WIDTH, parameter PAIR={`A,`B})(input [W-1:0] d, output [W-1:0] q); assign q=d; endmodule";
        let info = parse_module(source, &GadgetOptions::default()).unwrap();
        assert_eq!(info.params.len(), 2);
        assert_eq!(info.params[0].value, "`WIDTH");
        assert_eq!(info.params[1].value, "{`A,`B}");
        assert_eq!(
            info.ports
                .iter()
                .map(|port| port.name.as_str())
                .collect::<Vec<_>>(),
            ["d", "q"]
        );
    }

    #[test]
    fn semicolon_url_and_spaces_inside_parameters_are_preserved() {
        let source = r#"module literals #(parameter LABEL="https://example.invalid/a;  b)")(input d, output q); assign q=d; endmodule"#;
        let info = parse_module(source, &GadgetOptions::default()).unwrap();
        assert_eq!(info.params[0].value, "\"https://example.invalid/a;  b)\"");
        assert_eq!(info.ports.len(), 2);
    }

    #[test]
    fn unsupported_interfaces_fail_closed_instead_of_dropping_ports() {
        for declaration in [
            "input logic [7:0] mem [0:3]",
            "input pkg::type_t d",
            "axi_if.master bus",
            "axi_if bus",
            "input real value",
        ] {
            let source = format!("module unsupported({declaration}); endmodule");
            assert!(
                parse_module(&source, &GadgetOptions::default()).is_none(),
                "{declaration}"
            );
        }
    }

    #[test]
    fn builtin_integer_ports_keep_their_full_width_and_signedness() {
        let info = parse_module(
            "module integers(input int d, input byte unsigned b, output longint q); endmodule",
            &GadgetOptions::default(),
        )
        .unwrap();
        assert_eq!(
            info.ports
                .iter()
                .map(|port| port.size.as_str())
                .collect::<Vec<_>>(),
            ["signed [31:0]", "[7:0]", "signed [63:0]"]
        );
    }

    #[test]
    fn subprogram_formals_cannot_overwrite_module_port_declarations() {
        let source = "module shadow(d,q); input [7:0] d; output [7:0] q; task sample; input [1:0] d; endtask function logic f; input [2:0] q; f=1; endfunction assign q=d; endmodule";
        let info = parse_module(source, &GadgetOptions::default()).unwrap();
        assert_eq!(
            info.ports
                .iter()
                .map(|port| (port.direction.as_str(), port.size.as_str()))
                .collect::<Vec<_>>(),
            [("input", "[7:0]"), ("output", "[7:0]")]
        );
    }

    #[test]
    fn packed_macro_ranges_are_preserved_without_expanding_macros() {
        let info = parse_module(
            "module macro_ports(input [`WIDTH-1:0] d, output [1:0][`WIDTH-1:0] q); endmodule",
            &GadgetOptions::default(),
        )
        .unwrap();
        assert_eq!(info.ports[0].size, "[`WIDTH-1:0]");
        assert_eq!(info.ports[1].size, "[1:0] [`WIDTH-1:0]");
    }
}
