# 4.1.0-alpha8：Aurora例化对齐

2026-10-16。独立分支`codex/feat-circuit-viewer`，继续[草稿PR11](https://github.com/JayceVane/SV-Tools/pull/11)；原工程保持4.0 preview，不合并或创建Release。

## 问题与结果

用户的`test_project/sfp_wapper/aurora_64b66b/aurora_64b66b_0_exdes.v`整文件格式化后，支持模块中drp_clk_in仍与其余端口错列；孤立实例却能对齐。generate内多个过程切换后，Always状态未能在Generate上下文正常完成，导致后续实例未进入实例布局。完成判定现补齐Generate；嵌套begin/end仍按真实语法上下文处理。

选区有独立缺陷：分组注释/完整实例头被当成赋值选区，旧赋值正则含Rust regex不支持的前瞻，panic被保全守卫捕获后返回原文。现在由共享词法掩码识别第一条真实代码，用类型枚举派发布局；完整实例复用现有普通段格式化，纯端口表保留括号起始列对齐。赋值用原文左右捕获替代前瞻，不将注释或字符串中的等号当作运算符。

对用户真实文件的支持模块验证了36端口左右括号各自同列，行尾`// (drp_clk_i),`及被注释的连接保持原文。原磁盘文件没有写入：全文、完整实例选区、端口表选区均验证非排版字符序列与幂等；Native和CLI输出逐字节一致。原始SHA256：`bba9568bd2eaf22352d5f2a2357e7f63e2de93714e1d82dcac095758d7460a83`。格式化结果副本在`bin/formatter-alpha8-user-proof/aurora_64b66b_0_exdes.formatted.v`。

## 验证

| 检查 | 结果 / bin本地证据 |
|---|---|
| Rust | 125/125，新增4项；formatter-alpha8-rust.log |
| Rustfmt | 三个修改的Rust文件检查通过 |
| JS语法 | 152文件；formatter-alpha8-package.log |
| Golden | 38/38，19用例 |
| 既有Node | 516项：515通过、1可选目录重建跳过，新增4项 |
| 电路Node | 147/147 |
| 格式化NAPI与保全 | Node24与22.20各73/73，含LF/CRLF、TAB、既有GNU布局、仅缩进与关闭端口对齐；formatter-alpha8-native.log、node22.log |
| 用户原文件 | 36端口，全文/完整实例/端口表，幂等与字符保全，原SHA256不变；formatter-alpha8-user-proof/report.json |
| CLI | 用户原文通过stdin输入，输出与Native逐字节相同 |
| 实际Qoder运行时 | Node24.15.0/Electron42.2.0加载解包后native，复验真实文件的三种入口、幂等和保全；formatter-alpha8-qoder.log |
| VSIX | 442文件、18,523,330字节；426运行文件逐字节相同；circuit-alpha8-package-report.json |
| 远程CI | Node22/24矩阵，最终状态见草稿PR11 |

本轮无界面改动；Qoder验证使用Electron的Node运行时，不宣称完成IDE UI宿主验收。没有放宽字符保全：仅ASCII空格/Tab/CR/LF可以改变。完整实例选区沿用此入口的默认格式化配置和tabSize；纯端口选区沿用起始括号列对齐。没有新增完整SV语法覆盖承诺，也没有把供应商RTL加入公开测试夹具。

## 安装

包：`bin/svtools-4.1.0-alpha8-win32-x64.vsix`。

SHA256：`7e450713c92c3b423e9eb5e4fa6dba83f5893a2d787756c5dcc6a2a8fb419bd9`。

安装后重载窗口，对原文件执行全文格式化；也可以选中完整例化后执行“对齐选中代码”。此前失败的注释分组端口选区现在能正常识别。

## 完整文件清单（相对alpha7）

| 文件 | 修改 |
|---|---|
| `ARCHITECTURE.md` | 说明选区布局复用及Generate过程状态边界 |
| `CHANGELOG.md` | 记录alpha8修复、原因与影响面 |
| `CONTEXT.md` | 本轮复现、真实文件验证及后续交接 |
| `README.md` | 当前开发版本同步alpha8 |
| `docs/ROADMAP.md` | 同步例化对齐修复进度 |
| `docs/V4_1_ALPHA8.md` | 交付结果、边界与完整文件清单 |
| `docs/bugs/logic-instance-after-generate.md` | 记录状态残留和选区误判的两条根因链 |
| `package.json` | 扩展版本alpha8 |
| `package-lock.json` | 根锁版本同步 |
| `src/native/Cargo.toml` | Rust crate版本alpha8 |
| `src/native/Cargo.lock` | Rust锁版本同步 |
| `src/native/package.json` | 原生npm版本alpha8 |
| `src/native/package-lock.json` | 原生npm锁版本同步 |
| `src/native/src/formatter/procedural.rs` | 在Generate上下文完成并提交always过程 |
| `src/native/src/formatter/instances.rs` | 全文generate后实例的Rust回归 |
| `src/native/src/codegen/align_code.rs` | 首个真实代码分类、复用实例布局、安全赋值捕获及三个Rust回归 |
| `test/formatter_contract_test.js` | 四个NAPI回归与换行/选项/字符保全/幂等矩阵 |

安装包、原生二进制、用户文件结果副本及调试证据均位于已忽略的bin/，不提交。
