module trace_lane (
    input  wire [7:4] a,
    input  wire [0:3] b,
    input  wire       select_b,
    input  wire       clk,
    input  wire       rst_n,
    output wire [11:8] y,
    output reg  [3:0] q,
    output wire [3:0] repeated,
    output wire [3:0] constants
);
    wire [3:0] permuted = {a[4], a[7], a[4], a[6]};
    wire [3:0] chosen = select_b ? b : permuted;
    assign y = chosen;
    assign repeated = {4{a[5]}};
    assign constants = 4'b1001;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) q <= 4'b1010;
        else q <= chosen;
    end
endmodule

module trace_top (
    input  wire [7:4] a,
    input  wire [0:3] b,
    input  wire select_b, clk, rst_n,
    output wire [11:8] y_left, y_right,
    output wire [3:0] q_left, q_right,
    output wire [3:0] repeated_left, repeated_right,
    output wire [3:0] constants_left, constants_right
);
    trace_lane u_left (.a(a), .b(b), .select_b(select_b), .clk(clk), .rst_n(rst_n),
        .y(y_left), .q(q_left), .repeated(repeated_left), .constants(constants_left));
    trace_lane u_right (.a(a), .b(b), .select_b(!select_b), .clk(clk), .rst_n(rst_n),
        .y(y_right), .q(q_right), .repeated(repeated_right), .constants(constants_right));
endmodule
