// packed struct 空模块分类夹具：空模块应判 skeleton，含 assign/always_ff 的应判 collapsed。
typedef struct packed {
    logic [7:0] data;
    logic       valid;
} bus_t;

// 只有 struct 端口、无 cells/processes/memories。
module leaf_empty (
    input  bus_t s_bus,
    output logic q
);
endmodule

// 连续赋值表达式会产生 $and 单元。
module leaf_assign (
    input  bus_t s_bus,
    output logic q
);
    assign q = s_bus.valid & s_bus.data[0];
endmodule

// always_ff 会产生 $dff 单元。
module leaf_ff (
    input  bus_t s_bus,
    input  logic clk,
    output logic q
);
    always_ff @(posedge clk) begin
        q <= s_bus.valid;
    end
endmodule

module struct_empty_top (
    input  bus_t s_bus,
    input  logic clk,
    output logic q_empty,
    output logic q_assign,
    output logic q_ff
);
    leaf_empty u_empty (
        .s_bus(s_bus),
        .q(q_empty)
    );
    leaf_assign u_assign (
        .s_bus(s_bus),
        .q(q_assign)
    );
    leaf_ff u_ff (
        .s_bus(s_bus),
        .clk(clk),
        .q(q_ff)
    );
endmodule
