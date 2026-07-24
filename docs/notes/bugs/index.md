# Bug Notes Index

| Prefix   | Category              |
|----------|-----------------------|
| `env-`   | Environment & infra   |
| `stab-`  | Numerical stability   |
| `code-`  | Encoding logic        |
| `eng-`   | Engineering           |

## eng- Engineering

| ID | Bug | Root cause | Fix |
|----|-----|-----------|-----|
| [eng-01](eng-01-module-port-comment-panic.md) | 参数列表含注释行时对齐 panic | 用行索引 `i` 访问 `values` 数组，注释行无对应值导致越界 | 引入独立 `param_idx` 计数器，仅在实际处理参数时递增 |

## code- Encoding logic

| ID | Bug | Root cause | Fix |
|----|-----|-----------|-----|
| [code-01](code-01-always-expectelse-endmodule.md) | always 块 ExpectElse 拆分 endmodule + 缩进错误 | `rfind("end")` 误匹配 endmodule；正则缺 `(?m)` 多行模式；未排除 `end` + `state_end` 组合 | 新增 `rfind_standalone_end` 精确匹配；正则加 `(?m)`；增加 `!(w == "end" && state_end)` 守卫 |
