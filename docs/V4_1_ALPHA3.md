# 4.1.0-alpha3：Vivado独立文件详细化与默认入口修正

2026-10-16。分支`codex/feat-circuit-viewer`，[草稿PR #11](https://github.com/JayceVane/SV-Tools/pull/11)。原master保持已发布4.0 preview。

## 用户可见行为

- 编辑器右上角默认使用内置Yosys。
- RTL右键使用Vivado查看当前文件模块；工程管理面板沿用工程top。
- 已加入工程却未被旧top引用的模块可正常详细化。原工程只读，top与编译顺序只在任务副本中重建。
- 失败提示优先显示具体Synth诊断，Tcl中文错误和中文/空格路径不依赖Windows默认代码页。

当前文件仍要求已保存且属于工程综合源；未保存或工程外文件使用Yosys，或先加入工程并保存。副本在电路任务目录，排除旧run结果。最低VS Code仍为1.106。

## 实际验证

| 检查 | 结果/本地证据（bin不入仓库） |
|---|---|
| JS语法 | 139文件，`circuit-alpha3-package.log` |
| Golden | 38/38，19用例 |
| 既有Node | 512项，511通过、1可选目录重建跳过 |
| 电路Node | 99/99，新增具体错误、Unicode脚本、中文错误协议合同 |
| Rust | 121/121，`circuit-alpha3-rust.log` |
| 真实Vivado | 2022.1.2；工程top=top（14单元/6端口）；文件top=leaf（6单元/4端口）, unreferenced（1单元/3端口）；工程外文件中文拒绝，工程树和源内容逐次保持不变。`vivado-circuit-alpha3/run-pjIY7o/report.json` |
| 用户报错工程 | 以当前文件top成功详细化，2单元/3端口；原XPR及源码SHA256均未变。`circuit-alpha3-user-case.log`，私人路径/工程不入仓库 |
| 解包后编译 | 实际Code.exe的Node模式，包内Yosys生成新网表→Worker→ELK通过。`circuit-alpha3-packaged-backend.log` |
| VSIX | 435文件，18,505,438字节；419项运行文件逐字节相同，包内标题栏与右键贡献已核验 |
| 真正UI宿主 | 已知VS Code安装器与更新锁仍在；未绕过，保留该环境限制，不将Node模式测试算作完整UI宿主通过 |
| 远程CI | Node22/24矩阵；实时结果见上述草稿PR |

包：`bin/svtools-4.1.0-alpha3-win32-x64.vsix`；CLI版本`4.1.0-alpha3`。

```text
b410483389d6e9f5ba4d97e175f090257c3b6784566e1bf48ef16f0e27631491
```

详细根因见[调试笔记](bugs/logic-vivado-file-top-compile-order.md)。内置Yosys及许可沿用alpha2固定版本。

## 完整修改文件（相对alpha2）

| 文件 | 修改 |
|---|---|
| `ARCHITECTURE.md` | 原工程只读与任务副本重建top/编译顺序的边界 |
| `CHANGELOG.md` | alpha3修复原因、行为与影响 |
| `CONTEXT.md` | alpha3交接与原工程保护边界 |
| `README.md` | alpha3安装版本及标题栏/右键入口说明 |
| `docs/CIRCUIT.md` | Yosys默认入口、Vivado任务副本、具体错误提示 |
| `docs/ROADMAP.md` | 当前进度更新为alpha3 |
| `docs/V4_1_ALPHA3.md` | 本轮完整交付、验证证据与文件清单 |
| `docs/bugs/logic-vivado-file-top-compile-order.md` | 根因、公开复现、Windows Tcl编码陷阱与修复取舍 |
| `package-lock.json` | 扩展版本同步 |
| `package.json` | alpha3版本、标题栏Yosys、RTL右键当前文件Vivado |
| `scripts/verify-circuit-vivado.js` | 新增未引用模块、中文空格路径、每次导出后原文件比对 |
| `src/circuit/vivado-export.js` | 显式UTF-8导出器、ASCII参数与有界UTF-8错误协议 |
| `src/circuit/vivado-export.tcl` | 在任务副本重设top并更新编译列表 |
| `src/circuit/vivado-runner.js` | 优先具体工具错误并解码Tcl错误协议 |
| `src/native/Cargo.lock` | 原生crate版本同步alpha3 |
| `src/native/Cargo.toml` | 原生crate版本同步alpha3 |
| `src/native/package-lock.json` | napi版本同步alpha3 |
| `src/native/package.json` | napi版本同步alpha3 |
| `test/circuit_commands_test.js` | 标题栏/右键/工程top的入口合同 |
| `test/circuit_vivado_runner_test.js` | 具体Synth错误优先、中文错误与日志保留 |
| `test/circuit_vivado_test.js` | 原工程保护、UTF-8脚本与Unicode路径合同 |
