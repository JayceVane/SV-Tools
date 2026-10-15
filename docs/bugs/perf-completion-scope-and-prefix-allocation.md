# perf-completion-scope-and-prefix-allocation

> 发现方式：512 个 HDL 文件与十万行活动文档压力测试。
> 修复位置：`src/editor/completion/syntax.js`、`resolve.js`、`engine.js`、`provider.js`。

## 症状

首轮报告 `bin/completion-performance/run-x2uZbP/report.json`：

```json
{"coldIndexMilliseconds":29529.83,"warmProviderP95Milliseconds":176.29,"activeEditIndexMilliseconds":28110.13}
```

去除慢解析后，另一轮热请求仍只输出 7 项却短暂增长到约 1.07 GB heap，RSS 约 1.26 GB。

## 排查过程

1. 怀疑工程重复 I/O；计数显示 20 次热请求的 find/stat/read 均为零，排除文件读取问题。
2. 同一 module 的 1k/5k/10k 声明随规模非线性增长，定位到 `scope.symbols.some` 的逐项去重。
3. 改为 Set 后冷解析降到约半秒，但热分配仍大。候选只输出 7 项，说明开销发生在过滤前。
4. `visible` 先建立十万个引用，`entryFor` 再复制十万个对象，最后才按前缀过滤；这解释了热请求大量短命对象。
5. 光标上下文也曾扫描整份 token 和文本前缀，改为二分定位并在 provider 复用。

## 根因与修复

同一作用域逐声明线性查重使累计工作量为 O(n²)，现按 `kind:name` 使用 Set。候选过滤提前至建立引用之前；宽泛请求限制候选数量并标记 incomplete，继续输入可访问列表外的索引声明。按名称解析使用作用域映射，类/包/类型解析不再构建所有普通候选。

真实复测 `run-QlGnaO` 中冷索引 660.22 ms、热 provider p95 6.33 ms；20 次热请求零 I/O，warm heap 约 133 MB/RSS 310 MB。这是 Node provider 基准，不是 IDE UI 延迟。最终版本报告保留于交付记录。

## 教训

- 检查累计查重及过滤前分配，不能只看最后返回的候选数量。
- 性能合同同时记录 I/O、时间、模型复用和内存，区分磁盘、解析、候选构造。
- 单作用域大规模声明和大量小文件属于不同压力形态，两个都需要验收。
