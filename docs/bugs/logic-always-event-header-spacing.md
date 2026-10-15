# logic-always-event-header-spacing

> **发现方式**：用户提交 FIFO 验证代码，always 触发信号前的多余空格没有删除。
> **定位耗时**：本次开发会话。
> **修复位置**：`src/native/src/preprocess.rs` / `normalize_always_event_controls`。

## 症状

实际通过 alpha1 native 完整管线格式化后，下面的行在 `inlineCompact=true` 时仍保持原状：

```systemverilog
always @(posedge   i_clk) begin
```

alpha2 CLI 实际输出：

```systemverilog
always @(posedge i_clk) begin
```

## 排查过程

1. 先用已经构建的 alpha1 native 锁定失败，避免只测试某个私有 helper 而漏掉管线行为。
2. 检查紧凑规则的触发条件：完整单行语句需要分号；for 和 property 有自己的处理范围。
3. always 块头不是分号语句，因此没有进入水平空白紧凑规则。缩进和过程赋值对齐已经
   正常工作，在这些模块强行删空格会扩大修改范围。
4. 共享词法扫描先定位显式事件控制头的匹配括号，再对这个原文区间应用紧凑规则。

## 根因

“完整语句”的筛选条件覆盖了调用、声明和赋值，却遗漏了没有分号的事件控制头。
主调度保留用户空格，后续过程赋值对齐也没有理由重新处理头部，因此冗余空格一直保留。

## 修复

固定头部模式使用 `LazyLock`，只在 `inlineCompact` 开启时处理 always 系列的事件区间。
与已有表达式归一共用 `compact_inline_whitespace`，不复制一套空白扫描器；保持换行、
注释、字符串、宏以及转义标识符的终止空白，未闭合事件头保持原样。

新增 11 项完整 JS 合同和 6 项 Rust 测试；完整 Rust 112/112、格式化合同 42/42、
原有 golden 36/36 通过。CLI 标准输入与 `--check` 幂等验证也通过。

## 教训

行内紧凑规则的范围应按语法构造定义，不能把“需要紧凑”与“以分号结束”混成同一判断。
扩展覆盖范围时应沿用原文保护合同，并验证关闭配置和幂等性。
