// 端口折叠门禁夹具：顶层边界与 blackbox 实例，覆盖 m_axi/m_valid、s0_*、s_* 三组前缀。
module bundle_top (
    input  logic        clk,
    input  logic [31:0] m_axi_araddr,
    output logic [63:0] m_axi_rdata,
    input  logic        m_valid,
    input  logic [31:0] s0_awaddr,
    output logic [31:0] s0_rdata,
    input  logic [31:0] s_awaddr,
    output logic [31:0] s_wdata
);
    bundle_child u_c (
        .clk(clk),
        .m_axi_araddr(m_axi_araddr),
        .m_axi_rdata(m_axi_rdata),
        .m_valid(m_valid),
        .s0_awaddr(s0_awaddr),
        .s0_rdata(s0_rdata),
        .s_awaddr(s_awaddr),
        .s_wdata(s_wdata)
    );
endmodule
