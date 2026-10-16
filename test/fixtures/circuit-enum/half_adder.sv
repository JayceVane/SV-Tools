module half_adder(input wire i_a, i_b, output wire o_c, o_s);
    assign o_c = i_a & i_b;
    assign o_s = i_a ^ i_b;
endmodule
