// unused-instance：axis_sink 的 tready 未连接，架构图仍应保留 u_sink。
module fifo_top (
    input  logic       clk,
    input  logic [7:0] din,
    output logic [7:0] dout
);
    wire [7:0] buf_out;
    fifo_buf u_buf (
        .clk(clk),
        .din(din),
        .dout(buf_out)
    );
    axis_sink u_sink (
        .clk(clk),
        .tdata(buf_out)
    );
    assign dout = buf_out;
endmodule
