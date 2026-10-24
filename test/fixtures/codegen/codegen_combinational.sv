`timescale 1ns/1ps
module codegen_combinational(input [7:0] d, output [7:0] q, inout pad);
    assign q = ~d;
    assign pad = 1'bz;
    initial begin
        #2;
        if (d !== 0 || q !== 8'hff || pad !== 1'bz)
            $fatal(1, "combinational/inout skeleton mismatch");
        $display("CODEGEN_PASS combinational");
    end
endmodule
