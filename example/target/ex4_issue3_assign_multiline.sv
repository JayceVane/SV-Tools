// ============================================================================
// Example 4: assign statement broken across lines (issue #3 regression)
// ============================================================================

module issue3_repro (
    input  wire  clk,
    output reg   q
);

    assign ATN_out = (                                                        //破行，格式化后这里有个空行，能解决吗？
        c_state_1 == ST_CACS ||
        c_state_1 == ST_CPWS ||
        c_state_1 == ST_CPPS ||
        c_state_1 == ST_CSWS ||
        c_state_1 == ST_CAWS ||
        c_state_1 == ST_CTRS);

    assign no_paren = a ||
        b ||
        c;

    assign with_comment = ( // trailing comment
        x &&
        y);

endmodule
