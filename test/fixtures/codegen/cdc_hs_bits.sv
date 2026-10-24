// 多时钟域例化回归：保留用户报告的完整端口表和两个域的事件控制。
module cdc_hs_bits #(
    parameter DATA_WIDTH = 8,
    parameter CDC_LEVEL = 2
) (
    input i_clk_a,
    input i_rst_n_a,
    input i_clk_b,
    input i_rst_n_b,
    input [DATA_WIDTH-1:0] i_data_a,
    input i_valid_a,
    output reg o_valid_b,
    output reg [DATA_WIDTH-1:0] o_data_b
);
    reg [DATA_WIDTH-1:0] r_data_a;
    always @(posedge i_clk_a or negedge i_rst_n_a) begin
        if (!i_rst_n_a) r_data_a <= {DATA_WIDTH{1'b0}};
        else r_data_a <= i_data_a;
    end
    always @(posedge i_clk_b or negedge i_rst_n_b) begin
        if (!i_rst_n_b) begin
            o_data_b <= {DATA_WIDTH{1'b0}};
            o_valid_b <= 1'b0;
        end
        else begin
            o_data_b <= r_data_a;
            o_valid_b <= i_valid_a;
        end
    end
endmodule
