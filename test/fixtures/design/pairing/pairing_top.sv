// 双向对/源端口集合夹具：u_a↔u_b 双向连接；u_f 的两个不同源端口分别连 u_d/u_e，不得合并。
module pairing_top (
    input  logic i,
    output logic o
);
    logic w_ab, w_ba, w_ac, w_ad, w_ae;
    pa u_a (
        .a_in(i),
        .b_in(w_ba),
        .a_out(w_ab),
        .b_out(w_ac)
    );
    pb u_b (
        .a_in(w_ab),
        .c_in(1'b0),
        .b_out(w_ba),
        .c_out()
    );
    pc u_c (
        .a_in(w_ac),
        .y(o)
    );
    pf u_f (
        .x(i),
        .f0(w_ad),
        .f1(w_ae)
    );
    pc u_d (
        .a_in(w_ad),
        .y()
    );
    pc u_e (
        .a_in(w_ae),
        .y()
    );
endmodule
