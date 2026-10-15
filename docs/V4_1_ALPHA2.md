# 4.1.0-alpha2：离线 Yosys 与两个 Vivado top 策略

日期：2026-10-16。工作分支 `codex/feat-circuit-viewer`，[草稿 PR #11](https://github.com/JayceVane/SV-Tools/pull/11)。原工程 master 保留已发布的 4.0.0-preview.1；本轮不合入、不另发 GitHub Release。

## 用户可见变化

- RTL 编辑器右键用内置 Yosys 查看，默认无需 Python、系统 PATH、外部安装或运行时下载。仍可将 `svtools.circuit.yosysPath` 改为外部工具。
- 编辑器右上角“查看当前文件电路（Vivado）”按文件同名模块→唯一模块→选择列表确定 top，只对本次查看覆盖。
- Vivado 工程面板及 top 节点的查看入口使用工程 top，当前文件入口不修改它。
- JSON 导入不再混入 RTL 子菜单；旧命令绑定收到 RTL URI 也转入生成。误选正文得到正确入口提示，不再直接显示 `Unexpected token '/'`。

Vivado 当前文件必须已保存且属于所选工程综合源。只读模式不允许临时增删文件或项目属性；因此本轮明确拒绝脏正文和工程外文件，不静默保存、加入或显示旧版。未保存正文可用内置 Yosys。操作与配置见 [CIRCUIT.md](CIRCUIT.md)。

## 实际验证

| 检查 | 结果与本地证据（`bin/`，不入仓库） |
|---|---|
| JS 语法 | 139 文件，`circuit-alpha2-package.log` |
| Golden | 19 用例、38/38 断言 |
| 既有 Node | 511 项：510 通过、1 项可选目录重建跳过、0 失败 |
| 电路 Node | 96/96，Node24与Node20均通过；`circuit-alpha2-node20.log` |
| Rust | 121/121，`circuit-alpha2-rust.log` |
| 真实内置 Yosys | 固定0.68.1207，Node16/20/24成功编译；`circuit-bundled-node16.log`、`circuit-bundled-node20.log`、`circuit-bundled-proof.log` |
| builtin/slang | PATH为空、中文/空格路径、工作区外源文件、宏、相对readmem、未保存快照→原文件映射均通过；`circuit-bundled-regression-final.log` |
| 真实 Vivado | 2022.1.2，工程top=top为14单元/6端口，文件top=leaf为6单元/4端口；工程外文件拒绝，三次执行后工程/源码均未变，`vivado-circuit-top-validation/run-LC30oW/report.json` |
| 解包后编译 | 使用包内JS/WASM与VS Code实际Code.exe的Node模式生成新JSON，再由包内Worker/ELK处理；`circuit-alpha2-packaged-backend.log` |
| 用户工程磁盘 | 用公开RTL夹具在D盘工作区生成并验证源位置，不读取或修改用户RTL；`circuit-alpha2-project-backend.log` |
| 发布包 | 435文件、18,503,892字节，419个运行/工具文件逐字节匹配；包内native格式化/符号解析通过，CLI版本4.1.0-alpha2 |
| 真正UI宿主 | **环境阻挡**：VS Code更新互斥锁仍被安装器持有，等待30秒后拒绝启动，`circuit-alpha2-host.log` |

包：`bin/svtools-4.1.0-alpha2-win32-x64.vsix`，SHA256：

```text
0ccf4aec65441fd93542fb1a75a46799e5bd9a601d1694ea914ae8fc07b07744
```

完整包核验为 `circuit-alpha2-package-report.json`。真正UI宿主与Electron-as-Node编译是两项不同的验证，本轮只通过后者；安装器完成后可用 `scripts/verify-circuit-host.ps1 -CodePath <Code.exe> -ExtensionPath <解包extension目录>` 复验，不绕过更新保护。

内置二进制与share来自固定npm包，原始文件未改写；构建生成core与resource tar的SHA256清单，分发完整许可和原资源声明。不将WASI或独立进程宣称为安全沙箱。解析/展示预算仍遵守alpha1合同，未新增逻辑锥或大网表分页。

## 完整文件清单（相对alpha1）

| 文件 | 改动 |
|---|---|
| `.vscodeignore` | 分发内置引擎，许可只保留运行位置的一份 |
| `ARCHITECTURE.md` | 内置编译进程、guest映射与两个top策略 |
| `CHANGELOG.md` | alpha2动机、行为和影响 |
| `CONTEXT.md` | 当前交接、回归和真实宿主缺口 |
| `NOTICE` | 内置Yosys及静态依赖的许可位置 |
| `README.md` | alpha2版本与无需外部安装的入口 |
| `docs/CIRCUIT.md` | 默认引擎、五命令与只读Vivado要求 |
| `docs/ROADMAP.md` | 标记内置引擎和top策略完成 |
| `docs/V4_1_ALPHA2.md` | 本轮交付、验证和清单 |
| `docs/bugs/logic-circuit-context-resource-routing.md` | 右键URI误路由与缺工具根因 |
| `docs/bugs/compat-yosys-wasi-source-mapping.md` | Slang相对guest路径与快照两级回映射 |
| `package.json` | alpha2、标题栏/工程入口、默认bundled、固定开发依赖 |
| `package-lock.json` | 固定YoWASP与tar-stream构建依赖 |
| `package.nls.json` | 五命令与内置后端英文文案 |
| `package.nls.zh-cn.json` | 明确当前文件/工程top/JSON与内置后端文案 |
| `scripts/build-circuit-assets.js` | 有界解包、复制WASM与许可、构建校验清单 |
| `scripts/verify-circuit.js` | 默认验证内置引擎，仍可覆盖外部工具 |
| `scripts/verify-circuit-vivado.js` | 同工程两种top与只读失败场景真实验证 |
| `src/circuit/index.js` | 类型路由、文件top选择、dirty拒绝、五命令 |
| `src/circuit/licenses/yosys-NOTICES.txt` | 上游版权、许可与固定源码引用，保留上游文本格式 |
| `src/circuit/vivado-export.js` | 安全传递可选top/sourcePath |
| `src/circuit/vivado-export.tcl` | 只校验工程成员，-top仅覆盖本次详细化 |
| `src/circuit/vivado-runner.js` | 当前文件/显式top参数验证及生命周期 |
| `src/circuit/worker.js` | 可操作JSON错误与guest→host→原文件回映射 |
| `src/circuit/yosys-bundled.js` | 源/include/任务路径映射与独立启动配置 |
| `src/circuit/yosys-runner.js` | 默认WASM分派，保留外部后端及ENOENT提示 |
| `src/circuit/yosys-wasi.js` | 独立Node加载、资源校验与WASI执行 |
| `src/native/Cargo.lock` | 版本同步alpha2 |
| `src/native/Cargo.toml` | crate版本同步 |
| `src/native/package-lock.json` | napi锁版本同步 |
| `src/native/package.json` | napi包版本同步 |
| `test/circuit_bundled_test.js` | 真实无PATH编译、两个前端、readmem与脏正文回映射 |
| `test/circuit_commands_test.js` | 真实注册/Worker/ELK与入口/top/取消/错误策略 |
| `test/circuit_pipeline_test.js` | 缺工具消息、YoWASP cmd目录快照 |
| `test/circuit_session_test.js` | 错选RTL时的导入提示 |
| `test/circuit_vivado_runner_test.js` | 可选top/sourcePath合同 |
| `test/circuit_vivado_test.js` | 无项目写命令、top覆盖与只读源校验 |
| `test/vscode_circuit_host.js` | 五命令、dirty拒绝及默认内置引擎的宿主断言 |
