// 边界前缀冲突夹具：gpio 与 gpio_a 必须保持为两个独立边界束。
module collision_top (
    inout wire gpio,
    inout wire gpio_a
);
    pad_a u_a (
        .io(gpio)
    );
    pad_b u_b (
        .io(gpio_a)
    );
endmodule
