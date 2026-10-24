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
- 打包前全量检查：JS语法174文件，Node566项（565通过，1项官方目录重建可选跳过），电路170/170。
- 解包455文件，439运行文件与源码/原生/vendor逐字节一致。
- 解包后真实Qoder宿主4/4：全文golden、重复执行幂等、选区格式化及对齐命令。
  实际宿主VS Code API1.106.3、Node24.15.0、Electron42.2.0，使用独立用户/扩展/夹具目录。
- 初次宿主验收脚本直接比较Windows文档CRLF与LF golden而失败；归一比较行尾，
  并使用实际文档长度定位选区后，同一安装包通过复验；没有修改产物来迎合测试。

本机证据：bin/beta9-formatter-contracts.log、bin/beta9-node22.log、
bin/beta9-rust.log、bin/beta9-golden.log、bin/beta9-native-build.log、
bin/beta9-package.log、bin/formatter-beta9-package-report.json、bin/beta9-packaged-host.log。
包内真实宿主验收通过bin/verify-beta9-formatter-host.ps1和bin/beta9-formatter-host.js执行。

## 安装包

源码提交`f2027246eff05b670164c9b8f732bceeacbbb263`；后续交付记录提交仅更新文档。
唯一版本入口生成以下产物，详细追溯见bin/svtools-4.0.0-beta.9-win32-x64.manifest.json。

| 文件 | 字节 | SHA256 |
|---|---:|---|
| svtools-4.0.0-beta.9-win32-x64.vsix | 18568622 | `83c2c8a53a50a093e6b2826f36b9f56ad4bd845c70c8959957df11c4172f7927` |
| svtools.exe | 24052224 | `bcc6ecfc529e3f6c6f8fab0283397828a97f26d2fd6ed1279ddb99139962ded1` |
| svtools.win32-x64-msvc.node | 24201728 | `f47734166f66506008194a614c042b13e38551b32353bcf4e2e677178162cc6c` |

未安装到用户现有IDE；使用“从VSIX安装”后重载窗口即可启用修复。

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
