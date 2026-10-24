task automatic m_send (
    logic [  TDATA_W-1:0] tdata,
    logic [TDATA_W/8-1:0] tkeep = {(TDATA_W/8){1'b1}},
    logic [TDATA_W/8-1:0] tstrb = {(TDATA_W/8){1'b1}},
    logic [    TID_W-1:0] tid = {TID_W{1'b0}},
    logic [  TDEST_W-1:0] tdest = {TDEST_W{1'b0}},
    logic [  TUSER_W-1:0] tuser = {TUSER_W{1'b0}}
);
endtask

// 便捷 task：标量形参与向量形参共享名称列和默认值列。
task automatic m_send_with_wakeup (
    logic [  TDATA_W-1:0] tdata  ,
    logic [TDATA_W/8-1:0] tkeep = {(TDATA_W/8){1'b1}},
    logic [TDATA_W/8-1:0] tstrb = {(TDATA_W/8){1'b1}},
    logic [    TID_W-1:0] tid = {TID_W{1'b0}},
    logic [  TDEST_W-1:0] tdest = {TDEST_W{1'b0}},
    logic [  TUSER_W-1:0] tuser = {TUSER_W{1'b0}},
    logic twakeup = 1'b1
);
endtask
