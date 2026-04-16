const svtools = require('./svtools.win32-x64-msvc.node');

// Test 1: Direct alignCode (which calls align_decl)
const input = `        (* mark_debug = true *) reg [31:0] dbg_rfu_wreg0   ;
        (* mark_debug = true *) reg [31:0] dbg_rfu_wreg1   ;
        (* mark_debug = true *) reg [31:0] dbg_rfu_wreg2   ;
        (* mark_debug = true *) reg [31:0] dbg_rfu_wreg3   ;
        (* mark_debug = true *) reg [31:0] dbg_rfu_wreg4   ;
        (* mark_debug = true *) reg [31:0] dbg_rfu_wreg5   ;
        (* mark_debug = true *) reg [31:0] dbg_rfu_wreg6   ;
        (* mark_debug = true *) reg [31:0] dbg_rfu_wreg7   ;
        (* mark_debug = true *) reg [31:0] dbg_rfu_wreg8   ;
        (* mark_debug = true *) reg [31:0]   dbg_rfu_wreg9   ;
        (* mark_debug = true *) reg        dbg_tx_done_reg ;
        (* mark_debug = true *) reg           dbg_rx_done_reg ;
        (* mark_debug = true *) reg [31:0] dbg_sfp_status  ;
        (* mark_debug = true *) reg [31:0] dbg_tx_start    ;
        (* mark_debug = true *) reg [31:0] dbg_rx_start    ;`;

// Test with formatText (full beautifier)
console.log("=== formatText ===");
const result = svtools.formatText(input, {
    useTab: false,
    nbSpace: 4,
    alignComma: true,
    oneDeclPerLine: false,
    ignoreTick: false,
    reindentOnly: false,
    instAlignPort: true,
});
console.log(result);
console.log("---");

// Also test plain declarations (no attribute) to see if those work
const plain = `        reg [31:0] dbg_rfu_wreg0   ;
        reg [31:0] dbg_rfu_wreg1   ;
        reg [31:0] dbg_rfu_wreg2   ;
        reg        dbg_tx_done_reg ;
        reg           dbg_rx_done_reg ;`;
console.log("=== Plain declarations ===");
const result2 = svtools.formatText(plain, {
    useTab: false,
    nbSpace: 4,
    alignComma: true,
    oneDeclPerLine: false,
    ignoreTick: false,
    reindentOnly: false,
    instAlignPort: true,
});
console.log(result2);
