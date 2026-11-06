// 带前缀的未连接 inout 夹具：gpio_io 不应因前缀分组产生空接口或崩溃。
module gpio_empty (
    inout wire gpio_io
);
endmodule
