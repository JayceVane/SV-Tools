// ============================================================================
// VF3: testbench top — program/mailbox/semaphore/queue/assoc array/wait fork
// ============================================================================

module vf3_tb_top;

    logic clk = 0;
    logic rst_n;
    always #5 clk = ~clk;

    bus_if #(.DW(32)) bus_if_i (.clk(clk), .rst_n(rst_n));

    mailbox #(vf1_pkg::pkt_t) mb_gen2drv;
    semaphore sem;
    vf1_pkg::pkt_t q[$];
    int assoc[string];
    vf1_pkg::drv drv_h;

    covergroup cg_port with function sample(int port);
        option.per_instance = 1;
        cp_port: coverpoint port {
            bins ports[] = {[0:3]};
        }
    endgroup

    initial begin : main
        rst_n = 0;
        mb_gen2drv = new();
        sem = new(1);
        drv_h = new(2);
        cg_port = new();
        fork
            generator();
            driver();
            monitor();
        join_none
        repeat (20) @(posedge clk);
        wait fork;
        $display("done, coverage=%.2f%%", cg_port.get_coverage());
        $finish;
    end

    task automatic generator();
        vf1_pkg::trans t;
        repeat (10) begin
            assert (t.randomize() with { len inside {[1:8]}; })
                else $error("randomize failed");
            mb_gen2drv.put(t);
            q.push_back(t.pkt);
        end
    endtask

    task automatic driver();
        forever begin
            vf1_pkg::pkt_t p;
            mb_gen2drv.get(p);
            @(posedge clk);
            bus_if_i.wdata <= p.data;
            bus_if_i.valid <= 1'b1;
            do @(posedge clk); while (!bus_if_i.ready);
            bus_if_i.valid <= 1'b0;
        end
    endtask

    task automatic monitor();
        forever begin
            @(posedge clk);
            if (bus_if_i.valid && bus_if_i.ready) begin
                assoc["hit"]++;
                $display("%0t got pkt", $time);
            end
        end
    endtask

endmodule
