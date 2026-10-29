# 格式化

## 入口

- `Shift+Alt+F`：格式化当前文档；命令 ID `svtools.formatDocument`。
- `Ctrl+Shift+X`：对齐所选代码；命令 ID `svtools.alignCode`。
- 保存时格式化由 `editor.formatOnSave` 控制；多格式化器时指定 `editor.defaultFormatter`。
- 独立 CLI 见本页末尾。

## 4.0 的布局规则

多行端口、声明、例化和 task/function 参数按列排版。显式写成单行的语句尽量保持单行；显式换行的参数表按多行规则处理。`always @(posedge i_clk or negedge i_rst_n)` 与单行条件中的冗余空格可以紧凑。

多行 task/function 的标量与向量共享名称列，默认值的 `=` 共用一列：

```systemverilog
task automatic m_send (
    logic [TDATA_W/8-1:0]  tkeep   = {(TDATA_W/8){1'b1}},
    logic [  TUSER_W-1:0]  tuser   = {TUSER_W{1'b0}},
    logic                  twakeup = 1'b1
);
endtask
```

标量为空位宽列预留空白；没有默认值的长名称、unpacked 维度也参与等号左侧宽度。默认表达式、字符串和注释里的比较符不会成为对齐分隔符。

## 常用设置

```json
{
  "svtools.tabSize": 4,
  "svtools.useTab": false,
  "svtools.indentStyle": "1tbs",
  "svtools.inlineCompact": true,
  "svtools.blankCompact": true,
  "svtools.maxConsecutiveEmptyLines": 1,
  "svtools.portNameGap": 2,
  "svtools.alignComma": true,
  "svtools.instAlignPort": true
}
```

| 设置 | 用途 |
|---|---|
| `inlineCompact` | 清理单行语句内多余的布局空格 |
| `blankCompact` | 处理块内/块间空行；关闭后保持用户的分组空行 |
| `maxConsecutiveEmptyLines` | 连续空行上限；`0` 不保留允许处的空行，`-1` 不处理空行 |
| `portNameGap` | 最宽方向/类型/位宽前缀与名称间的空格数，1–8 |
| `reindentOnly` | 只重排缩进，跳过列对齐 |
| `indentStyle` | `1tbs` 的 begin 同行，`gnu` 的 begin 另起一行 |

完整配置名和默认值见[配置参考](https://github.com/JayceVane/SV-Tools/wiki/Configuration)。

## 字符与词法保全

格式化只允许改变普通空格、Tab、CR、LF；其它字符的内容、数量、顺序保持，即使文本乱码或语法不完整。还会检查 token 边界，避免 `+ +` 合成 `++` 或把完整运算符拆开。字符串、宏正文和加密保护区按其保护规则保留。

无法安全提交的候选布局会保留原文，因此“没有变化”也可能是安全回退。格式化不负责修复语法、补标识符或调整功能。发现漏对齐时提交最小复现和相关设置，不需要提供整个私有工程。

## CLI

```powershell
.\svtools.exe demo.sv                 # 输出格式化结果
.\svtools.exe -i demo.sv              # 原地写入
.\svtools.exe -c demo.sv              # 只检查是否需要格式化
.\svtools.exe --port-name-gap 1 demo.sv
.\svtools.exe --help
```

精确规则以[格式化规范](https://github.com/JayceVane/SV-Tools/blob/v4.1.0/docs/FORMAT_SPEC.md)为准；[example](https://github.com/JayceVane/SV-Tools/tree/v4.1.0/example)保存输入和人工期望 golden。
