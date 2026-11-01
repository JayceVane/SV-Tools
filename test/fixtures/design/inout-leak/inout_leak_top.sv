// A1 泄漏夹具：顶层 inout + always_ff/assign 产生 $dff 等内部单元。
module inout_leak_top (
    input  logic clk,
    inout  wire  io,
    output logic q
);
    logic s;
    always_ff @(posedge clk) begin
        q <= io;
    end
    assign s = io;
    pad_io u_pad (
        .io(io)
    );
endmodule
