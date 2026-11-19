module packet_hub (
    input logic         clk,
    input logic         rst_n,
    input logic         config_strobe,
    input logic [4:0]   config_word,
    sample_link        adc0,
    sample_link.sink    adc1,
    sample_link.sink    adc2,
    sample_link.sink    adc3,
    packet_link.source  telemetry,
    packet_link.source  capture,
    output logic        alert,
    output logic        activity
);
    packet_link lane0();
    packet_link lane1();
    packet_link lane2();
    packet_link lane3();
    packet_link arbitrated();
    packet_link buffered();

    wire [3:0] lane_enable;
    wire [3:0] dropped;
    wire route_capture;
    wire high_watermark;

    control_bank u_control (
        .clk(clk), .rst_n(rst_n), .config_strobe(config_strobe), .config_word(config_word),
        .lane_enable(lane_enable), .route_capture(route_capture)
    );
    sample_lane #(.LANE_ID(0)) u_lane0 (
        .clk(clk), .rst_n(rst_n), .enable(lane_enable[0]), .adc(adc0), .packets(lane0), .dropped(dropped[0])
    );
    sample_lane #(.LANE_ID(1)) u_lane1 (
        .clk(clk), .rst_n(rst_n), .enable(lane_enable[1]), .adc(adc1), .packets(lane1), .dropped(dropped[1])
    );
    sample_lane #(.LANE_ID(2)) u_lane2 (
        .clk(clk), .rst_n(rst_n), .enable(lane_enable[2]), .adc(adc2), .packets(lane2), .dropped(dropped[2])
    );
    sample_lane #(.LANE_ID(3)) u_lane3 (
        .clk(clk), .rst_n(rst_n), .enable(lane_enable[3]), .adc(adc3), .packets(lane3), .dropped(dropped[3])
    );
    packet_arbiter u_arbiter (
        .clk(clk), .rst_n(rst_n), .lane0(lane0), .lane1(lane1), .lane2(lane2), .lane3(lane3), .selected(arbitrated)
    );
    packet_fifo #(.DEPTH(32)) u_fifo (
        .clk(clk), .rst_n(rst_n), .enqueue(arbitrated), .dequeue(buffered), .high_watermark(high_watermark)
    );
    packet_router u_router (
        .clk(clk), .rst_n(rst_n), .route_capture(route_capture), .incoming(buffered), .telemetry(telemetry), .capture(capture)
    );
    sample_monitor u_monitor (.clk(clk), .rst_n(rst_n), .watched(adc0), .activity(activity));
    status_merge u_status (.dropped(dropped), .high_watermark(high_watermark), .alert(alert));
endmodule
