`timescale 1ns/1ns

// 显式逐单元 dump：未列出的地址是缺失单元，不能用零或 X 替代。
module memory_dump;
    reg signed [7:0] mem [-1:1][2:4];
    reg [11:4] words [4:6];
    reg [7:0] packed_only;
    memory_child child();
    // Icarus 将原数组的二维地址展平；这些真实网线别名保留两层索引供矩阵验收。
    wire [7:0] \matrix[-1][2] = mem[-1][2];
    wire [7:0] \matrix[-1][4] = mem[-1][4];
    wire [7:0] \matrix[1][2] = mem[1][2];
    wire [7:0] \matrix[1][3] = mem[1][3];

    initial begin
        mem[-1][2] = -1;
        mem[-1][4] = 8'b10xz01zz;
        mem[1][2] = 8'h06;
        mem[1][3] = 8'h00;
        words[4] = 8'h21;
        // words[6] 保持未初始化，首次 dump 的真实值为 X。
        packed_only = 8'h42;
        $dumpfile("memory_dump.vcd");
        $dumpvars(0, mem[-1][2], mem[-1][4], mem[1][2], mem[1][3],
                  words[4], words[6], packed_only, child.mem[2], child.mem[5],
                  \matrix[-1][2] , \matrix[-1][4] , \matrix[1][2] , \matrix[1][3] );
        #5;
        mem[-1][2] = -2;
        words[4] = 8'h22;
        child.mem[2] = 4'hb;
        #5;
        mem[-1][4] = 8'h07;
        words[6] = 8'h80;
        #5;
        mem[1][2] = 8'h80;
        #5;
        $finish;
    end
endmodule

// 子作用域同名 mem 应与父作用域的二维 mem 分开。
module memory_child;
    reg [3:0] mem [2:5];
    initial begin
        mem[2] = 4'ha;
        mem[5] = 4'bzzzz;
    end
endmodule

