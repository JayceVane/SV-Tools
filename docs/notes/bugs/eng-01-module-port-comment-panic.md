# Bug eng-01: 参数列表含注释行时 module_port 对齐 panic

> **Severity**: 高
> **How discovered**: 格式化含注释行的参数列表时，扩展直接崩溃（Rust panic: index out of bounds）
> **Fixed in**: `src-rust/src/align/module_port.rs` — 参数对齐循环

## Symptom

当模块参数列表中包含注释行时，执行格式化会导致 Rust 原生模块 panic：

```
thread '<unnamed>' panicked at 'index out of bounds: the len is 2 but the index is 3'
```

触发代码示例：

```systemverilog
module foo #(
    parameter W = 8,
    // this is a comment line
    parameter DW = W * 2
) (
    input clk
);
endmodule
```

VSCode 侧表现为格式化失败，弹出错误提示 `Formatting failed: ...`。

## Root cause

在 `align_module_port` 函数中，参数列表按 `\n` 拆分为 `lines` 后逐行遍历，循环变量 `i` 是**行索引**。但 `values` 数组只包含实际参数的默认值（通过正则从参数行提取），不包含注释行。

原代码直接用行索引 `i` 访问 `values[i]`：

```rust
// 修复前
values[i].clone().min(
    values[values.len().min(i)..]
        .first()
        .map(|s| s.as_str())
        .unwrap_or("")
        .to_string()
)
```

当参数列表中混入注释行时，`lines` 的长度 > `values` 的长度。例如上例中 `lines` 有 3 行（W、注释、DW），但 `values` 只有 2 个元素（`"8"`, `"W * 2"`）。遍历到注释行时 `i = 1` 虽然不越界，但遍历到第三行时 `i = 2` 就会越界 panic。

更隐蔽的是，原代码还用 `values[values.len().min(i)..]` 做切片来取"下一个值"，这个逻辑本身就假设了行索引和值索引一一对应，注释行打破了这个假设。

## Fix

引入独立的 `param_idx` 计数器，仅在实际匹配到参数行时递增，与行索引 `i` 解耦：

```rust
// 修复后
let mut param_idx: usize = 0;

for (i, line) in lines.iter().enumerate() {
    // ...
    if let Some(m_param) = re_param.captures(l) {
        // ... 使用 param_idx 而非 i 访问 values
        values.get(param_idx).cloned().unwrap_or_default().min(
            values.get(param_idx + 1).cloned().unwrap_or_default()
        )
        // ...
        param_idx += 1;  // 仅在处理了实际参数后递增
    }
}
```

同时将 `values[i]` 改为 `values.get(param_idx)` 安全访问，即使索引计算有误也不会 panic，而是返回空字符串。

## Lessons

- **行索引 ≠ 语义索引**：按行遍历文本时，如果目标数据是从行中条件提取的（如正则匹配），必须用独立计数器跟踪语义索引，不能复用行循环变量。
- **Rust 的 `[]` 索引是 panic 而非 UB**：虽然比 C 安全，但在 napi-rs 场景下 panic 会导致整个 Node.js 调用失败。对不确定长度的数组优先使用 `.get()` 安全访问。
- **注释行是格式化器的"隐形杀手"**：任何基于行遍历 + 位置索引的逻辑，都要考虑注释行、空行等"非语义行"对索引映射的破坏。
