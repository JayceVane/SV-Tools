// ============================================================================
// ex13: 单行对齐逻辑——单行语句紧凑（spec §7.1，行内紧凑开关）
// ============================================================================

module tb (input logic clk, rst_n, valid, ready, input logic [7:0] data);

    // 单行例化：保持单行 + 紧凑
    bus_if #(.DW(8  )) u_if (.clk(clk  ),  .rst_n(rst_n));

    always @(posedge clk) begin
        if (valid && !ready)
            else    $error("valid without ready, %0t",        $time);
        else    $display("ok %0d",   data  );
        cnt <=   cnt  +   1;
    end

    task   automatic   check();
        if   (cnt   ==   0)   $display("empty");
    endtask

endmodule
