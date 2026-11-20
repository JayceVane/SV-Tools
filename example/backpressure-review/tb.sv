`timescale 1ns/1ps
module tb;
    reg clk = 0;
    always #5 clk = !clk;
    reg reset_n = 0, in_valid = 0, out_ready = 0;
    reg [7:0] in_data = 0;
    wire in_ready, out_valid;
    wire [7:0] out_data;
    review_pipe dut (.*);

    integer received = 0, stalled_edges = 0, hold_checks = 0;
    reg previous_stall = 0;
    reg [7:0] previous_data;
    always @(posedge clk) begin
        if (reset_n) begin
            // A previous stalled edge obligates the producer to hold through this edge,
            // including the edge on which the consumer accepts the word.
            if (previous_stall) begin
                hold_checks = hold_checks + 1;
                if (out_valid !== 1'b1 || out_data !== previous_data)
                    $fatal(1, "held data or valid changed");
            end
            previous_stall = out_valid && !out_ready;
            previous_data = out_data;
            if (previous_stall) stalled_edges = stalled_edges + 1;
            if (out_valid && out_ready) begin
                // Fixed oracle derived from stimulus, independent of DUT storage.
                case (received)
                    0: if (out_data !== 8'hA5) $fatal(1, "first word mismatch");
                    1: if (out_data !== 8'h3C) $fatal(1, "second word mismatch");
                    default: $fatal(1, "unexpected word");
                endcase
                received = received + 1;
            end
        end
    end

    task send(input [7:0] word);
        wait (in_ready);
        @(negedge clk);
        in_data = word;
        in_valid = 1;
        @(negedge clk);
        in_valid = 0;
    endtask

    initial begin
        $dumpfile("trace.vcd");
        $dumpvars(0, tb);
        repeat (2) @(negedge clk);
        reset_n = 1;
        out_ready = !$test$plusargs("STALL");
        send(8'hA5);
        if ($test$plusargs("STALL")) begin
            repeat (3) @(negedge clk);
            out_ready = 1;
        end
        wait (received == 1);
        send(8'h3C);
        wait (received == 2);
        repeat (2) @(negedge clk);
        $display("PASS received=%0d stalled_edges=%0d hold_checks=%0d sample_ps=%0t",
                 received, stalled_edges, hold_checks, $time);
        $finish;
    end

    initial begin
        #1000 $fatal(1, "timeout");
    end
endmodule
