module sample_lane #(
    parameter int LANE_ID = 0
) (
    input logic       clk,
    input logic       rst_n,
    input logic       enable,
    sample_link.sink  adc,
    packet_link.source packets,
    output logic      dropped
);
    ...
endmodule

module packet_arbiter (
    input logic        clk,
    input logic        rst_n,
    packet_link.sink   lane0,
    packet_link.sink   lane1,
    packet_link.sink   lane2,
    packet_link.sink   lane3,
    packet_link.source selected
);
    ...
endmodule

module packet_fifo #(
    parameter int DEPTH = 32
) (
    input logic        clk,
    input logic        rst_n,
    packet_link.sink   enqueue,
    packet_link.source dequeue,
    output logic       high_watermark
);
    // The next milestone specifies capacity and backpressure before implementing storage.
    ...
endmodule

module packet_router (
    input logic        clk,
    input logic        rst_n,
    input logic        route_capture,
    packet_link.sink   incoming,
    packet_link.source telemetry,
    packet_link.source capture
);
    ...
endmodule

module control_bank (
    input logic         clk,
    input logic         rst_n,
    input logic         config_strobe,
    input logic [4:0]   config_word,
    output logic [3:0]  lane_enable,
    output logic        route_capture
);
    ...
endmodule

module sample_monitor (
    input logic      clk,
    input logic      rst_n,
    sample_link.tap  watched,
    output logic     activity
);
    ...
endmodule

module status_merge (
    input logic [3:0] dropped,
    input logic       high_watermark,
    output logic      alert
);
    assign alert = high_watermark | (|dropped);
endmodule
