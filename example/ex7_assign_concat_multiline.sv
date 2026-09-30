// ============================================================================
// Example 7: assign 多行拼接 `{`（issue #3 花括号变体：破行空行 + 空行自愈）
// ============================================================================

module concat_repro (
    input  wire [63:0] din,
    input  wire        sel,
    input  wire [7:0]  a,
    input  wire [7:0]  b,
    output wire [63:0] dout,
    output wire [63:0] rev,
    output wire [7:0]  mux
);

    assign dout = {

        din[63],
        din[62],
        din[61:0]
    };

    assign rev = {
        din[0],
        din[1],
        din[2]};

    assign wide = {2{din[63:56]}};
    assign mux  = sel ? a : b;

endmodule
