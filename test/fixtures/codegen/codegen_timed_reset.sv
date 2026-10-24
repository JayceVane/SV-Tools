`timescale 1ns/1ps
module codegen_timed_reset(input sreset_n, input d, output q);
    assign q = sreset_n ? d : 1'b0;
    initial begin
        #1;
        if (sreset_n !== 0) $fatal(1, "clockless reset was not asserted");
        #11;
        if (sreset_n !== 1 || d !== 0 || q !== 0)
            $fatal(1, "clockless reset was not released");
        $display("CODEGEN_PASS timed_reset");
    end
endmodule
