interface sample_link;
    logic [15:0] sample;
    logic        valid;
    logic        ready;

    modport source (output sample, valid, input ready);
    modport sink   (input sample, valid, output ready);
    modport tap    (input sample, valid, ready);
endinterface

interface packet_link;
    logic [31:0] payload;
    logic [1:0]  lane;
    logic        last;
    logic        valid;
    logic        ready;

    modport source (output payload, lane, last, valid, input ready);
    modport sink   (input payload, lane, last, valid, output ready);
endinterface
