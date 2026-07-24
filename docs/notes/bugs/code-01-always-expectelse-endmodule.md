# Bug code-01: always 块 ExpectElse 处理导致 endmodule 拆分和缩进错误

> **Severity**: 高
> **How discovered**: 格式化含 `always @(posedge clk) if (...) begin ... end`（无 else）的模块时，`endmodule` 被拆成 `end` + `module`，后续代码缩进全部错乱
> **Fixed in**: `src-rust/src/beautifier.rs` — ExpectElse 分支逻辑 + 新增 `rfind_standalone_end`

## Symptom

格式化以下代码时产生两个错误：

```systemverilog
module test (input clk, input rst, output reg data);
    always @(posedge clk)
        if (rst) begin
            data <= 1'b0;
        end

    assign x = 1;
endmodule
```

**错误 1**：`endmodule` 被拆分为 `end` 和 `module` 两行：

```systemverilog
    end

module  // ← endmodule 被拆开
```

**错误 2**：`assign x = 1;` 的缩进层级错误，不在 module body 层级（应为 4 空格）。

## Root cause

问题出在 beautifier 的 `AlwaysState::ExpectElse` 状态机分支。当 always 块中的 if 语句以 `end` 结束但没有 `else` 时，状态机进入 ExpectElse 等待可能的 else。当下一个非空 token 到来时，需要"回填"（flush）之前积累的 block 并处理新 token。此分支存在三个缺陷：

### 缺陷 1：`rfind("end")` 误匹配复合关键字

```rust
// 修复前
let last_end = block.rfind("end").map(|p| p + 3).unwrap_or(0);
```

`rfind("end")` 是纯子串搜索，会匹配 `endmodule`、`endtask`、`endfunction` 中的 `"end"` 部分。当 block 末尾是 `endmodule` 时，`rfind` 返回的是 `endmodule` 中 `"end"` 的位置，`split_pos` 指向 `"module"` 的开头，导致 `endmodule` 被从中间切开。

### 缺陷 2：正则缺少多行模式

```rust
// 修复前
let re_indent = Regex::new(&format!("^{}", self.indent)).unwrap();
```

`^` 在 Rust regex 中默认只匹配字符串开头，不匹配每行开头。当 `line` 包含多行时，只有第一行的缩进被移除，后续行保留了多余的缩进层级。

### 缺陷 3：未排除 `end` + `state_end` 组合

当当前 token 是 `end` 且 `state_end` 为 true（表示这是一个完整的 `end` 关键字），不应进入 ExpectElse 回填逻辑，而应走正常的 end 处理路径。缺少这个守卫导致 `end` 被错误地当作"else 之后的新语句"处理。

## Fix

三处修改：

**1. 新增 `rfind_standalone_end` 方法**，精确匹配独立的 `end` 关键字：

```rust
fn rfind_standalone_end(s: &str) -> Option<usize> {
    let mut search_from = s.len();
    while let Some(pos) = s[..search_from].rfind("end") {
        let before_ok = pos == 0
            || { let b = s.as_bytes()[pos - 1]; !b.is_ascii_alphanumeric() && b != b'_' };
        let after_pos = pos + 3;
        let after_ok = after_pos >= s.len()
            || { let b = s.as_bytes()[after_pos]; !b.is_ascii_alphanumeric() && b != b'_' };
        if before_ok && after_ok { return Some(pos); }
        search_from = pos;
    }
    None
}
```

通过检查 `end` 前后字符是否为非标识符字符，排除 `endmodule`、`backend` 等误匹配。

**2. 正则加 `(?m)` 多行标志**：

```rust
// 修复后
let re_indent = Regex::new(&format!("(?m)^{}", self.indent)).unwrap();
```

**3. 增加守卫条件**：

```rust
} else if matches!(current_always_state, AlwaysState::ExpectElse)
    && !w.trim().is_empty()
    && w != "/"
    && !(w == "end" && state_end)  // ← 新增
{
```

## Lessons

- **子串搜索 ≠ 关键字匹配**：在 HDL 格式化器中，`end` 是 `endmodule`/`endtask`/`endfunction`/`endcase` 等复合关键字的前缀。任何对 `end` 的搜索都必须做词边界检查，否则会在最意想不到的地方切开代码。
- **Rust regex 的 `^` 默认不匹配行首**：与很多其他语言/工具不同，Rust `regex` crate 中 `^` 只匹配整个字符串的开头，需要 `(?m)` 才能匹配每行开头。多行文本处理时务必确认。
- **状态机的每个入口都需要完整的守卫条件**：ExpectElse 分支的触发条件只检查了"非空"和"非 `/`"，没有排除 `end` 关键字本身。状态机分支的入口条件越严格，越不容易在边界 case 上出错。
