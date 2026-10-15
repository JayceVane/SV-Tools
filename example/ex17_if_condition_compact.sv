module if_condition_demo #(parameter int WIDTH=8);
int err_cnt=0;
task automatic check(input logic [WIDTH-1:0] req, input logic [WIDTH-1:0] grant);
int i = 0;
for(i = 0; i < WIDTH; i = i + 1) begin
if (req[i]) break;
end
if (grant != ({{(WIDTH-1){1'b0}}  ,   1'b1}    << i)) begin
err_cnt = err_cnt + 1;
$error("Test failed at req = %b, grant = %b expected %b", req, grant, ({{(WIDTH-1){1'b0}},1'b1} << i));
end
endtask
endmodule
