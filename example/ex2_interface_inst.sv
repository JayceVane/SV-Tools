// ============================================================================
// Example 2: Interface + module instantiation port alignment
// ============================================================================

// --- Before formatting ---

interface axi_if #(parameter DATA_W=32,
parameter ADDR_W=32,parameter ID_W=4
) ();

    logic[ID_W-1:0] awid;logic[ADDR_W-1:0] awaddr;
    logic[7:0] awlen;logic[2:0] awsize;logic awvalid; logic awready;

    modport master(output awid,awaddr,awlen,awsize,awvalid,input awready);
endinterface

module top #(parameter W=16
) (
    input            clk, rst_n,
    input  [31:0]    arbase ,
    output [63:0]    tx_data
);

    axi_if #(.DATA_W(64), .ADDR_W(32), .ID_W(4)) axi_bus ();

    simple_module #(.W(W)) u_inst (
        .clk     (clk         ),
        .rst_n   (rst_n       ),
        .data_in (arbase[15:0]),
        .data_out(            )
    );

endmodule

// --- After formatting ---

interface axi_if #(parameter DATA_W=32,parameter ADDR_W=32,parameter ID_W=4
) ();

    logic[ID_W-1:0] awid;logic[ADDR_W-1:0] awaddr;
    logic[7:0] awlen;logic[2:0] awsize;logic awvalid; logic awready;

    modport master (
        output awid,awaddr,awlen,awsize,awvalid,input awready
    );

endinterface

module top #(parameter W=16
) (
    input            clk, rst_n,
    input  [31:0]    arbase ,
    output [63:0]    tx_data
);

    axi_if #(.DATA_W(64), .ADDR_W(32), .ID_W(4)) axi_bus ();

    simple_module #(.W(W)) u_inst (
        .clk     (clk         ),
        .rst_n   (rst_n       ),
        .data_in (arbase[15:0]),
        .data_out(            )
    );

endmodule
