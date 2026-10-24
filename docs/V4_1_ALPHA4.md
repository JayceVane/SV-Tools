# 4.1.0-alpha4：默认SystemVerilog前端修复

2026-10-16。[草稿PR #11](https://github.com/JayceVane/SV-Tools/pull/11)，分支`codex/feat-circuit-viewer`；原工程master保持4.0 preview。

## 用户可见变化

`svtools.circuit.frontend`默认auto：内置固定Yosys使用Slang，外部Yosys沿用read_verilog -sv；slang/verilog显式配置保留。编译单元及模块内的timeunit/timeprecision保留并交给Slang解析。失败摘要显示具体源码错误，WASI启动警告留在完整日志；带源位置的ERROR即使退出码为0也算失败。

右上角默认Yosys、RTL右键当前文件Vivado、工程面板工程top保持alpha3策略。没有改写用户RTL或设置。最低VS Code仍为1.106；内置编译器及许可证仍是alpha2的固定资源。

## 实际验证

| 检查 | 结果/本地证据（bin不入仓库） |
|---|---|
| JS语法 | 139文件，`circuit-alpha4-package.log` |
| Golden | 38/38，19用例 |
| 既有Node | 512项：511通过，1可选目录重建跳过 |
| 电路Node | 110/110；新增11项，覆盖默认时序声明、内外后端/显式配置矩阵及错误摘要 |
| Rust | 121/121，`circuit-alpha4-rust.log` |
| 真实默认工具链 | auto→内置Slang→netlistsvg→独立模型→ELK；层级、MUX、存储器、异步复位、总线位序、宏/include通过，`circuit-alpha4-e2e/run-dQKXz7/report.json` |
| 用户原文件 | 以原始时序声明和正文编译成功；上升沿、低有效异步装载0、D=1、CLK/复位/Q连接及源位置正确，SHA256未变。`circuit-alpha4-timeunit-auto.log` |
| Qoder解包后运行 | 使用实际Qoder CN IDE的Node24.15.0/Electron42.2.0，包内缺省auto确为read_slang；新网表→Worker→ELK有6个展示节点，源位置和原文件哈希正确。`circuit-alpha4-qoder-packaged.log` |
| 完整UI宿主 | 本轮Qoder验证为Node运行时模式，不计为完整Webview/按钮UI验收；先前VS Code独立宿主仍有安装更新锁限制 |
| 远程CI | Node22/24矩阵，实时结果见上述草稿PR |
| VSIX | 435文件，18,505,995字节；419个运行/工具文件逐字节匹配，已核验默认auto及菜单贡献 |

包：`bin/svtools-4.1.0-alpha4-win32-x64.vsix`。安装后重载窗口；已有版本可将前端显式设为slang后重新从入口生成。

```text
f21f20f8ff2253f897179b0424d6a91ffa2ef37e025fbd19d574e6dd18b487a3
```

根因见[前端调试笔记](bugs/compat-yosys-systemverilog-frontend.md)。Slang将异步复位表示为`$aldff`加AD=0；验收检查语义与连接，不要求不同前端使用同名原语。

## 完整文件清单（相对alpha3）

| 文件 | 修改 |
|---|---|
| `ARCHITECTURE.md` | 在runner集中解析auto前端，错误摘要与完整日志分离 |
| `CHANGELOG.md` | alpha4前端兼容问题、默认行为及影响 |
| `CONTEXT.md` | alpha4交接、用户原文件验证与工程边界 |
| `README.md` | alpha4版本和内置Slang默认说明 |
| `docs/CIRCUIT.md` | auto配置、显式前端覆盖、时序声明与错误提示 |
| `docs/ROADMAP.md` | 进度更新至alpha4 |
| `docs/V4_1_ALPHA4.md` | 本轮交付与完整文件清单 |
| `docs/bugs/compat-yosys-systemverilog-frontend.md` | 旧前端不足、默认入口遗漏与语义验证记录 |
| `package-lock.json` | 扩展版本同步alpha4 |
| `package.json` | alpha4版本，auto前端枚举和默认值 |
| `package.nls.json` | auto前端与外部工具兼容的英文说明 |
| `package.nls.zh-cn.json` | auto前端与外部工具兼容的中文说明 |
| `scripts/verify-circuit.js` | 缺省auto验证真实Yosys→netlistsvg→模型→ELK |
| `src/circuit/source-request.js` | 源请求的缺省前端改为auto |
| `src/circuit/yosys-runner.js` | 内置auto选Slang，外部auto选旧前端，捕获源位置错误并优先摘要 |
| `src/native/Cargo.lock` | crate版本同步alpha4 |
| `src/native/Cargo.toml` | crate版本同步alpha4 |
| `src/native/package-lock.json` | napi版本同步alpha4 |
| `src/native/package.json` | napi版本同步alpha4 |
| `test/circuit_bundled_test.js` | 真实默认前端的编译单元/模块内时序声明、脏正文、异步复位和源位置 |
| `test/circuit_commands_test.js` | 缺省auto配置合同 |
| `test/circuit_pipeline_test.js` | 内外后端与显式前端矩阵、源位置错误与WASI摘要合同 |
