`timescale 1ns/1ps
module codegen_nested #(
    parameter integer W = $clog2(16), DEPTH = 4,
    parameter [15:0] PAIR = {8'hA5, 8'h3C},
    parameter LABEL = "a,b)",
    parameter URL = "https://example.invalid/a;  b)"
) (input [W-1:0] d, output [W-1:0] q);
    localparam LAST = W-1;
    assign q = d;
    initial begin
        #2;
        if (q !== 0 || PAIR !== 16'hA53C || LABEL != "a,b)" || URL != "https://example.invalid/a;  b)" || DEPTH != 4 || LAST != 3)
            $fatal(1, "nested parameter/port skeleton mismatch");
        $display("CODEGEN_PASS nested");
    end
endmodule
