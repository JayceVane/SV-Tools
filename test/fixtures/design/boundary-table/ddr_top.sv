module ddr_pins (
    input clk, input rst_n,
    output [13:0] ddr_addr, output [2:0] ddr_ba,
    output ddr_cas_n, inout [15:0] ddr_dq,
    output ddr_ras_n, output ddr_we_n, output irq
);
endmodule

module ddr_top (
    input clk, input rst_n,
    output [13:0] ddr_addr, output [2:0] ddr_ba,
    output ddr_cas_n, inout [15:0] ddr_dq,
    output ddr_ras_n, output ddr_we_n, output irq
);
    ddr_pins u_ddr (
        .clk(clk), .rst_n(rst_n), .ddr_addr(ddr_addr), .ddr_ba(ddr_ba),
        .ddr_cas_n(ddr_cas_n), .ddr_dq(ddr_dq), .ddr_ras_n(ddr_ras_n), .ddr_we_n(ddr_we_n), .irq(irq)
    );
endmodule
