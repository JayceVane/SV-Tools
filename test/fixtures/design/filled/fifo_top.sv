// filled：与 skeleton 相同的顶层结构。
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
