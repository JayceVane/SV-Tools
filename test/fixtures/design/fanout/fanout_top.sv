// task-15：同一时钟源的 clk_sys/rst_sys_n 扇出到 3 个实例，应合并为一条扇出接口。
module fanout_top (
    input  logic clk_in,
    input  logic rst_n_in
);
    logic clk_sys, rst_sys_n;
    logic alpha, beta;
    clkgen u_clk (
        .clk_in(clk_in),
        .rst_n_in(rst_n_in),
        .clk_sys(clk_sys),
        .rst_sys_n(rst_sys_n)
    );
    child_a u_a (
        .clk(clk_sys),
        .rst_n(rst_sys_n),
        .alpha(alpha),
        .beta(beta)
    );
    child_b u_b (
        .clk(clk_sys),
        .rst_n(rst_sys_n)
    );
    child_c u_c (
        .clk(clk_sys),
        .rst_n(rst_sys_n)
    );
    child_sink u_sink (
        .alpha(alpha),
        .beta(beta)
    );
endmodule
