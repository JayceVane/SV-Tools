// ambiguous：与 dup_a.sv 声明同名模块。
module dup_mod (
    input  logic a,
    output logic y
);
    assign y = ~a;
endmodule
