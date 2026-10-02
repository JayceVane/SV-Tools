// ============================================================================
// ex12: property/sequence 体内多余空格归一化（spec §9.5）
// ============================================================================

module m (
    input logic        clk, rst_n, valid,
    input logic [7:0]  wdata
);

    property p_stable;
        @(posedge clk) $rose(valid) |=> wdata == $past(wdata);
    endproperty

    property p_reset;
        @(posedge clk) disable iff (!rst_n) $fell(valid) |-> !valid;
    endproperty

    sequence s_handshake;
        valid ##1 ready;
    endsequence

    a_stable: assert property (p_stable)
        else $error("wdata not stable, got %0h", wdata);

endmodule
