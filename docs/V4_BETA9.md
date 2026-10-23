# 4.0.0-beta.9 跨行参数例化修复

本轮继续独立worktree和codex/feat-circuit-viewer，基线49cbdfa。
原D:/Workspace/FPGA/02_svtools未修改，beta.8安装包保留；不自动合并或创建Release。

## 修复结果

`cdc_1bit #( .CDC_LEVEL(CDC_LEVEL)` 的参数右括号另起一行时，
即使前面有分组注释和空行，也能对齐后续端口，并将 `);` 恢复到实例所在缩进。
默认参数策略保持原有紧凑结果；关闭paramOneLine时按既有规则分行。

结构识别原本已得到完整实例；缓冲区起点定位却只检测单独物理行，漏掉跨行头，
使前置注释进入实例布局器并保守返回。候选起点现在检查完整代码后缀，
继续复用原有识别式及词法掩码；输出从原文切片取值。

字符保全守卫不变，只允许改变ASCII空格、Tab、CR、LF。
用户语料中的重复实例名和信号连接按原文保留，格式化不承担RTL功能纠错。
诊断过程见[调试笔记](bugs/logic-split-instance-prefix.md)。

## 验证

- 新增NAPI回归在修复前可捕获漏对齐，修复后通过。
- 格式化/保全合同75/75；Node22.20.0同样75/75。
- Rust126/126；两处Rust修改通过rustfmt检查。
- Golden21语料42/42断言；新增ex19为用户完整模块，输出已人工核对。
- CLI与NAPI golden逐字节一致，stderr为空，非布局字符序列一致。
- 组合覆盖LF/CRLF、行/块注释、Tab、参数分行、关闭端口对齐、关闭行内紧凑。
- 完整打包回归及解包后的真实IDE验收见后续安装包记录。

本机证据：bin/beta9-formatter-contracts.log、bin/beta9-node22.log、
bin/beta9-rust.log、bin/beta9-golden.log、bin/beta9-native-build.log。

## 修改清单

| 文件 | 内容 |
|---|---|
| src/native/src/formatter/blocks.rs | 起点识别读取完整后缀并过滤非实例头 |
| src/native/src/formatter/instances.rs | 跨行参数与前置注释的Rust最小回归 |
| test/formatter_contract_test.js | NAPI正文和选区合同，验证对齐、字符保全及幂等 |
| example/ex19_split_instance_parameters.sv | 用户完整CDC模块回归输入 |
| example/target/ex19_split_instance_parameters.sv | 人工核对的golden输出 |
| docs/FORMAT_SPEC.md | 记录跨行参数与分组注释的布局合同 |
| docs/bugs/logic-split-instance-prefix.md | 根因及定位过程 |
| package.json | beta.9扩展版本 |
| package-lock.json | 根包版本同步 |
| src/native/Cargo.toml | beta.9原生及CLI版本 |
| src/native/Cargo.lock | Rust包版本同步 |
| src/native/package.json | 原生构建包版本同步 |
| src/native/package-lock.json | 原生JS包锁版本同步 |
| README.md | 当前预览版本与修复摘要 |
| CHANGELOG.md | beta.9变更说明 |
| CONTEXT.md | 当前开发状态与验证交接 |
| docs/V4_BETA9.md | 本轮交付、验证和逐文件清单 |
