# logic-codegen-module-boundaries

> **发现方式**：4.0发布审查，生成结果再交给真实Icarus编译运行。
> **定位耗时**：本轮集中排查。
> **修复位置**：native/parser/module、bindings、codegen/testbench。

## 症状与排查

含 `$clog2(16)` 的参数头会把W当作端口，时钟、数据端口丢失，NAPI仍返回success。
`LABEL="https://example.invalid/a;  b)"` 在生成前的normalize中转被误当注释或语句边界。
`input int d` 被声明成单bit，unpacked数组后缀使端口被静默丢弃。
参数Testbench存在 `parameter W W = ...`；无时钟模块生成 `@(posedge );`。
修正头部后继续检查绑定层，才发现预处理仍会改写字符串；修正ANSI头后检查非ANSI，又发现同名task形参会覆盖模块端口。

## 根因与修复

原实现依赖首个右括号、首个分号和逗号切分，没有维护嵌套结构与保护区。
现以等长掩码和平衡扫描定位模块头，只从原文取参数值；绑定层不再normalize字符串。
模块声明补全跳过task/function，明确整数映射标准位宽，不能忠实表达的接口直接报错而不返回部分模板。
Testbench独立声明参数、输入初始化、实际多域时钟/复位驱动，无时钟使用延时，inout仅声明wire。
默认VCD且 `$dumpvars(0, tb_module)` 传层级标识符；专用波形任务仅在用户显式选择对应工具时生成。

## 边界与验证

模板仍是可编辑骨架，不推断协议激励、CDC关联、真实周期或同步释放策略。
本轮不实现预处理/详细化、用户类型系统、unpacked接口或modport；不支持时明确说明。
8个真实Icarus场景覆盖嵌套参数、组合/inout、多域正负沿、非ANSI、无时钟复位、整数位宽及关闭task选项，全部编译运行并生成VCD。
教训：成功标志必须代表接口完整，生成结果应由真实编译器验证，不能只断言文本中出现模块名。
