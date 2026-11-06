`timescale 1ns/1ps
module leaf(input wire data); endmodule
module child(input wire data); leaf u_leaf(.data(data)); endmodule
module empty; endmodule
module tb; reg q=0; child dut(.data(q)); child \u.dot (.data(q)); empty u_empty();
initial begin $dumpfile("hierarchy.fst"); $dumpvars(0,tb); #5 q=1; #5 q=0; #5 $finish; end endmodule
