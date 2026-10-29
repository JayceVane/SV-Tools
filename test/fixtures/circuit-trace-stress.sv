// 公开验收夹具：高扇出、多时钟、参数化重复实例、存储器和总线重排。
module trace_fanout #(parameter FANOUT = 768) (
    input wire i_enable,
    input wire [FANOUT-1:0] i_data,
    output wire [FANOUT-1:0] o_data
);
    for (genvar i = 0; i < FANOUT; i = i + 1) begin : g_lane
        assign o_data[i] = i_enable & i_data[i];
    end
endmodule

module trace_stage #(parameter WIDTH = 8) (
    input wire clk, rst_n, enable,
    input wire [WIDTH-1:0] data,
    output reg [WIDTH-1:0] q
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) q <= '0;
        else if (enable) q <= data;
    end
endmodule

module trace_complex (
    input wire clk_a, clk_b, rst_n, enable, select_b,
    input wire [7:0] data_a, data_b,
    input wire [1:0] address,
    output wire [7:0] q_a, q_b,
    output wire [0:3] ascending,
    output wire [7:0] memory_data
);
    wire [7:0] mixed = select_b ? (data_a ^ data_b) : {data_a[3:0], data_b[7:4]};
    trace_stage #(.WIDTH(8)) u_a (.clk(clk_a), .rst_n(rst_n), .enable(enable), .data(mixed), .q(q_a));
    trace_stage #(.WIDTH(8)) u_b (.clk(clk_b), .rst_n(rst_n), .enable(enable), .data({mixed[0], mixed[7:1]}), .q(q_b));
    assign ascending = {q_a[0], q_b[7], q_a[0], 1'b1};
    reg [7:0] memory [0:3];
    always @(posedge clk_a) begin
        if (enable) memory[address] <= data_a;
    end
    assign memory_data = memory[address];
endmodule
