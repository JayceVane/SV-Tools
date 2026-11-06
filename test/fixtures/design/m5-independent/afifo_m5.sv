module afifo_m5 (
    input  logic       wr_clk,
    input  logic       rd_clk,
    input  logic       rst_n,
    input  logic       wr_en,
    input  logic [7:0] wr_data,
    output logic       wr_full,
    input  logic       rd_en,
    output logic [7:0] rd_data,
    output logic       rd_empty,
    output logic       rd_valid
);
    logic [7:0] storage [0:3];
    logic [2:0] wr_bin, wr_bin_next, wr_gray, wr_gray_next;
    logic [2:0] rd_bin, rd_bin_next, rd_gray, rd_gray_next;
    (* ASYNC_REG = "TRUE" *) logic [2:0] rd_gray_wr_meta, rd_gray_wr_sync;
    (* ASYNC_REG = "TRUE" *) logic [2:0] wr_gray_rd_meta, wr_gray_rd_sync;
    logic write_accepted, read_accepted;

    assign write_accepted = wr_en && !wr_full;
    assign read_accepted = rd_en && !rd_empty;
    assign wr_bin_next = wr_bin + {2'b00, write_accepted};
    assign rd_bin_next = rd_bin + {2'b00, read_accepted};
    assign wr_gray_next = wr_bin_next ^ (wr_bin_next >> 1);
    assign rd_gray_next = rd_bin_next ^ (rd_bin_next >> 1);

    always_ff @(posedge wr_clk) begin
        if (rst_n && write_accepted)
            storage[wr_bin[1:0]] <= wr_data;
    end

    always_ff @(posedge wr_clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_bin          <= '0;
            wr_gray         <= '0;
            rd_gray_wr_meta <= '0;
            rd_gray_wr_sync <= '0;
            wr_full         <= 1'b0;
        end else begin
            rd_gray_wr_meta <= rd_gray;
            rd_gray_wr_sync <= rd_gray_wr_meta;
            wr_bin          <= wr_bin_next;
            wr_gray         <= wr_gray_next;
            // A four-entry offset flips the two upper Gray-code bits.
            wr_full <= wr_gray_next == {~rd_gray_wr_sync[2:1], rd_gray_wr_sync[0]};
        end
    end

    always_ff @(posedge rd_clk or negedge rst_n) begin
        if (!rst_n) begin
            rd_bin          <= '0;
            rd_gray         <= '0;
            wr_gray_rd_meta <= '0;
            wr_gray_rd_sync <= '0;
            rd_empty        <= 1'b1;
            rd_valid        <= 1'b0;
            rd_data         <= '0;
        end else begin
            wr_gray_rd_meta <= wr_gray;
            wr_gray_rd_sync <= wr_gray_rd_meta;
            rd_bin          <= rd_bin_next;
            rd_gray         <= rd_gray_next;
            rd_empty        <= rd_gray_next == wr_gray_rd_sync;
            rd_valid        <= read_accepted;
            if (read_accepted)
                rd_data <= storage[rd_bin[1:0]];
        end
    end
endmodule
