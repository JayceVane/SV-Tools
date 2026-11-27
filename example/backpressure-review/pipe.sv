`timescale 1ns/1ps
module pipe (
    input wire clk, reset_n,
    input wire in_valid,
    input wire [7:0] in_data,
    output wire in_ready,
    output reg out_valid,
    output reg [7:0] out_data,
    input wire out_ready
);
    assign in_ready = !out_valid;

    always @(posedge clk) begin
        if (!reset_n) begin
            out_valid <= 0;
            out_data <= 0;
        end else if (in_valid && in_ready) begin
            out_valid <= 1;
            out_data <= in_data;
        end else if (out_valid && out_ready) begin
            out_valid <= 0;
        end
    end
endmodule

module review_pipe (
    input wire clk, reset_n,
    input wire in_valid,
    input wire [7:0] in_data,
    output wire in_ready, out_valid,
    output wire [7:0] out_data,
    input wire out_ready
);
    pipe u_pipe (.*);
endmodule
