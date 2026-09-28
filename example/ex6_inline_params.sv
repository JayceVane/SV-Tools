// ============================================================================
// Example 6: interface with multiple parameters on one line (ex2 regression)
// ============================================================================

interface axi_if #(parameter DATA_W=32,
parameter ADDR_W=32,parameter ID_W=4
) ();

    logic[ID_W-1:0] awid;logic[ADDR_W-1:0] awaddr;
    logic[7:0] awlen;logic[2:0] awsize;logic awvalid; logic awready;

    modport master(output awid,awaddr,awlen,awsize,awvalid,input awready);
endinterface

module consumer (
    axi_if.master axi
);

    logic [DATA_W-1:0] captured;
    assign captured = axi.awaddr;

endmodule
