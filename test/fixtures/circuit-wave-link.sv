`timescale 1ns/1ps
module link_lane(input wire [7:4] din, output wire [7:4] dout);
    assign dout = din ^ 4'hf;
endmodule

module link_chip(
    input wire [7:4] d0, d1,
    output wire [7:4] q0, q1
);
    link_lane u0(.din(d0), .dout(q0));
    link_lane u1(.din(d1), .dout(q1));
endmodule

module tb;
    reg [7:4] a = 0, b = 15;
    wire [7:4] q0, q1;
    link_chip dut(.d0(a), .d1(b), .q0(q0), .q1(q1));
    initial begin
        $dumpfile("wave.vcd");
        $dumpvars(0, tb);
        #10; a = 3; b = 5;
        #10;
        if (q0 !== 12 || q1 !== 10) $fatal(1, "link fixture mismatch");
        #10; a = 8; b = 2;
        #10; $finish;
    end
endmodule
