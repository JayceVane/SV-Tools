// 带数组维度的声明与无维度声明混组：维度前的列只对齐「带维度的行」，
// 不被无维度行的名字列宽推远（mirror_q [$] 名字后不多出空格）
class scb;
    logic [DATA_WIDTH-1:0] mirror_q [$]; // 注意 [$] —— 动态队列
    logic                  model_full, model_empty;
    reg [7:0] mem [0:255];
    reg [7:0] buf [0:15];
    int               plain_cnt;
endclass
