# svtools SystemVerilog 格式化规范（Format Spec）

本规范是 svtools 格式化器的**唯一权威行为定义**。实现与规范冲突时：先修实现对齐规范；
若规范本身不合理，先改规范（附 golden 用例）再改实现。每条规则都应有 `example/` golden
用例背书（见 §11）。

- 版本：v3.4.6（对应空行规则重构）
- 配置基线：扩展默认配置（见 §3），golden 测试全部按此基线校验

---

## 1. 总则

1. **幂等性**：对格式化输出再次格式化必须得到完全相同的结果。所有规则都不得引入
   二次格式化的不稳定（这是 golden 测试的第二个断言）。
2. **保守性**：格式化器不做语义判断，只按词法结构重排。无法识别的构造原样保留。
3. **用户布局意图优先**（§7）：用户显式写的单行/多行形态决定输出形态；格式化器
   只在用户没有表达意图的地方施加统一形态。
4. 输出统一使用 LF 行尾（输入 CRLF 在预处理阶段归一）。

## 2. 术语

| 术语 | 定义 | 例 |
|---|---|---|
| **语句** | 以深度 0 的 `;` 结束的单行/多行文本 | `logic a;`、`assign x = {a,\n b};` |
| **块** | 有独立块体的构造：task/function/property/sequence/covergroup/clocking、always/initial/final、多行实例化、generate、begin/end、fork/join、case/endcase | `task t(); … endtask` |
| **容器** | 成员为语句/块的构造：module/interface/package/class/program/checker/generate | `module m; … endmodule` |
| **块头 / 块体 / 块闭合行** | 块的首行 / 中间部分 / `end*` 行 | `task t();` / 语句 / `endtask` |
| **声明类语句** | 声明与声明样式的单行构造：变量声明、`assign`、单行 `constraint`、`import`、`localparam/parameter`、modport、typedef | `constraint c { x > 0; }` |
| **块级行** | 块头行（以块关键字开头）或块闭合行（`end`/`endtask`/`endgroup`/… /`join*`，或多行语句的收尾 `);`） | — |

`constraint` **归类为声明类语句**（即使写成多行块体）：单行保持单行，显式换行才展开
（§7.2），且相互之间、与相邻声明之间**不插空行**（§6）。

## 3. 配置项（扩展默认值）

| 配置 | 默认 | 含义 |
|---|---|---|
| `indentStyle` | `1tbs` | `1tbs`：begin 与控制行同行；`gnu`：begin 另起一行 |
| `useTab` / `nbSpace` | false / 4 | 缩进字符与宽度 |
| `maxConsecutiveEmptyLines` | 1 | 空行控制上限（§6）；`0`=允许处也不留空行；`-1`=完全不处理空行 |
| `inlineCompact` | true | **行内紧凑**：单行语句内主动删除多余空格（§7.1）。关闭则保持原有空格 |
| `blankCompact` | true | **行间紧凑**：主动删除多余空行（§6 块内删/块间保证）。关闭则保持用户空行、不插入，仅折叠至 max，且格式化不得新增空行（§6.7） |
| `reindentOnly` | false | true 时只重排缩进，不做对齐 |
| `ignoreTick` | true | 宏行（`` `ifdef `` 等）保持第 0 列原样 |
| `oneDeclPerLine` | false | 一行多声明是否拆成每行一个 |
| `oneBindPerLine` | true | `bind` 每条一行 |
| `alignComma` | true | 逗号/分号对齐（声明组、参数列表） |
| `paramOneLine` | true | 模块参数能放一行则保持一行 |
| `importSameLine` | false | `import pkg::*;` 是否并入上一行 |
| `instAlignPort` | true | 实例端口 `.name(sig)` 按列对齐 |

## 4. 预处理

1. CRLF/CR → LF。
2. 语句切分：**深度 0** 的 `;` 处断行；括号 `()` 与花括号 `{}` 深度跨行累计——
   `constraint c { a;\n b; }` 中的 `;` 不切（深度非 0）；多行拼接 `assign x = {`…`};`
   同理。
3. 行尾 `\` 续行整体保留，不参与切分。
4. 单行 `for(int i=0;i<n;i++) x+=y;` 的运算符补空格：`for (int i = 0; i < n; i++) x += y;`；
   带 `begin` 的多行 for 头不处理。
5. `modport m(output a, b, input c);` 按方向拆行（§9.6）。

## 5. 缩进

1. 每层 = `nbSpace` 个空格（`useTab` 时 1 个 tab）。
2. **1tbs**：`begin` 保持在控制语句同行；`end`/`endcase`/`endtask`/… 独立成行，
   缩进与对应块头对齐。**gnu**：`begin` 换行并 +1 缩进。
3. 嵌套逐层 +1：`case` 内条目体、`fork` 内分支、`generate` 内语句、任务/函数体、
   多行实例端口/参数列表各 +1。
4. 行首 `` `ifdef/`else/`endif `` 等宏行不缩进（`ignoreTick`），但其包围的代码正常缩进。
5. `end : label` 带标签的闭合保持标签。

## 6. 空行规则 ★（v3.4.6 核心变更）

空行由**独立的后处理 pass** 统一裁决（实现：`blank_rules.rs`），分三类区域：

### 6.1 块内 —— 无空行

下列区域内部**删除所有空行**（包括用户书写的）：

- task / function 体（块头行与 `endtask`/`endfunction` 之间）
- property / sequence / covergroup / clocking 体
- begin/end 体、fork/join 体、case/endcase 体（含 always/initial 内部）
- constraint `{ … }` 体、typedef struct `{ … }` 体、coverpoint `{ bins … }` 体
- 多行语句的括号/花括号续行内（实例端口列表、多行 assign 拼接等）

例外：`maxConsecutiveEmptyLines = -1` 时不做任何空行处理（保留原样）。

> 动机：task 体首尾及声明后曾被插入空行（align_decl 尾部换行伪影 + flush 后种子空行），
> 用户明确要求块内一律无空行（ex10/ex11 golden）。

### 6.2 块间 —— 空行分隔

容器体内，**两个相邻非空行 A、B**（注释归属其后随语句，见 6.4）中任一为块级行时，
二者之间保证空行数落在 `[1, maxConsecutiveEmptyLines]` 区间：

- 原本 0 行空行 → 插入 1 行（当 max ≥ 1）；
- 原本 ≥1 行 → 折叠至 max（默认 1）。

块级行 = 块头行（`task/function/always*/initial/final/covergroup/clocking/property/
sequence/generate/fork` 开头）或块闭合行（`end`、`endtask`、`endfunction`、
`endproperty`、`endsequence`、`endgroup`、`endclocking`、`endgenerate`、
`join/join_any/join_none`，及多行语句的收尾 `);` 行）。

注意：

- `endmodule/endclass/endinterface/endpackage/endprogram`（容器闭合）**不属于**块级行
  ——容器末尾的空行只保留折叠、不插入。
- constraint 收尾 `}`、assign 拼接收尾 `};` **不属于**块闭合行（声明类语句，6.3）。
- **if/else 链延续**：行首 `else` / `else if` 与其前的 `end` 同属一条语句，中间**不留
  空行**（已有一律删除）。

### 6.3 语句间 —— 保留折叠

容器体内相邻的声明类语句 / assign / 注释之间：**不插入**空行；用户已有空行折叠至
`maxConsecutiveEmptyLines`（保留原有空白行的原文，例如只含空格的行不清洗内容）。

### 6.4 注释归属

紧邻语句上方的注释行视为该语句的一部分（不因该语句是块头而在注释与语句间插空行）；
块闭合行与注释之间正常适用 6.2（空行插在块闭合行之后、注释之前）。

### 6.5 文件首尾

- 输出以单个换行符结束；文件末尾**不保留空行**（beautifier 输出尾部的多余换行删除）。
- 文件开头的空行折叠至 max，不插入。
- 唯一例外：未闭合的 `/* */` 块注释内部空行原样保留（§10.2）。

### 6.6 语义示例

```systemverilog
module m;                          // 容器
    logic a;                       // ── 语句组（6.3：无空行插入，保留折叠）
    logic b;
    always #5 clk = ~clk;          // 块头行（6.2：与上一语句间保证空行）
    bus_if i (                     // 多行实例：块（6.2）
        .clk(clk)                  //   └ 体内部无空行（6.1）
    );                             //   └ 收尾 );：块闭合行（6.2）
    constraint c { x > 0; }        // 声明类语句（6.3：与相邻声明间不插空行）
    task t();                      // 块头（6.2）
        int v;                     // ── 块内无空行（6.1）
        v = 1;
    endtask                        // 块闭合（6.2：与下一内容间保证空行）
    constraint c2 {                // constraint 多行体 = 6.1 无空行
        y > 0;
    }                              //   └ `}` 非块闭合行：与下一 constraint 间不插
endmodule                          // 容器闭合：不插入空行（6.2 注）
```

### 6.7 行间紧凑开关（`blankCompact`）

- **开（默认）**：按 §6.1–6.5 主动裁决（块内删除、块间保证、EOF 清理）。
- **关（保持模式）**：不插入、不删除，仅把连续空行折叠至
  `maxConsecutiveEmptyLines`；**硬不变量：格式化不得新增空行**。为此格式化器
  内部不再产生任何伪影空行（声明组尾部换行、行中 flush 后的种子空行等
  伪影源已在源头消除）。

## 7. 单行对齐逻辑与多行对齐逻辑

整个格式化分为两条对齐线：**用户未自行换行的语句走单行对齐逻辑（紧凑）**；
**用户显式换行的语句走多行对齐逻辑（列对齐，§8）**。

### 7.1 单行语句紧凑（`inlineCompact`，默认开）

用户写成单行且语义完整的语句（语句拆行后单行、括号平衡、以 `;` 结束）：

- 词间空白折叠为单个空格；
- `(`、`[` 后与 `)`、`]`、`,`、`;` 前的空格删除；
- **只删不补**：运算符两侧没有空格的不动；
- 字符串字面量与行尾注释原样（注释与代码间保留单个空格）；含块注释的行、
  宏行（`` ` `` 开头）保守跳过。

适用（ex13）：系统任务调用（`$display`/`$error`/`$fatal`…）、`else` 分支语句、
单行模块例化（保持单行不展开，§8.3）、task/function 头、延时控制、单行 if 等。
对齐类语句（声明、assign、case 项）先紧凑再由 §8 的对齐器重建列宽——对齐结果
不受影响。`inlineCompact` 关闭时全部保持原有空格。

### 7.2 单行构造保留

用户写成单行且语义完整的构造**保持单行**，不展开：

- 单行 constraint：`constraint c_addr { addr inside {[0:100], 200}; }`
- 单行参数列表：`function new(bit [7:0] a = 0);`
- 单行模块例化：`bus_if #(.DW(32)) u_if (.clk(clk), .rst_n(rst_n));`
- 单行 for / 单行 if 语句体、单行 always（`always #5 clk = ~clk;`）
- modport **例外**：走实例对齐路径展开多行（ex9 golden 形态）

### 7.3 显式换行 → 展开

用户在构造内部换行的，按标准多行形态展开：

| 输入（用户显式换行） | 输出 |
|---|---|
| `constraint c {`⏎`x > 0; }` | `constraint c {`⏎`    x > 0;`⏎`}` |
| `function f(`⏎`int a`⏎`);` | 参数逐行对齐（§8.4），`);` 独立行 |

### 7.4 内联 `}` 拆分

多行 constraint 体内行尾内联 `}`（`…; }`）拆为独立行，缩进取块首行；
`}` 前已无内容或该行本身是块头（单行块）时不动。

### 7.5 显式换行的判定基准

"是否显式换行"以**预处理切分前的原始行**为准：换行出现在 `{`/`(` 之后即刻（块头行
只到开括号为止）→ 全展开；换行出现在表达式中间（如 dist 列表中途）→ 保留用户的断行
位置，仅做缩进修正与 7.3 的 `}` 拆分。

## 8. 对齐规则（`reindentOnly = false` 时）

**总则（幂等性推论）**：对齐分组只由代码行的**缩进与内容**决定，**空行透明**——空行
不参与分组判定、不切断对齐组（§6 的空行增删不得改变对齐宽度）。

### 8.1 声明组对齐

连续声明行按 **类型/位宽/变量名/维度/初始化** 各列对齐（ex1/ex11）：

```systemverilog
    semaphore      sem          ;
    vf1_pkg::pkt_t q    [     $];
    int            assoc[string];
```

- 跨行深度 0 `;` 数 ≥2 的紧凑风格行（`logic a; logic b;`）保持紧凑。
- 紧凑类型补格：`logic[7:0] x;` → `logic [7:0] x;`。
- 作用域限定类型（`vf1_pkg::pkt_t`）整体占类型列。

### 8.2 赋值对齐

同一语句块内的 `=` / `<=` 运算符按列对齐（ex3/ex11）：

```systemverilog
        rst_n      = 0;
        mb_gen2drv = new();
```

- 连续 assign（模块级）同样对齐；用户紧凑风格（一行多句）保持紧凑不展开。
- case 条目 `label : stmt;` 的冒号对齐（`::` 作用域运算符除外）。

### 8.3 实例端口对齐（`instAlignPort`）

```systemverilog
    bus_if #(.DW(32)) bus_if_i (
        .clk  (clk  ),
        .rst_n(rst_n)
    );
```

`.name(` 与 `(sig` 各自按列对齐；单行实例保持单行。

### 8.4 task/function 参数列对齐

用户多行书写的参数列表：方向/类型/位宽/名/默认值各列对齐，`);` 独立行（ex3）；
单行参数列表保持单行（§7.1）。

### 8.5 bins / coverpoint 对齐

covergroup 内 bins 名与 `{…}` 集合按列对齐（ex8）。

### 8.6 modport 展开

`modport m(output a, b, input c);` → 方向逐行：

```systemverilog
    modport m (
        output a, b,
        input c
    );
```

## 9. 专项构造规则

1. **task/function**：`automatic` 等修饰保持；体缩进 +1；`endtask : label` 保留标签。
2. **class**：成员声明组与方法之间空行按 §6.2；`extends`/`implements` 同行。
3. **covergroup**：`with function sample(...)` 采样头同行；`option.*` 逐行；
   coverpoint 体内 bins 对齐（§8.5）。
4. **clocking/modport**：`default input #1step output #2;` 保持；信号列表对齐；
   modport 按方向展开（§8.6）。
5. **sequence/property/assert**：块头与体之间**不插入空行**（v3.4.1 修复）；
   `|->`/`|=>`/`##[1:3]` 等时序运算符两侧空格保持。
   **体内空格归一化**：词间空白折叠为单个空格；`(` 后与 `)`/`,`/`;` 前的空格
   删除（`$rose(valid  )` → `$rose(valid)`；`property   p;` → `property p;`）。
   只删多余空格，不补缺失的运算符空格；字符串与注释不动（ex12）。
6. **fork/join 族**：`join`/`join_any`/`join_none` 独立成行、与 fork 对齐缩进；
   `wait fork;` / `disable fork;` 是普通语句（不得误判为实例化）。
7. **do/while**：`do @(posedge clk);` 与 `while (!ready);` 各自独立成行（用户换行时保留）。
8. **队列/关联数组维度**：`q[$]`、`assoc[string]` 维度与变量名列对齐（§8.1），
   维度内部空格保留用户原文。
9. **import/export**：`importSameLine=false` 时独立成行。
10. **宏**：`` `ifdef/`ifndef/`elsif/`else/`endif `` 第 0 列；`` `define `` 体（含续行）
    原样保留。**`` `pragma protect `` 加密区**（`begin_protected` … `end_protected`，
    含 Synopsys 风格 `` `protect ``）**整区逐字节透传**——BASE64 载荷行长（如
    `line_length=76`）是编码规范的一部分，重排会破坏解密；未闭合区域余下全部
    透传。区外代码段边界镜像用户的空行分隔（≥1 空行 → 恰好 1 行，无则不加）
    （ex16）。
11. **generate**：`genvar` 声明按声明组处理；`if/for` 生成块体 +1 缩进；
    其内实例按 §8.3 对齐。
12. **bind**（`oneBindPerLine`）：每条 bind 一行。
13. **模块/接口头端口表**：方向/`var`/类型/位宽各列按组内最宽对齐，位宽内容右对齐
    补格（同组 `[7:0]` → `[   7:0]` 对齐 `[1023:0]`）；**名称列与最宽前缀之间固定
    2 空格**——不按缩进宽度向上取整，取整会使列距随组宽在 2..5 间漂移（ex15）；
    端口名按 `alignComma` 对齐逗号列。

## 10. 注释与字符串

1. 行注释 `//` 位置保持（跟在代码后的注释与代码同行的间隔规范化为一个空格）。
2. 块注释 `/* */` 整块保留原样（内部空行不动，§6 的扫描跳过注释与字符串字面量）。
3. 字符串字面量内容一律原样（含 `{}`/`()`/关键字）。
4. 注释行视为语句参与 §6 空行判定（归属后随语句，§6.4）。

## 11. 测试约定（golden）

- `example/*.sv` = 格式化前输入；`example/target/<同名>` = 期望输出（LF 或 CRLF 均可，
  比较时归一）。
- 每用例两个断言：① 格式化输出 == golden；② 对 golden 再格式化 == golden（幂等）。
- `node test/golden_test.js` 运行；扩展侧真实回归 `node test/run-auto-lint-repro.js`。
- 新格式化问题 → 最小复现入 `example/`，按本规范校对输出后固化 golden；规范变更必须
  同步更新本文档。

---

*实现索引：预处理 `src-rust/src/preprocess.rs`；主循环 `beautifier.rs`；对齐
`align/{decl,assign,instance,module_port,task_func_param}.rs`；空行 pass
`blank_rules.rs`；收尾 `postprocess.rs`。*
