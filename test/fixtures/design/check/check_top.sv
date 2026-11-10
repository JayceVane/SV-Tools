// 结构检查样例：悬空 input/output、网络无驱动、多驱动、隐式扩展、常量驱动与未声明模块。
// 期望（见 design_check_test）：4 error（UNRESOLVED_MODULE/UNDRIVEN_INPUT×2/MULTI_DRIVER）
// 与 4 warning（UNCONNECTED_PORT×2/UNDRIVEN_OUTPUT/WIDTH_MISMATCH）；const_in 常量驱动无假诊断。
module check_sub (
    input  logic        clk,
    input  logic [7:0]  wide_in,
    input  logic [7:0]  const_in,
    output logic [3:0]  used_out,
    output logic [7:0]  drop_out
);
    assign used_out = wide_in[3:0] + const_in[3:0];
    assign drop_out = const_in;
endmodule

module check_top (
    input  logic clk,
    output logic [3:0] q,
    output logic dangling_out
);
    logic [3:0] trunc;
    check_sub u_a (.clk(clk), .const_in(8'h00), .used_out(q), .drop_out());
    check_sub u_b (.clk(clk), .const_in(8'h00), .used_out(q), .wide_in(trunc), .drop_out());
    ghost_mod u_g (.x(clk), .y());
endmodule
