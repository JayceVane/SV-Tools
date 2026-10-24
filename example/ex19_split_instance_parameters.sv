module cdc_hs_bits #(
    parameter DATA_WIDTH = 8,
    parameter CDC_LEVEL  = 2
) (
    input                    i_clk_a  ,
    input                    i_rst_n_a,
    input                    i_clk_b  ,
    input                    i_rst_n_b,
    input  [DATA_WIDTH-1:0]  i_data_a ,
    input                    i_valid_a,
    output                   o_valid_b,
    output [DATA_WIDTH-1:0]  o_data_b
);

    reg                  r_valid_a;
    reg [DATA_WIDTH-1:0] r_data_a ;

    // 打一拍确保同时钟域的寄存器输出
    always @(posedge i_clk_a or negedge i_rst_n_a) begin
        if (!i_rst_n_a) begin
            r_valid_a <= 0; // Changed from o_valid_b to r_valid_a
            r_data_a  <= {DATA_WIDTH{1'b0}}; // Changed from o_data_b to r_data_a
        end
        else begin
            r_valid_a <= 1;
            r_data_a  <= i_data_a;
        end
    end

    reg                  req2b_a     ;
    reg                  ack_from_b_a;
    reg                  req_en_a    ;
    reg [DATA_WIDTH-1:0] req2b_a_data;

    // 锁存使能控制
    always @(posedge i_clk_a or negedge i_rst_n_a) begin
        if (!i_rst_n_a) begin
            req_en_a <= 1'b1;
        end
        else begin
            if(ack_from_b_a) begin
                req_en_a <= 1'b1;
            end
            else if(req2b_a) begin
                req_en_a <= 1'b0;
            end
        end
    end

    // 发送请求锁存数据
    always @(posedge i_clk_a or negedge i_rst_n_a) begin
        if (!i_rst_n_a) begin
            req2b_a      <= 0;
            req2b_a_data <= {DATA_WIDTH{1'b0}};
        end
        else begin
            req2b_a      <= ack_from_b_a;
            req2b_a_data <= req_en_a?r_data_a:req2b_a_data;
        end
    end

    // 跨时钟域请求同步

    // Signal declarations

    cdc_1bit #(          .CDC_LEVEL (CDC_LEVEL)
        ) u_cdc_req2b_a (
        .i_clk   (i_clk  ), // input   i_clk
        .i_rst_n (i_rst_n), // input   i_rst_n
        .i_bit   (i_bit  ), // input   i_bit
        .o_bit   (o_bit  )  // output  o_bit
        );

    cdc_1bit #(.CDC_LEVEL(CDC_LEVEL)) u_cdc_req2b_a (
        .i_clk  (i_clk  ), // input   i_clk
        .i_rst_n(i_rst_n), // input   i_rst_n
        .i_bit  (i_bit  ), // input   i_bit
        .o_bit  (o_bit  )  // output  o_bit
    );
endmodule
