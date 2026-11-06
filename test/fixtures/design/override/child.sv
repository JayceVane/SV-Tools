// A2：参数覆盖夹具的子模块（空模块 blackbox，声明默认 WIDTH=8）。
module child #(
    parameter int WIDTH = 8
) (
    input  logic             clk,
    input  logic [WIDTH-1:0] din,
    output logic [WIDTH-1:0] dout
);
endmodule
