// 布局门禁夹具：9 个实例、时钟扇出与多接口，用于固定 aspectRatio 1.4–1.6 与节点不重叠断言。
module layout_top (
    input  logic clk,
    input  logic din,
    output logic dout
);
    logic clk_sys;
    logic w_src0;
    logic w_src1;
    logic w_src2;
    logic w_src3;
    logic w_mid0_0, w_mid0_1, w_mid0_2, w_mid0_3;
    logic w_mid1_0, w_mid1_1, w_mid1_2, w_mid1_3;
    logic w_mid2_0, w_mid2_1, w_mid2_2, w_mid2_3;
    logic w_mid3_0, w_mid3_1, w_mid3_2, w_mid3_3;
    logic w_mid4_0, w_mid4_1, w_mid4_2, w_mid4_3;
    logic w_mid5_0, w_mid5_1, w_mid5_2, w_mid5_3;
    logic w_out0, w_out1, w_out2, w_out3;

    assign clk_sys = clk;
    leaf u_src (
        .clk(clk_sys),
        .in0(din),
        .in1(),
        .in2(),
        .in3(),
        .in4(),
        .in5(),
        .out0(w_src0),
        .out1(w_src1),
        .out2(w_src2),
        .out3(w_src3)
    );
    leaf u_mid0 (
        .clk(clk_sys),
        .in0(w_src0),
        .in1(w_src1),
        .in2(w_src2),
        .in3(w_src3),
        .in4(w_src0),
        .in5(w_src1),
        .out0(w_mid0_0),
        .out1(w_mid0_1),
        .out2(w_mid0_2),
        .out3(w_mid0_3)
    );
    leaf u_mid1 (
        .clk(clk_sys),
        .in0(w_src0),
        .in1(w_src1),
        .in2(w_src2),
        .in3(w_src3),
        .in4(w_src0),
        .in5(w_src1),
        .out0(w_mid1_0),
        .out1(w_mid1_1),
        .out2(w_mid1_2),
        .out3(w_mid1_3)
    );
    leaf u_mid2 (
        .clk(clk_sys),
        .in0(w_src0),
        .in1(w_src1),
        .in2(w_src2),
        .in3(w_src3),
        .in4(w_src0),
        .in5(w_src1),
        .out0(w_mid2_0),
        .out1(w_mid2_1),
        .out2(w_mid2_2),
        .out3(w_mid2_3)
    );
    leaf u_mid3 (
        .clk(clk_sys),
        .in0(w_src0),
        .in1(w_src1),
        .in2(w_src2),
        .in3(w_src3),
        .in4(w_src0),
        .in5(w_src1),
        .out0(w_mid3_0),
        .out1(w_mid3_1),
        .out2(w_mid3_2),
        .out3(w_mid3_3)
    );
    leaf u_mid4 (
        .clk(clk_sys),
        .in0(w_src0),
        .in1(w_src1),
        .in2(w_src2),
        .in3(w_src3),
        .in4(w_src0),
        .in5(w_src1),
        .out0(w_mid4_0),
        .out1(w_mid4_1),
        .out2(w_mid4_2),
        .out3(w_mid4_3)
    );
    leaf u_mid5 (
        .clk(clk_sys),
        .in0(w_src0),
        .in1(w_src1),
        .in2(w_src2),
        .in3(w_src3),
        .in4(w_src0),
        .in5(w_src1),
        .out0(w_mid5_0),
        .out1(w_mid5_1),
        .out2(w_mid5_2),
        .out3(w_mid5_3)
    );
    leaf u_sink (
        .clk(clk_sys),
        .in0(w_mid0_0),
        .in1(w_mid1_0),
        .in2(w_mid2_0),
        .in3(w_mid3_0),
        .in4(w_mid4_0),
        .in5(w_mid5_0),
        .out0(w_out0),
        .out1(w_out1),
        .out2(w_out2),
        .out3(w_out3)
    );
    leaf u_out (
        .clk(clk_sys),
        .in0(w_out0),
        .in1(w_out1),
        .in2(w_out2),
        .in3(w_out3),
        .in4(),
        .in5(),
        .out0(),
        .out1(),
        .out2(),
        .out3()
    );
    assign dout = w_out0;
endmodule
