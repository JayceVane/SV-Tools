// skeleton：空模块（只有端口），由 Yosys 自动链接为 blackbox。
module fifo_buf #(
    parameter WIDTH = 8
) (
    input  logic             clk,
    input  logic [WIDTH-1:0] din,
    output logic [WIDTH-1:0] dout
);
endmodule
