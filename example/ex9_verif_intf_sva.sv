// ============================================================================
// VF2: interface + clocking + modport + property/sequence/assert
// ============================================================================

interface bus_if #(parameter DW = 32) (input logic clk, input logic rst_n);

    logic [DW-1:0] wdata;
    logic valid;
    logic ready;
    logic [1:0] resp;

    clocking drv_cb @(posedge clk);
        default input #1step output #2;
        output wdata, valid;
        input ready, resp;
    endclocking

    modport drv (clocking drv_cb, input rst_n);
    modport mon (input clk, rst_n, wdata, valid, ready, resp);

endinterface

module assertions (
    input logic clk,
    input logic rst_n,
    input logic valid,
    input logic ready
);

    sequence s_handshake;
        valid ##1 ready;
    endsequence

    property p_valid_ready;
        @(posedge clk) disable iff (!rst_n) valid |-> ##[1:3] ready;
    endproperty

    a_valid_ready: assert property (p_valid_ready)
        else $error("valid without ready, %0t", $time);

    property p_stable;
        @(posedge clk) $rose(valid) |=> wdata == $past(wdata);
    endproperty

    always_comb begin
        assert (valid || ready)
            else $warning("both low");
    end

endmodule
