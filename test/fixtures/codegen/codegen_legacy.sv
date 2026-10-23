`timescale 1ns/1ps
module codegen_legacy(clk, rst_n, d, q);
    parameter WIDTH = 4;
    input clk, rst_n;
    input [WIDTH-1:0] d;
    output reg [WIDTH-1:0] q;
    // 子程序形参同名时，不能覆盖模块接口位宽。
    task sample;
        input [1:0] d;
    endtask
    function logic inspect;
        input [2:0] q;
        inspect = ^q;
    endfunction
    always @(posedge clk or negedge rst_n)
        if (!rst_n) q <= 0;
        else q <= d;
    initial begin
        #15;
        if (rst_n !== 1 || d !== 0 || q !== 0)
            $fatal(1, "non-ANSI skeleton mismatch");
        $display("CODEGEN_PASS legacy");
    end
endmodule
