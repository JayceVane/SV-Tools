// ============================================================================
// Example 1: Module port alignment + always block + case statement
// ============================================================================

// --- Before formatting ---

module alu #(parameter W=8,localparam DW=W*2)(
input clk,rst_n,
input [W-1:0] opcode,
input [DW-1:0] operand_a,operand_b,
output reg [DW-1:0] result,
output zero,overflow);
reg zero_flag,overflow_flag;
always @(posedge clk or negedge rst_n) begin
if(!rst_n) begin result<=0;zero_flag<=0;overflow_flag<=0; end else begin
case(opcode)
4'd0:result<=operand_a+operand_b;
4'd1:result<=operand_a-operand_b;
4'd2:result<=operand_a&operand_b;
4'd3:result<=operand_a|operand_b;
default:result<=0; endcase
zero_flag<=(result==0); end end
assign zero=zero_flag; assign overflow=overflow_flag;
endmodule

// --- After formatting ---

module alu #(parameter W=8,localparam DW=W*2
) (
  input                clk, rst_n,
  input      [ W-1:0]  opcode   ,
  input      [DW-1:0]  operand_a, operand_b,
  output reg [DW-1:0]  result   ,
  output               zero, overflow
);

  reg zero_flag,overflow_flag;

  always @(posedge clk or negedge rst_n) begin
    if(!rst_n) begin result<=0;zero_flag<=0;overflow_flag<=0; end else begin
      case(opcode)
        4'd0:result<=operand_a+operand_b;
        4'd1:result<=operand_a-operand_b;
        4'd2:result<=operand_a&operand_b;
        4'd3:result<=operand_a|operand_b;
        default:result<=0; endcase
      zero_flag <= (result==0); end end

  assign zero = zero_flag; assign overflow=overflow_flag;

endmodule
