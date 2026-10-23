# 4.0.0-beta.10 多时钟域例化模板修复

独立codex/feat-circuit-viewer分支，基线ad69fdf；原工程保持不变。
本轮使用唯一beta.10预览号，保留beta.9安装包，不自动合并或创建Release。

## 结果与边界

用户cdc_hs_bits原来生成 `.i_clk_b(i_clk_a)`、`.i_rst_n_b(i_rst_n_a)`，
现在分别生成 `.i_clk_b(i_clk_b)`、`.i_rst_n_b(i_rst_n_b)`。
八个端口均逐端口连接同名信号；声明、参数、原端口顺序和实例前缀保持一致。

解析器已正确识别独立域，错误来自生成器把分类列表的首个信号作为所有同类端口的连接。
修复删除该私有替换，直接使用端口原名；没有引入新的名称猜测或别名配置。
Testbench复用同一构造器，额外域信号保持声明，防止更正连接后引用未声明信号。
Testbench仍为激励骨架，额外域的频率、相位和复位时序需按真实设计补充。
诊断过程见[调试笔记](bugs/logic-instance-clock-reset-alias.md)。

## 验证

- 6项NAPI合同中5项在旧版本失败；修复后6/6通过。
- CDC完整端口表、声明开关、参数、前缀、反向配置列表及无关配置项、非ANSI、双向端口均覆盖。
- Rust127/127；修改的两处Rust文件通过rustfmt。
- Node22.20.0例化与编辑器合同20/20。
- 实际用户文件只读生成，八端口连接正确，前后SHA256相同。
- Icarus13真实编译无隐式网线的模板；A/B时钟/复位赋不同电平，DUT六个输入逐项比对通过。
- 完整打包回归、解包校验及真实编辑器命令验证见后续安装包记录。

本机证据：bin/beta10-before-fix.log、bin/beta10-inst-contracts.log、bin/beta10-node22.log、
bin/beta10-rust.log、bin/beta10-instantiation-proof.log、bin/beta10-native-build.log。
最小公开夹具保留用户的端口表与双域事件控制，不作为可用CDC电路实现。
用户完整RTL和临时生成结果不提交，也不改写原文件。

## 修改清单

| 文件 | 内容 |
|---|---|
| src/native/src/codegen/module_inst.rs | 删除首信号替换规则，逐端口原名连接及Rust回归 |
| src/native/src/codegen/testbench.rs | 仅排除已生成声明的主控制信号，保留额外域声明 |
| test/module_inst_test.js | 原生模板连接、声明和Testbench共享路径合同 |
| test/fixtures/codegen/cdc_hs_bits.sv | 用户端口表与双时钟域最小回归夹具 |
| package.json | 加入生成器合同与beta.10版本 |
| package-lock.json | 根包版本同步 |
| src/native/Cargo.toml | beta.10原生及CLI版本 |
| src/native/Cargo.lock | Rust包版本同步 |
| src/native/package.json | 原生构建包版本同步 |
| src/native/package-lock.json | 原生JS包锁版本同步 |
| README.md | 当前预览版本与逐端口连接说明 |
| CHANGELOG.md | beta.10变更与影响面 |
| ARCHITECTURE.md | 区分连接身份和控制信号分类 |
| docs/bugs/logic-instance-clock-reset-alias.md | 根因、共享路径和验证边界 |
| docs/V4_BETA10.md | 交付、验证和逐文件清单 |
| CONTEXT.md | 当前开发状态和交接 |
