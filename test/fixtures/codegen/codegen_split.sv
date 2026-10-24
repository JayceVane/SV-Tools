`timescale 1ns/1ps
module codegen_split(d, q, r, qreg);
    input [7:0] d;
    output [7:0] q, r, qreg;
    wire signed [7:0] q, r;
    reg signed [7:0] qreg;
    assign q = d + 8'hA5;
    assign r = d ^ 8'h3C;
    always @* qreg = d ^ 8'h81;
    task sample;
        reg [2:0] q;
    endtask
    initial begin : local_scope
        reg [1:0] q;
        q = 0;
    end
    initial begin
        #2;
        if ($bits(tb_codegen_split.q) != 8 || $bits(tb_codegen_split.r) != 8 || $bits(tb_codegen_split.qreg) != 8
            || tb_codegen_split.q !== 8'hA5 || tb_codegen_split.r !== 8'h3C || tb_codegen_split.qreg !== 8'h81 || tb_codegen_split.q >= 0 || tb_codegen_split.qreg >= 0)
            $fatal(1, "split declaration width/sign or scope mismatch");
        $display("CODEGEN_PASS split");
    end
endmodule
