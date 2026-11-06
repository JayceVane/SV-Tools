// 结构判空边界夹具：纯 alias、常量 assign 均不是空模块；只有无逻辑的空模块才是 blackbox。
module alias_mod (
    input  logic a,
    output logic y
);
    assign y = a;
endmodule

module const_mod (
    output logic y
);
    assign y = 1'b0;
endmodule

module empty_mod (
    input  logic a,
    output logic y
);
endmodule

module alias_empty_top (
    input  logic a,
    output logic y_alias,
    output logic y_const,
    output logic y_empty
);
    alias_mod u_alias (
        .a(a),
        .y(y_alias)
    );
    const_mod u_const (
        .y(y_const)
    );
    empty_mod u_empty (
        .a(a),
        .y(y_empty)
    );
endmodule
