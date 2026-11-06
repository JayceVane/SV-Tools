// filled：与 skeleton 同结构，但子模块实现已补；架构图仍折叠为盒。
module fifo_buf #(
    parameter WIDTH = 8
) (
    input  logic             clk,
    input  logic [WIDTH-1:0] din,
    output logic [WIDTH-1:0] dout
);
    logic [WIDTH-1:0] q;
    always_ff @(posedge clk) begin
        q <= din;
    end
    assign dout = q;
endmodule
