// ============================================================================
// ex14: 连续单行例化——各自保持单行、不粘连、不误展开（spec §7.2）
// ============================================================================

module carry_sel_adder (
    input  wire [7:0]    a, b,
    input  wire          cin ,
    output wire [7:0]    sum ,
    output wire          cout
);

    wire [3:0] a0, b0, sum0, a1, b1, sum1;
    wire       cin0, cout0, cin1, cout1  ;

    buf_unit_add #(.W(4))u_buf0(.cin(cin0), .a(a0), .b(b0), .sum(sum0), .cout(cout0));
    buf_unit_add #(.W(4))u_buf1(.cin(cin1), .a(a1), .b(b1), .sum(sum1), .cout(cout1));
    buf_unit_add #(.W(4))u_buf2(.cin(cin2), .a(a2), .b(b2), .sum(sum2), .cout(cout2));
    assign cin0 = cin;

endmodule
