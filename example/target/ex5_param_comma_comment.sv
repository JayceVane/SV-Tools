// ============================================================================
// Example 5: module parameters with value expression + trailing comma +
//            line comment (aurora core generation style)
// ============================================================================

module aurora_core #(
    parameter DATA_WIDTH = 16           , // DATA bus width
    parameter STRB_WIDTH = 2            , // STROBE bus width
    parameter BC         = DATA_WIDTH>>3, //Byte count
    parameter ISUFC      = 0            , //If UFC send 1
    parameter REM_WIDTH  = 1              // REM bus width
) (
    // AXI4-S input signals
    input  wire                   AXI4_S_IP_TX_TVALID,
    output wire                   AXI4_S_IP_TX_TREADY,
    input  wire [DATA_WIDTH-1:0]  AXI4_S_IP_TX_TDATA ,
    input  wire [STRB_WIDTH-1:0]  AXI4_S_IP_TX_TKEEP ,
    input  wire                   DCM_NOT_LOCKED_IN  ,
    input  wire                   USER_CLK_OUT       ,
    input  wire                   SYNC_RESET_IN
);

    wire [DATA_WIDTH-1:0] mcd_data ;
    wire                  mcd_valid;

endmodule
