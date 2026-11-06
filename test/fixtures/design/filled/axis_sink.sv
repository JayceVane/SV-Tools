// filled：与 skeleton 同结构，但子模块实现已补，用于验证 hierarchy+proc 能输出 JSON。
module axis_sink (
    input  logic       clk,
    input  logic [7:0] tdata,
    output logic       tready
);
    logic ready_q;
    always_ff @(posedge clk) begin
        ready_q <= tdata[0];
    end
    assign tready = ready_q;
endmodule
