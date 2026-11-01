// skeleton：顶层例化两个空模块；架构图节点=实例，边=经 netnames 的端口连接。
module fifo_top (
    input  logic       clk,
    input  logic [7:0] din,
    output logic [7:0] dout,
    output logic       ready
);
    wire [7:0] buf_out;
    fifo_buf u_buf (
        .clk(clk),
        .din(din),
        .dout(buf_out)
    );
    axis_sink u_sink (
        .clk(clk),
        .tdata(buf_out),
        .tready(ready)
    );
    assign dout = buf_out;
endmodule
