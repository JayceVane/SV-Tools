// Example SystemVerilog file for testing the formatter
module test_module #(
parameter WIDTH=8,
parameter DEPTH=16
)(
input logic clk,
input logic rst_n,
output logic [WIDTH-1:0] data_out
);
logic [WIDTH-1:0] data_in;
logic valid;
logic ready;

always_ff @(posedge clk or negedge rst_n) begin
if(!rst_n) begin
data_out <= '0;
end
else begin
if(valid && ready) begin
data_out <= data_in;
end
end
end

endmodule
