// unresolved：例化了工作区未声明的 ghost_mod，架构图应记 unresolved 且不伪造端口。
module ghost_top (
    input  logic a,
    output logic y
);
    ghost_mod u_ghost (
        .a(a),
        .y(y)
    );
endmodule
