use super::module_inst::build_instance_code;
use crate::config::GadgetOptions;
use crate::parser::module::{ModuleInfo, Param, Port};

/// 生成可编辑的仿真骨架；每个真实输入控制独立驱动，不推断CDC关联或协议激励。
pub fn generate_testbench(info: &ModuleInfo, options: &GadgetOptions) -> String {
    let mut text = format!("`timescale 1ns/1ps\nmodule tb_{} ();\n", info.name);
    text.push_str(&declare_param(&info.params));
    text.push_str(&declare_signals(&info.ports));
    text.push('\n');
    for line in build_instance_code(info, options.inst_prefix()).lines() {
        text.push_str(&format!("\t{line}\n"));
    }
    if !info.clocks.is_empty() {
        text.push_str("\n\t// 各时钟暂用相同周期独立驱动；按设计修改周期和相位。\n");
    }
    for clock in &info.clocks {
        text.push_str(&format!(
            "\tinitial begin\n\t\t{clock} = '0;\n\t\tforever #(0.5) {clock} = ~{clock};\n\tend\n"
        ));
    }
    if !info.resets.is_empty() {
        text.push_str("\n\t// 复位独立保持10ns；请按设计检查同步释放时序和各域关联。\n");
    }
    for reset in &info.resets {
        let low = info
            .reset_polarities
            .get(reset)
            .copied()
            .unwrap_or_else(|| reset_name_active_low(reset));
        let (asserted, released) = if low { ("'0", "'1") } else { ("'1", "'0") };
        text.push_str(&format!("\tinitial begin\n\t\t{reset} = {asserted};\n\t\t#10;\n\t\t{reset} = {released};\n\tend\n"));
    }
    let inputs: Vec<_> = info
        .ports
        .iter()
        .filter(|port| {
            port.direction == "input"
                && !info.clocks.contains(&port.name)
                && !info.resets.contains(&port.name)
        })
        .collect();
    if !inputs.is_empty() {
        text.push_str("\n\t// 普通输入从确定值开始；请补充业务激励。\n\tinitial begin\n");
        for input in inputs {
            text.push_str(&format!("\t\t{} = '0;\n", input.name));
        }
        text.push_str("\tend\n");
    }
    let clock = info.clocks.first().map(String::as_str);
    if options.task_init() {
        text.push_str("\n\ttask automatic init();\n\t\tbegin\n\t\t\t// 在这里补充初始化操作。\n\t\tend\n\tendtask\n");
    }
    if options.task_drive() {
        text.push_str(&task_drive(clock));
    }
    text.push_str("\n\tinitial begin\n");
    if !info.resets.is_empty() {
        text.push_str("\t\t#10;\n");
    }
    if options.task_init() {
        text.push_str("\t\tinit();\n");
        text.push_str(&wait_cycles(clock, 10));
    }
    if options.task_drive() {
        text.push_str("\t\tdrive(20);\n");
    }
    text.push_str(&wait_cycles(clock, 10));
    text.push_str("\t\t$finish;\n\tend\n");
    let dump = wave_dump(&info.name, options.wave_type());
    if !dump.is_empty() {
        text.push_str(&format!("\n\t// 波形记录\n\tinitial begin\n{dump}\tend\n"));
    }
    text.push_str("\nendmodule\n");
    text
}

fn reset_name_active_low(name: &str) -> bool {
    name.to_ascii_lowercase().split('_').any(|part| {
        matches!(
            part,
            "n" | "rstn" | "resetn" | "arstn" | "aresetn" | "srstn" | "sresetn"
        )
    })
}

fn declare_param(params: &[Param]) -> String {
    let mut text = String::new();
    for param in params {
        let ptype = if param.ptype.is_empty() {
            String::new()
        } else {
            format!("{} ", param.ptype)
        };
        text.push_str(&format!(
            "\t{} {}{} = {};\n",
            param.kind, ptype, param.name, param.value
        ));
    }
    text
}

fn declare_signals(ports: &[Port]) -> String {
    let mut text = String::new();
    for port in ports {
        let kind = if port.direction == "inout" {
            "wire"
        } else {
            "logic"
        };
        let size = if port.size.is_empty() {
            String::new()
        } else {
            format!("{} ", port.size)
        };
        text.push_str(&format!("\t{kind} {size}{};\n", port.name));
    }
    text
}

fn wait_cycles(clock: Option<&str>, count: usize) -> String {
    match clock {
        Some(clock) => format!("\t\trepeat({count}) @(posedge {clock});\n"),
        None => format!("\t\t#{count};\n"),
    }
}
fn task_drive(clock: Option<&str>) -> String {
    let wait = match clock {
        Some(clock) => format!("@(posedge {clock});"),
        None => "#1;".to_string(),
    };
    format!("\n\ttask automatic drive(input int iter);\n\t\tfor(int it = 0; it < iter; it++) begin\n\t\t\t{wait}\n\t\tend\n\tendtask\n")
}

fn wave_dump(module: &str, kind: &str) -> String {
    match kind {
        "vcd" => format!("\t\tif ($test$plusargs(\"vcd\")) begin\n\t\t\t$dumpfile(\"tb_{module}.vcd\");\n\t\t\t$dumpvars(0, tb_{module});\n\t\tend\n"),
        "fsdb" => format!("\t\tif ($test$plusargs(\"fsdb\")) begin\n\t\t\t$fsdbDumpfile(\"tb_{module}.fsdb\");\n\t\t\t$fsdbDumpvars(0, \"tb_{module}\", \"+mda\", \"+functions\");\n\t\tend\n"),
        "vpd" => format!("\t\t$vcdplusfile(\"tb_{module}.vpd\");\n\t\t$vcdpluson(0, \"tb_{module}\");\n"),
        "shm" => format!("\t\t$shm_open(\"tb_{module}.shm\");\n\t\t$shm_probe();\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod release_tests {
    use super::*;
    use crate::parser::module::parse_module;

    fn generated(source: &str) -> String {
        let options = GadgetOptions {
            wave_type: Some("vcd".into()),
            ..Default::default()
        };
        generate_testbench(&parse_module(source, &options).unwrap(), &options)
    }

    #[test]
    fn combinational_skeleton_uses_timed_progress_without_fake_controls() {
        let text = generated("module comb(input [7:0] d, output [7:0] q); assign q=d; endmodule");
        assert!(!text.contains("posedge"), "{text}");
        assert!(!text.contains("logic clk;"), "{text}");
        assert!(text.contains("d = '0;"), "{text}");
        assert!(text.contains("#10;"), "{text}");
        assert!(text.contains("$dumpvars(0, tb_comb);"), "{text}");
        assert!(!text.contains("$get_initial_random_seed"), "{text}");
    }

    #[test]
    fn every_clock_domain_is_driven_without_inventing_default_ports() {
        let text = generated("module cdc(input i_clk_a, input i_rst_n_a, input i_clk_b, input i_rst_n_b, input d, output logic a,b); always_ff @(posedge i_clk_a or negedge i_rst_n_a) if(!i_rst_n_a) a<=0; else a<=d; always @(negedge i_clk_b or negedge i_rst_n_b) if(!i_rst_n_b) b<=0; else b<=d; endmodule");
        for name in ["i_clk_a", "i_clk_b"] {
            assert!(
                text.contains(&format!("forever #(0.5) {name} = ~{name};")),
                "{text}"
            );
        }
        for name in ["i_rst_n_a", "i_rst_n_b"] {
            assert!(text.contains(&format!("{name} = '0;")), "{text}");
            assert!(text.contains(&format!("{name} = '1;")), "{text}");
        }
        assert!(!text.contains("logic clk;"), "{text}");
        assert!(!text.contains("logic rst_n;"), "{text}");
    }

    #[test]
    fn reset_event_edge_takes_precedence_over_name() {
        let text = generated("module reset_edge(input clk, input rst_n, output logic q); always @(posedge clk or posedge rst_n) if(rst_n) q<=0; else q<=1; endmodule");
        assert!(
            text.contains("rst_n = '1;\n\t\t#10;\n\t\trst_n = '0;"),
            "{text}"
        );
    }

    #[test]
    fn parameters_are_single_complete_declarations() {
        let text = generated("module params #(parameter W=8, parameter integer DEPTH=4)(input [W-1:0] d, output [W-1:0] q); assign q=d; endmodule");
        assert!(text.contains("parameter W = 8;"), "{text}");
        assert!(text.contains("parameter integer DEPTH = 4;"), "{text}");
        assert!(!text.contains("parameter W W"), "{text}");
    }

    #[test]
    fn disabled_tasks_still_allow_reset_release_and_real_clock_activity() {
        let options = GadgetOptions {
            task_init: Some(false),
            task_drive: Some(false),
            ..Default::default()
        };
        let info = parse_module("module reset_only(input clk, input rst_n, output logic q); always @(posedge clk or negedge rst_n) if(!rst_n) q<=0; else q<=1; endmodule", &options).unwrap();
        let text = generate_testbench(&info, &options);
        assert!(
            text.contains("initial begin\n\t\t#10;\n\t\trepeat(10) @(posedge clk);"),
            "{text}"
        );
    }

    #[test]
    fn default_waveform_is_portable_vcd_and_inout_has_no_variable_driver() {
        let options = GadgetOptions::default();
        assert_eq!(options.wave_type(), "vcd");
        let info = parse_module(
            "module bidir(input d, inout pad, output q); assign pad=1'bz; assign q=d; endmodule",
            &options,
        )
        .unwrap();
        let text = generate_testbench(&info, &options);
        assert!(text.contains("wire pad;"), "{text}");
        assert!(!text.contains("pad ="), "{text}");
        assert!(!text.contains("$fsdbDump"), "{text}");
    }
}
