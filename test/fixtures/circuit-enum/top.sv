module top(input wire [2:0] data, output wire [1:0] structural, flat);
    full_adder #(.IMPL(corelib_pkg::STRUCTURAL)) u_structural (
        .i_a(data[0]), .i_b(data[1]), .i_c(data[2]), .o_c(structural[1]), .o_s(structural[0])
    );
    full_adder #(.IMPL(corelib_pkg::FLAT)) u_flat (
        .i_a(data[0]), .i_b(data[1]), .i_c(data[2]), .o_c(flat[1]), .o_s(flat[0])
    );
endmodule
