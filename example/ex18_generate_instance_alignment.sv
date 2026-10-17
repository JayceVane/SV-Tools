// 多个 generate 过程结束后，后续实例应恢复端口对齐；注释中的括号不参与布局。
module generate_instance_alignment (
input logic clk,
input logic enable,
input logic [7:0] data_i,
output wire [7:0] data_o
);
logic [7:0] data_q;
logic [7:0] sampled_q;
logic pending;
wire [7:0] delayed_data;

generate
always @(posedge clk) begin
data_q<=data_i;
end
assign delayed_data=data_q;
always @(posedge clk) begin
sampled_q<=delayed_data;
if (!pending && enable) pending <= 1'b1;
else if (pending) pending <= 1'b0;
if (pending) sampled_q <= sampled_q + 1'b1;
end
endgenerate

// Data interface
child #(.WIDTH(8)) u_child (
.short_in(sampled_q),
.long_output_port( data_o ),
// Clock interface
.drp_clk_in ( clk ), // (clk),
// .unused_port (ignored),
.valid(pending)
);
endmodule
