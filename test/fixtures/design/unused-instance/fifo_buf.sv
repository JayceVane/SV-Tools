// unused-instance：输出的 tready 未连接；hierarchy+proc 必须保留该实例（prep 会优化掉）。
module fifo_buf #(
    parameter WIDTH = 8
) (
    input  logic             clk,
    input  logic [WIDTH-1:0] din,
    output logic [WIDTH-1:0] dout
);
endmodule
