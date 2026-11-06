`timescale 1ns/1ps

module tb;
    localparam integer DEPTH = 4;

    logic wr_clk = 1'b0;
    logic rd_clk = 1'b0;
    logic rst_n = 1'b1;
    logic wr_en = 1'b0;
    logic [7:0] wr_data = 8'h00;
    logic wr_full;
    logic rd_en = 1'b0;
    logic [7:0] rd_data;
    logic rd_empty;
    logic rd_valid;

    afifo_m5 dut (
        .wr_clk(wr_clk), .rd_clk(rd_clk), .rst_n(rst_n),
        .wr_en(wr_en), .wr_data(wr_data), .wr_full(wr_full),
        .rd_en(rd_en), .rd_data(rd_data), .rd_empty(rd_empty), .rd_valid(rd_valid)
    );

    // Write rising edges are odd times and read rising edges are even times.
    always #3 wr_clk = ~wr_clk;
    always #4 rd_clk = ~rd_clk;

    logic [7:0] reference_fifo [0:DEPTH-1];
    integer head;
    integer tail;
    integer occupancy;
    integer writes_seen;
    integer reads_seen;
    integer writes_during_read_request;
    integer reads_during_write_request;
    string case_name = "startup";

    always @(negedge rst_n) begin
        head = 0;
        tail = 0;
        occupancy = 0;
        writes_seen = 0;
        reads_seen = 0;
        writes_during_read_request = 0;
        reads_during_write_request = 0;
    end

    always @(posedge wr_clk) begin
        if (rst_n) begin
            if (wr_full !== 1'b0 && wr_full !== 1'b1)
                $fatal(1, "%s: wr_full is unknown", case_name);

            if (wr_en && !wr_full) begin
                if (occupancy == DEPTH)
                    $fatal(1, "%s: accepted write beyond capacity", case_name);

                reference_fifo[tail] = wr_data;
                tail = (tail + 1) % DEPTH;
                occupancy = occupancy + 1;
                writes_seen = writes_seen + 1;
                if (rd_en)
                    writes_during_read_request = writes_during_read_request + 1;
            end
        end
    end

    always @(posedge rd_clk) begin : check_read
        logic accepted;
        logic [7:0] expected_data;

        if (rst_n) begin
            if (rd_empty !== 1'b0 && rd_empty !== 1'b1)
                $fatal(1, "%s: rd_empty is unknown", case_name);

            accepted = rd_en && !rd_empty;
            if (accepted) begin
                if (occupancy == 0)
                    $fatal(1, "%s: phantom read from empty FIFO", case_name);

                expected_data = reference_fifo[head];
                head = (head + 1) % DEPTH;
                occupancy = occupancy - 1;
                reads_seen = reads_seen + 1;
                if (wr_en)
                    reads_during_write_request = reads_during_write_request + 1;
            end

            #0.1;
            if (rd_valid !== accepted)
                $fatal(1, "%s: rd_valid=%b, expected %b", case_name, rd_valid, accepted);
            if (accepted && rd_data !== expected_data)
                $fatal(1, "%s: data mismatch, got %02h expected %02h", case_name,
                       rd_data, expected_data);
        end
    end

    task automatic reset_fifo;
        begin
            #0.2;
            rst_n = 1'b0;
            #0.2;
            if ({wr_full, rd_empty, rd_valid, rd_data} !== {3'b010, 8'h00})
                $fatal(1, "%s: asynchronous reset left full=%b empty=%b valid=%b data=%02h",
                       case_name, wr_full, rd_empty, rd_valid, rd_data);

            repeat (3) @(negedge wr_clk);
            #0.2;
            rst_n = 1'b1;
        end
    endtask

    task automatic write_burst(input integer count, input logic [7:0] first_data);
        integer index;
        integer cycles;
        logic accepted;
        begin
            @(negedge wr_clk);
            wr_en = 1'b1;
            for (index = 0; index < count; index = index + 1) begin
                wr_data = first_data + index[7:0];
                accepted = 1'b0;
                cycles = 0;
                while (!accepted && cycles < 32) begin
                    @(posedge wr_clk);
                    accepted = (wr_full === 1'b0);
                    cycles = cycles + 1;
                end
                if (!accepted)
                    $fatal(1, "%s: timed out writing item %0d", case_name, index);
                @(negedge wr_clk);
            end
            wr_en = 1'b0;
        end
    endtask

    task automatic read_burst(input integer count);
        integer index;
        integer cycles;
        logic accepted;
        begin
            @(negedge rd_clk);
            rd_en = 1'b1;
            for (index = 0; index < count; index = index + 1) begin
                accepted = 1'b0;
                cycles = 0;
                while (!accepted && cycles < 32) begin
                    @(posedge rd_clk);
                    accepted = (rd_empty === 1'b0);
                    cycles = cycles + 1;
                end
                if (!accepted)
                    $fatal(1, "%s: timed out reading item %0d", case_name, index);
                @(negedge rd_clk);
            end
            rd_en = 1'b0;
        end
    endtask

    task automatic expect_quiescent_flags(input logic full, input logic empty);
        begin
            fork
                begin
                    repeat (4) @(posedge wr_clk);
                    #0.1;
                    if (wr_full !== full)
                        $fatal(1, "%s: wr_full=%b after four write clocks, expected %b",
                               case_name, wr_full, full);
                end
                begin
                    repeat (4) @(posedge rd_clk);
                    #0.1;
                    if (rd_empty !== empty)
                        $fatal(1, "%s: rd_empty=%b after four read clocks, expected %b",
                               case_name, rd_empty, empty);
                end
            join
        end
    endtask

    task automatic exercise_full_backpressure;
        integer index;
        begin
            @(negedge wr_clk);
            wr_en = 1'b1;
            for (index = 0; index < 6; index = index + 1) begin
                wr_data = 8'he0 + index[7:0];
                @(posedge wr_clk);
                if (wr_full !== 1'b1)
                    $fatal(1, "%s: full FIFO did not block write %0d", case_name, index);
                @(negedge wr_clk);
            end
            wr_en = 1'b0;
        end
    endtask

    task automatic exercise_empty_backpressure;
        integer index;
        begin
            @(negedge rd_clk);
            rd_en = 1'b1;
            for (index = 0; index < 6; index = index + 1) begin
                @(posedge rd_clk);
                if (rd_empty !== 1'b1)
                    $fatal(1, "%s: empty FIFO did not block read %0d", case_name, index);
                @(negedge rd_clk);
            end
            rd_en = 1'b0;
        end
    endtask

    initial begin : run_cases
        integer writes_before;
        integer reads_before;

        $dumpfile(".svtools/vcd/tb.vcd");
        $dumpvars(0, wr_clk, rd_clk, rst_n, wr_en, wr_data, wr_full,
                  rd_en, rd_data, rd_empty, rd_valid);

        reset_fifo();

        case_name = "R1";
        write_burst(3, 8'h9e);
        expect_quiescent_flags(1'b0, 1'b0);
        read_burst(3);
        expect_quiescent_flags(1'b0, 1'b1);
        if (writes_seen != 3 || reads_seen != 3 || occupancy != 0)
            $fatal(1, "%s: did not complete three ordered transfers", case_name);

        case_name = "R2";
        writes_before = writes_seen;
        write_burst(DEPTH, 8'h31);
        expect_quiescent_flags(1'b1, 1'b0);
        exercise_full_backpressure();
        if (occupancy != DEPTH || writes_seen != writes_before + DEPTH)
            $fatal(1, "%s: full FIFO did not retain exactly four writes", case_name);
        read_burst(DEPTH);
        expect_quiescent_flags(1'b0, 1'b1);

        writes_before = writes_seen;
        reads_before = reads_seen;
        fork
            write_burst(24, 8'h70);
            read_burst(24);
        join
        expect_quiescent_flags(1'b0, 1'b1);
        if (writes_seen != writes_before + 24 || reads_seen != reads_before + 24 ||
            occupancy != 0 || writes_during_read_request == 0 ||
            reads_during_write_request == 0)
            $fatal(1, "%s: concurrent transfers did not complete in both domains", case_name);

        case_name = "R3";
        write_burst(3, 8'hc3);
        read_burst(1);
        if (occupancy != 2 || rd_valid !== 1'b1 || rd_data !== 8'hc3)
            $fatal(1, "%s: reset stimulus did not leave pending data and a valid read", case_name);
        reset_fifo();
        exercise_empty_backpressure();
        expect_quiescent_flags(1'b0, 1'b1);
        if (reads_seen != 0)
            $fatal(1, "%s: observed a read after reset and before a new write", case_name);
        write_burst(2, 8'h5a);
        read_burst(2);
        expect_quiescent_flags(1'b0, 1'b1);
        exercise_empty_backpressure();
        if (writes_seen != 2 || reads_seen != 2 || occupancy != 0)
            $fatal(1, "%s: FIFO did not recover after reset", case_name);

        $display("M5_CASES_PASS R1 R2 R3");
        $finish;
    end

    initial begin
        #10000;
        $fatal(1, "%s: simulation watchdog expired", case_name);
    end
endmodule
