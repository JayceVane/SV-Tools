use super::module_inst::build_instance_code;
use crate::config::GadgetOptions;
use crate::parser::module::ModuleInfo;

/// Generate testbench code.
/// Replicates Python `vg_core.generate_testbench()`.
pub fn generate_testbench(info: &ModuleInfo, options: &GadgetOptions) -> String {
    let module = &info.name;
    let iprefix = options.inst_prefix();

    let resetl: Vec<String> = options
        .reset()
        .iter()
        .chain(info.resets.iter())
        .cloned()
        .collect();
    let sresetl: Vec<String> = options.sreset().to_vec();
    let clockl: Vec<String> = options
        .clock()
        .iter()
        .chain(info.clocks.iter())
        .cloned()
        .collect();
    let clkrstl: Vec<String> = clockl
        .iter()
        .chain(resetl.iter())
        .chain(sresetl.iter())
        .cloned()
        .collect();

    let declp = declare_param(&info.params);
    let decls = declare_sigls(&info.ports, &clkrstl);
    // Use build_instance_code from module_inst for aligned formatting with comments
    // Add tab indentation to each line of the instance
    let minst_raw = build_instance_code(info, iprefix);
    let minst = minst_raw
        .lines()
        .map(|line| format!("\t{}", line))
        .collect::<Vec<_>>()
        .join("\n");

    let arstb = resetl.first().cloned().unwrap_or_default();
    let srstb = sresetl.first().cloned().unwrap_or_default();
    let clock = clockl.first().cloned().unwrap_or_default();

    // Clock generation
    let sclks = if !clock.is_empty() {
        format!(
            "\n\t// clock\n\tlogic {};\n\tinitial begin\n\t\t{} = '0;\n\t\tforever #(0.5) {} = ~{};\n\tend\n",
            clock, clock, clock, clock
        )
    } else {
        String::new()
    };

    // Async reset
    let arsts = if !arstb.is_empty() {
        let (init_val, final_val) = if arstb.ends_with('n') {
            // Active-low: start asserted ('0 = reset), then release ('1 = normal)
            ("'0", "'1")
        } else {
            // Active-high: start asserted ('1 = reset), then release ('0 = normal)
            ("'1", "'0")
        };
        format!(
            "\n\t// asynchronous reset\n\tlogic {};\n\tinitial begin\n\t\t{} <= {};\n\t\t#10\n\t\t{} <= {};\n\tend\n",
            arstb, arstb, init_val, arstb, final_val
        )
    } else {
        String::new()
    };

    // Sync reset
    let srsts = if !srstb.is_empty() {
        let (init_val, final_val) = if srstb.ends_with('n') {
            ("'0", "'1")
        } else {
            ("'1", "'0")
        };
        format!(
            "\n\t// synchronous reset\n\tlogic {};\n\tinitial begin\n\t\t{} <= {};\n\t\trepeat(5)@(posedge {});\n\t\t{} <= {};\n\tend\n",
            srstb, srstb, init_val, clock, srstb, final_val
        )
    } else {
        String::new()
    };

    // Task init - placeholder for additional initialization logic
    let (taski, dtski) = if options.task_init() {
        let task = String::from("\n\t// initialization task - add custom init logic here\n\ttask init();\n\t\t// TODO: add initialization logic\n\tendtask\n");
        let dt = if !clock.is_empty() {
            format!("\n\t\tinit();\n\t\trepeat(10)@(posedge {});\n", clock)
        } else {
            "\t\tinit();\n\n".to_string()
        };
        (task, dt)
    } else {
        (String::new(), String::new())
    };

    // Task drive
    let (taskd, dtskd) = if options.task_drive() {
        let task = task_drive(&clock);
        let dt = "\n\t\tdrive(20);\n".to_string();
        (task, dt)
    } else {
        (String::new(), String::new())
    };

    // Wave dump
    let str_dump = match options.wave_type() {
        "fsdb" => format!(
            "\n\tif ( $test$plusargs(\"fsdb\") ) begin\n\t\t$fsdbDumpfile(\"tb_{}.fsdb\");\n\t\t$fsdbDumpvars(0, \"tb_{}\", \"+mda\", \"+functions\");\n\tend",
            module, module
        ),
        "vpd" => format!(
            "\n\t$vcdplusfile(\"tb_{}.vpd\");\n\t$vcdpluson(0, \"tb_{}\");",
            module, module
        ),
        "shm" => format!(
            "\n\t$shm_open(\"tb_{}.shm\");\n\t$shm_probe();",
            module
        ),
        "vcd" => format!(
            "\n\tif ( $test$plusargs(\"vcd\") ) begin\n\t\t$dumpfile(\"tb_{}.vcd\");\n\t\t$dumpvars(0, \"tb_{}\");\n\tend",
            module, module
        ),
        _ => String::new(),
    };

    let declp_out = if declp.is_empty() {
        String::new()
    } else {
        format!("{}\n", declp)
    };
    let decls_out = if decls.is_empty() {
        String::new()
    } else {
        format!("{}\n", decls)
    };

    format!(
        "`timescale 1ns/1ps\nmodule tb_{} (); /* this is automatically generated */\n{}{}{}\n\t// (*NOTE*) replace reset, clock, others\n{}{}{}{}{}\n\tinitial begin\n\t\t// do something\n{}{}\t\trepeat(10)@(posedge {});\n\t\t$finish;\n\tend\n\n\t// dump wave\n\tinitial begin\n\t\t$display(\"random seed : %0d\", $unsigned($get_initial_random_seed()));{}\n\tend\n\nendmodule\n",
        module,
        sclks, arsts, srsts,
        declp_out, decls_out, minst, taski, taskd,
        dtski, dtskd,
        clock,
        str_dump
    )
}

fn declare_param(params: &[crate::parser::module::Param]) -> String {
    let prml: Vec<&crate::parser::module::Param> =
        params.iter().filter(|p| p.kind == "parameter").collect();
    if prml.is_empty() {
        return String::new();
    }

    let mut text = String::new();
    let mut lmax = 0;
    let mut strl = Vec::new();

    for p in &prml {
        let tmps = if p.ptype.is_empty() {
            format!("{} {}", p.kind, p.name)
        } else {
            format!("{} {} {}", p.kind, p.ptype, p.name)
        };
        lmax = lmax.max(tmps.len());
        strl.push(tmps);
    }

    for (i, tmps) in strl.iter().enumerate() {
        let sp = lmax - tmps.len();
        let lend = if i == strl.len() - 1 { "\n" } else { ",\n" };
        if !prml[i].ptype.is_empty() {
            text.push_str(&format!(
                "\t{}{} {} {} = {}{}",
                tmps,
                " ".repeat(sp),
                prml[i].ptype,
                prml[i].name,
                prml[i].value,
                lend
            ));
        } else {
            text.push_str(&format!(
                "\t{}{} {} = {}{}",
                tmps,
                " ".repeat(sp),
                prml[i].name,
                prml[i].value,
                lend
            ));
        }
    }
    text
}

fn declare_sigls(ports: &[crate::parser::module::Port], clkrstl: &[String]) -> String {
    let mut text = String::new();
    let mut lmax = 0;
    let mut strl = Vec::new();

    for p in ports {
        let tmps = format!("logic {}", p.size);
        lmax = lmax.max(tmps.len());
        strl.push(tmps);
    }

    for (i, tmps) in strl.iter().enumerate() {
        if !clkrstl.contains(&ports[i].name) {
            let sp = lmax - tmps.len();
            text.push_str(&format!(
                "\t{}{} {};\n",
                tmps,
                " ".repeat(sp),
                ports[i].name
            ));
        }
    }
    text
}

fn task_drive(clock: &str) -> String {
    let mut text = String::from("\n\ttask drive(int iter);\n");
    text.push_str("\t\tfor(int it = 0; it < iter; it++) begin\n");
    if !clock.is_empty() {
        text.push_str(&format!("\t\t\t@(posedge {});\n", clock));
    }
    text.push_str("\t\tend\n");
    text.push_str("\tendtask\n");
    text
}
