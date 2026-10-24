`timescale 1ns/1ps
module codegen_multiclock(
    input launch, input reset_main, input capture, input rst_n_b,
    input d, output logic qa, output logic qb
);
    integer count_a = 0;
    integer count_b = 0;
    always_ff @(negedge launch or posedge reset_main)
        if (reset_main) qa <= 0;
        else begin qa <= d; count_a <= count_a + 1; end
    always @(posedge capture or negedge rst_n_b)
        if (!rst_n_b) qb <= 0;
        else begin qb <= d; count_b <= count_b + 1; end
    initial begin
        #1;
        if (reset_main !== 1 || rst_n_b !== 0)
            $fatal(1, "reset assertion polarity mismatch");
        #14;
        if (reset_main !== 0 || rst_n_b !== 1 || qa !== 0 || qb !== 0 || count_a < 3 || count_b < 3)
            $fatal(1, "one or more clock/reset domains were not driven");
        $display("CODEGEN_PASS multiclock");
    end
endmodule
