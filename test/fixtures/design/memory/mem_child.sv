// A4：折叠子模块内含内部存储；proc + memory_collect 后 JSON 可输出，存储不进入架构图。
module mem_child (
    input  logic       clk,
    input  logic [3:0] addr,
    input  logic [7:0] din,
    output logic [7:0] dout
);
    reg [7:0] mem [0:15];
    always_ff @(posedge clk) begin
        mem[addr] <= din;
    end
    assign dout = mem[addr];
endmodule
