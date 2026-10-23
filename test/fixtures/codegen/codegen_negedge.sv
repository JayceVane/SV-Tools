`timescale 1ns/1ps
module codegen_negedge(input trigger_clk, input d, output logic q);
    always_ff @(negedge trigger_clk) q <= d;
    initial begin
        #2;
        if (d !== 0 || q !== 0) $fatal(1, "negative-edge clock was not driven");
        $display("CODEGEN_PASS negedge");
    end
endmodule
