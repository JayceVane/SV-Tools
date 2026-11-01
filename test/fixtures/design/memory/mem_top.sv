// A4：顶层例化带内部存储的子模块，架构图应折叠为盒且不出现 $mem 节点。
module mem_top (
    input  logic       clk,
    input  logic [3:0] addr,
    input  logic [7:0] din,
    output logic [7:0] dout
);
    mem_child u_mem (
        .clk(clk),
        .addr(addr),
        .din(din),
        .dout(dout)
    );
endmodule
