# wave diff 配对键漏掉向量 range 后缀

## 识别特征

- **症状**：`wave diff` 返回的 `firstDiff.path` / `diffs[].path` 是 `tb.cnt`，而同一份数据的 JS 版返回 `tb.cnt[7:0]`。
- **触发条件**：只出现在**向量信号**（`$var wire 8 # cnt [7:0] $end`）上；标量信号（`clk`）两版一致，所以容易漏检。
- **影响范围**：`wave diff` 的输出键与合同不符，调用方按 `path` 回查信号表时会再匹配一次，且当同一模块内存在位宽不同但同名的信号时会配错对。
- **发现方式**：Rust/JS 对拍（`test/wave_parity_test.js` 「对拍 wave_diff：首差异时刻…」）在 `deepEqual(firstDiff.path)` 上暴露。

## 证据与结论

`docs/CLI.md` 对 `wave diff` 的合同写得很明确：

> 两份 VCD 同名信号（**键为路径+向量 range**）双指针对齐比较

JS 实现一致（`src/agent/wave.js`）：

```js
const byPathA = new Map(traceA.meta.vars.map(variable => [variable.path + (variable.range || ''), variable]));
```

Rust 初版在 `pair_signals` 里**配对**时用了 `path + range`，但生成输出条目时退化成了 `var_a.path.clone()`：

```rust
// 错：输出键丢了 range
path: var_a.path.clone(),
```

结果是「配对正确、输出键错误」——同一份数据配到了正确的信号对，但报告的路径与合同不符。这类**同一概念在两个地方各算一次**的写法是根因：键的构造没有单一来源。

**根因确认程度**：已证实。对拍在 `t=20` 首差异时刻一致、只有 `path` 字段不同，说明比较逻辑本身正确。

## 处理与取舍

抽出唯一构造点，配对与输出共用：

```rust
/// diff 的输出键：路径 + 向量 range（与 JS 版 `path + (range || '')` 一致，也是合同约定的配对键）。
fn diff_key(var: &WaveVar) -> String {
    format!("{}{}", var.path, var.range.clone().unwrap_or_default())
}
```

`pair_signals` 的局部闭包 `key_of` 改为别名 `let key_of = diff_key;`，`diff_pair_series` 的两处条目构造改用 `diff_key(var_a)`。

取舍：`--signals` 的过滤仍然**剥离** range 后再匹配短名（合同要求 `--signals q` 能命中 `tb.cnt[7:0]`），但输出键保留完整 range。这两个方向不同的规范化必须分开处理，不能合并成一个函数。

## 验证与复发预防

- `cargo test --lib wave::` 通过。
- 回归测试位置：Rust 单测 `diff_counts_only_transitions_into_difference` /
  `diff_reports_initial_mismatch_at_from_time`；CLI 端到端见
  `test/wave_service_test.js` 的「wave diff：首差异时刻与差异计数，短名剥 range 匹配」。
- 说明：本轮修复曾借助 `test/wave_parity_test.js`（JS/Rust 双实现对拍）暴露问题，
  该文件在 JS `VcdStore` 删除后已移除——两侧实现同源后对拍失去意义，
  相关断言已并入上面的 CLI 端到端用例。

**下次遇到向量信号相关的输出字段对不上，先检查「键是否同时包含 path 与 range」**，并且确认这个键只有一个构造点。
