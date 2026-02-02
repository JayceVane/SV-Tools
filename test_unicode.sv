// Unicode 测试文件 - Unicode Test File
// 测试各种 Unicode 字符 - Testing various Unicode characters

module unicode_test #(
   parameter WIDTH = 8     , // 数据位宽 Data width
   parameter DEPTH = 16    , // 深度 Depth
   parameter MODE  = "READ"  // 模式 Mode (读/写 Read/Write)
) (
   input  wire             clk     , // 时钟 Clock ?
   input  wire             rst_n   , // 复位 Reset (低有效) ?
   input  wire [WIDTH-1:0] data_in , // 数据输入 Data input ?
   output wire [WIDTH-1:0] data_out, // 数据输出 Data output ?
   output wire             valid     // 有效信号 Valid signal ?
);

   // 变量声明 - Variable declarations
   logic [WIDTH-1:0] buffer ; // 缓冲区 Buffer ?
   logic [DEPTH-1:0] pointer; // 指针 Pointer ?
   logic             ready  ; // 就绪信号 Ready signal ?
   logic             error  ; // 错误标志 Error flag ?

   // 赋值语句 - Assignment statements
   assign ready    = pointer < DEPTH;              // 就绪条件 Ready condition
   assign error    = pointer >= DEPTH;             // 错误条件 Error condition
   assign data_out = buffer;                     // 输出赋值 Output assignment

   // 时序逻辑 - Sequential logic
   always_ff @(posedge clk or negedge rst_n) begin
      if (!rst_n) begin
         // 复置逻辑 - Reset logic
         buffer  <= {WIDTH{1'b0}};  // 清零缓冲 Clear buffer ?
         pointer <= 0;               // 重置指针 Reset pointer
      end else begin
         // 正常操作 - Normal operation
         if (ready) begin
            buffer  <= data_in;       // 读取数据 Read data ?
            pointer <= pointer + 1;  // 递增指针 Increment pointer ?
         end
      end
   end

   // 枚举类型测试 - Enum type test
   typedef enum logic [1:0] {
      IDLE  = 2'b00,  // 空闲 Idle ?
      BUSY  = 2'b01,  // 忙碌 Busy ?
      DONE  = 2'b10,  // 完成 Done ?
      ERROR = 2'b11   // 错误 Error ??
   } state_t;

   state_t current_state, next_state; // 状态变量 State variables

   // 状态机 - State machine
   always_comb begin
      case (current_state)
         IDLE    : next_state = BUSY ;   // 空闲 -> 忙碌 Idle -> Busy
         BUSY    : next_state = DONE ;   // 忙碌 -> 完成 Busy -> Done
         DONE    : next_state = IDLE ;   // 完成 -> 空闲 Done -> Idle
         ERROR   : next_state = IDLE ;   // 错误 -> 空闲 Error -> Idle
         default : next_state = IDLE ;
      endcase
   end

endmodule
