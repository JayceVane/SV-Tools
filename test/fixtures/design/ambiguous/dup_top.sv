// ambiguous：顶层例化同名歧义模块。
module dup_top (
    input  logic a,
    output logic y
);
    dup_mod u_dup (
        .a(a),
        .y(y)
    );
endmodule
