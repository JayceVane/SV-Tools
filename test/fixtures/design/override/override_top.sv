// A2：顶层以 #(.WIDTH(16)) 覆盖声明默认值；盒端口位宽取实例连接 bits。
module override_top (
    input  logic        clk,
    input  logic [15:0] din,
    output logic [15:0] dout
);
    child #(.WIDTH(16)) u_child (
        .clk(clk),
        .din(din),
        .dout(dout)
    );
endmodule
