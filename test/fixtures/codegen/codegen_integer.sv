`timescale 1ns/1ps
module codegen_integer(input int d, input byte unsigned b, output longint q);
    assign q = d + b;
    initial begin
        #2;
        if ($bits(d) != 32 || $bits(b) != 8 || $bits(q) != 64 || d !== 0 || b !== 0 || q !== 0)
            $fatal(1, "builtin integer port width mismatch");
        $display("CODEGEN_PASS integer");
    end
endmodule
