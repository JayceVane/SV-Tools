# compat-yosys-script-arguments

> **发现方式**：真实 YoWASP Yosys 0.69 的 builtin/slang 验证失败；模拟进程测试未暴露。
> **定位耗时**：本轮多次实际调用与最小脚本对照。
> **修复位置**：`src/circuit/yosys-runner.js`，`src/circuit/worker.js` 源位置回映射。

## 症状

真实日志分别出现：

```text
ERROR: Module `"circuit_demo"' not found!
ERROR: Can't open include file `defs.vh'!
ERROR: File `-Ibin/circuit-option-probe/with space' not found or is a directory
```

脚本参数看似正确，但 top 被包含字面引号；带空格 include 路径仍打不开。

## 排查过程

1. 对比生成 JSON 的简单脚本，源文件可读，排除 RTL 或顶层不存在。只给 top 去引号即可详细化。
2. 对 include 尝试 `-I"path space"`、`"-Ipath space"` 和反斜杠转义；不同 token 切分分别把路径尾部或整个选项当作文件，均失败。
3. 用任务内无空格目录链接让 Yosys 使用相对路径；原生文件系统可读，但 WASI 调用仍打不开 include，确定运行时不能直接跟随主机链接。
4. 将 WASI include 目录有界复制到任务目录，builtin 通过。slang 又受单线程 WASI 和 Windows 绝对路径处理影响，改用 `--threads 1`、相对包装文件和相对 include。
5. 单独核对宏表达式 `(1 + 2)` 的网表常量，确认命令行引号可能改变宏正文；改为 HDL 包装文件后 builtin/slang 都得到值 3。

## 根因

Yosys 脚本不是 shell，各 pass 对选项、文件名和引号的处理并不一致；slang 和内建 Verilog 前端也不共享完整参数语义。WASI 文件系统又有独立的路径与线程限制。统一套用 shell 风格转义、或仅检查进程退出码，不能证明生成语义正确。

## 修复

top 先限定普通 HDL 标识符再直接传入 `prep -top`；文件路径只在已验证支持的参数位置加引号。宏和有序源文件改写入独立 `sources.sv` 包装文件，不改用户正文。带空格的 include 配置转换为任务内安全相对别名；原生使用链接，已识别 YoWASP 使用容量受限的副本，拒绝跟随符号链接。

WASI 副本需要额外磁盘空间和时间，因此限制总字节、文件和目录项数并持续检查取消。Worker 将任务快照和目录别名中的源位置回映射到真实文件；显示层不需要理解工具临时路径。外部 JSON 导入仍可使用转义模块名称，生成入口明确限制普通名称。

## 验收与教训

- `scripts/verify-circuit.js` 使用真实工具，检查宏值、参数化层级、存储器、升序总线，再调用 netlistsvg 与 ELK。builtin 和 slang 均通过。
- 单元测试覆盖包装正文、工具语义错误、退出/取消、路径和源位置回映射；不以模拟成功替代外部工具验证。
- 每增加一个前端，先验证其实际 token 规则与运行时文件系统，再决定哪些参数层能复用。
