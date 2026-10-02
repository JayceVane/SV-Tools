// ============================================================================
// ex16: `pragma protect 加密区原样透传（spec §9.10）
// BASE64 载荷行长是编码规范的一部分，任何重排都会破坏解密；
// 同时锁定透传消除的二次方慢化（万行加密 IP 曾需数十分钟）
// ============================================================================

module keep_me (
    input  wire [7:0]  a,
    output wire [7:0]  y
);
    assign y = a;
endmodule

`pragma protect begin_protected
`pragma protect version = 1
`pragma protect encoding = (enctype = "BASE64", line_length = 76, bytes = 128)
`pragma protect data_block
ABcd+/12==  zzQQ   载荷行内空格必须逐字节保留
`pragma protect end_protected

module after_region (
    input wire  b
);
endmodule
