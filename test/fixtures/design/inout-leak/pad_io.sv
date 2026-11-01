// A1 泄漏夹具：用户 pad 实例与顶层 $dff 都连接到 inout io，接口端点只能出现用户实例。
module pad_io (
    inout wire io
);
endmodule
