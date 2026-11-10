`timescale 1ns/1ps
// FST/VCD alias fixture: Icarus Verilog; q and dut.q share one net.
module child(input wire q); endmodule
module tb;
    reg q = 0;
    reg other = 0;
    child dut(.q(q));
    initial begin
        $dumpfile("aliases.fst");
        $dumpvars(0, tb);
        #5 q = 1; other = 1;
        #5 q = 0; other = 0;
        #5 $finish;
    end
endmodule
