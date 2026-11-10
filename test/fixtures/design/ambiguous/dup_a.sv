// ambiguous：与 dup_b.sv 声明同名模块，用于验证 AMBIGUOUS_MODULE 候选。
module dup_mod (
    input  logic a,
    output logic y
);
    assign y = a;
endmodule
