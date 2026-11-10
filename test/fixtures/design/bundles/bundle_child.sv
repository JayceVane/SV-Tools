// 端口折叠门禁夹具：blackbox 子模块，含 m_axi_* + m_valid、s0_* 与单字母 s_* 端口。
module bundle_child (
    input  logic        clk,
    input  logic [31:0] m_axi_araddr,
    output logic [63:0] m_axi_rdata,
    input  logic        m_valid,
    input  logic [31:0] s0_awaddr,
    output logic [31:0] s0_rdata,
    input  logic [31:0] s_awaddr,
    output logic [31:0] s_wdata
);
endmodule
