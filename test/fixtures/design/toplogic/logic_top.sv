// A1：顶层自身的组合/时序逻辑产生 $and/$xor/$dff，不得进入架构节点。
module logic_top (
    input  logic clk,
    input  logic a,
    input  logic b,
    output logic y,
    output logic q
);
    logic s;
    always_ff @(posedge clk) begin
        q <= a & b;
    end
    assign s = a ^ b;
    assign y = s;
    logic_child u_child (
        .a(a),
        .y(y)
    );
endmodule
