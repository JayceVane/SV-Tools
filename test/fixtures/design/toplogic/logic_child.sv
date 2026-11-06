// A1：顶层含 assign 与 always_ff，proc 后会产生 $ 单元；架构图只保留用户模块实例。
module logic_child (
    input  logic a,
    output logic y
);
    assign y = a;
endmodule
