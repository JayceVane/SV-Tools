// ============================================================================
// VF1: class + rand + constraint + covergroup（验证组件常见写法）
// ============================================================================

package vf1_pkg;

    typedef enum bit [1:0] {IDLE, RUN, PAUSE, DONE} state_e;

    typedef struct packed {
        bit [3:0] addr ;
        bit [7:0] data ;
        bit       valid;
    } pkt_t;

    class trans;
        rand bit [7:0] addr;
        rand bit [31:0] data;
        rand int len;
        bit ok;

        constraint c_addr { addr inside {[0:100], 200}; }
        constraint c_len {
            len > 0;
            len < 16;
            solve addr before len;
        }
        constraint c_data { data dist {8'h00 := 1, 8'hFF :/ 2, [1:127] := 5}; }

        function new(bit [7:0] a = 0);

            addr = a;
            data = '0;
        endfunction

        virtual function void print();

            $display("addr=%0h data=%0h len=%0d", addr, data, len);
        endfunction
    endclass

    class drv extends trans;
        int port;

        static int count;

        function new(int p = 0);

            super.new();
            port = p;
        endfunction

        task run();

            fork begin
                    #10ns;
                    drive();
                end

                wait (ok);
            join_any
            disable fork;

        endtask

        protected virtual task drive();

            foreach (data[i]) $display("%0d", data[i]);
        endtask
    endclass

    covergroup cg @(posedge clk);
        cp_state: coverpoint state {
            bins idle = {IDLE};
            bins run  = {RUN} ;

            bins trans[] = {[PAUSE:DONE]};
            illegal_bins bad = default;

        }
        cp_data: coverpoint data {
            bins        low   = {[0:127]}  ;
            bins        high  = {[128:255]};
            ignore_bins never = {8'h5A}    ;

        }
        x_state_data: cross cp_state, cp_data;
    endgroup

endpackage
