module full_adder #(
    parameter corelib_pkg::impl_t IMPL = corelib_pkg::STRUCTURAL
) (
    input wire i_a, i_b, i_c,
    output wire o_c, o_s
);
    generate
        if (IMPL == corelib_pkg::STRUCTURAL) begin : structural
            wire w_u1_c, w_u2_c, w_u1_s, w_u2_s;
            half_adder u1_half_adder (.i_a(i_a), .i_b(i_b), .o_c(w_u1_c), .o_s(w_u1_s));
            half_adder u2_half_adder (.i_a(i_c), .i_b(w_u1_s), .o_c(w_u2_c), .o_s(w_u2_s));
            assign o_s = w_u2_s;
            assign o_c = w_u1_c | w_u2_c;
        end
        else if (IMPL == corelib_pkg::FLAT) begin : flat
            assign o_s = i_a ^ i_b ^ i_c;
            assign o_c = (i_a & i_b) | (i_b & i_c) | (i_c & i_a);
        end
    endgenerate
endmodule
