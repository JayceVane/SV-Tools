`include "width.vh"

module circuit_lane #(parameter WIDTH = `CIRCUIT_WIDTH) (
    input logic [WIDTH-1:0] a, b,
    input logic select_b,
    output logic [WIDTH-1:0] y
);
    assign y = select_b ? b : a;
endmodule

module circuit_demo (
    input logic clk, rst_n, select_b, write_enable,
    input logic [7:0] a, b,
    input logic [1:0] address,
    input logic [2:5] ascending,
    output logic [7:0] q, memory_data,
    output logic [10:13] mirror
);
    logic [7:0] selected;
    logic [7:0] memory [0:3];
    circuit_lane #(.WIDTH(8)) u_lane (.a(a), .b(b), .select_b(select_b), .y(selected));
    always_ff @(posedge clk or negedge rst_n)
        if (!rst_n) q <= 8'd0;
        else q <= selected + `CIRCUIT_STEP;
    always_ff @(posedge clk)
        if (write_enable) memory[address] <= q;
    assign memory_data = memory[address];
    assign mirror = ascending;
endmodule
