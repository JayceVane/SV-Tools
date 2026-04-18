// ============================================================================
// Example 3: Task / Function parameter alignment
// ============================================================================

// --- Before formatting ---

task automatic drive (
    input int            iter     ,
    input logic [31:0]   base_addr,
    input logic [31:0]   burst_len
);

    for(int i=0;i<iter;i++) begin
        @(posedge clk);arbase<=base_addr+i*burst_len*4;
        arvalid<=1'b1;@(posedge clk);arvalid<=1'b0;
        wait(arready);end

endtask

function automatic logic[7:0] get_checksum (
    input logic [7:0]    data [],
    input int            len
);

    logic[7:0] sum=0;
    for(int i=0;i<len;i++) sum+=data[i];
    return  sum;

endfunction

// --- After formatting ---

task automatic drive (
    input int            iter     ,
    input logic [31:0]   base_addr,
    input logic [31:0]   burst_len
);

    for(int i=0;i<iter;i++) begin
        @(posedge clk);arbase<=base_addr+i*burst_len*4;
        arvalid<=1'b1;@(posedge clk);arvalid<=1'b0;
        wait(arready);end

endtask

function automatic logic[7:0] get_checksum (
    input logic [7:0]    data [],
    input int            len
);

    logic[7:0] sum=0;
    for(int i=0;i<len;i++) sum+=data[i];
    return  sum;

endfunction
