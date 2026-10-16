# 4.1.0-alpha6：当前文件编译上下文

2026-10-16。[草稿PR11](https://github.com/JayceVane/SV-Tools/pull/11)，独立分支`codex/feat-circuit-viewer`；原工程仍为4.0 preview。

## 用户问题与结果

原错误是Slang详细化失败，完整日志指向不可见的impl_t；该类型在corelib_pkg中，原模块没有导入或限定名称，而且把字符串用作枚举默认值。用户改为字符串参数后，后续错误明确为half_adder未定义：旧Yosys入口只编译当前文件。

alpha6默认自动发现当前工作区文件夹的SV/Verilog候选，在Worker中复用语义解析，收集模块、接口和包的文件闭包。依赖先于使用方，不要求文件名等于模块名；重复定义报错，字面include防止重复独立读入。显式sources保留用户顺序，当前文件未列出时追加，不进行自动发现。

选中脏依赖使用独立编号目录的快照，同名文件不会覆盖；模型与错误摘要共用源路径回映射。具体源码诊断优先通用ERROR，不受stdout/stderr到达先后影响；启动、日志写入和取消错误继续保留。

已用用户当前磁盘上的字符串版full_adder直接只读生成，并用**实际Qoder运行时加载解包后的alpha6**复验。默认设置自动选择：

```text
src/basic/half_adder.sv
src/basic/full_adder.sv
```

网表保留两个half_adder实例，ELK图8节点，原文件SHA256未变。没有写入用户RTL、设置或XPR。证据：`bin/circuit-alpha6-user-proof/report.json`、`circuit-alpha6-qoder-packaged.log`。

## 标准与兼容边界

自动收集只选择文件，不执行宏、条件编译或generate；最终语义仍由Slang判断。不会自动注入import、猜测未限定的类型归属、把字符串改为枚举或失败后换前端。包限定名、import以及参数化/generate实例能够用于依赖收集，接口和modport端口也有回归。

自动候选仅`.sv/.v`，限制当前工作区根及真实文件路径，排除工具快照与依赖目录；4096文件、单文件2 MiB、总量32 MiB，Worker堆384 MiB/60秒。超限、非法UTF-8、外部链接或复杂预处理上下文使用显式sources/includeDirs。当前文件及选中脏依赖单文件快照16 MiB、总量64 MiB。旧JSON、布局、渲染与编译超时预算保持。

正确枚举示例位于`test/fixtures/circuit-enum/`：参数类型为`corelib_pkg::impl_t`，默认值与比较使用`corelib_pkg::STRUCTURAL/FLAT`。已验证真实Slang会拒绝不可见类型、字符串赋枚举及缺少半加器三类情况；自动收集正确示例后保留两个独立参数化实现和结构分支的两个半加器，flatten后由Yosys eval检查全部8组输入。

依据与复验：[Slang输入/库文件机制](https://www.sv-lang.com/user-manual.html)、[Yosys设计加载与前端](https://yosyshq.readthedocs.io/projects/yosys/en/latest/using_yosys/more_scripting/load_design.html)。本插件的自动闭包由自己的源上下文服务提供，不宣称编译器会凭目录自动读取所有文件。

```powershell
node scripts/verify-circuit-enum.js
node scripts/verify-circuit-enum.js --extension-root <解包的extension目录>
node --test test/circuit_dependencies_test.js test/circuit_diagnostics_test.js
```

## 验证

| 检查 | 结果 / bin本地证据 |
|---|---|
| JS语法 | 150文件；`circuit-alpha6-package.log` |
| Golden | 38/38，19用例 |
| 既有Node | 512项：511通过，1可选目录重建跳过 |
| 电路Node | 137/137，较alpha5新增19项 |
| Rust | 121/121；`circuit-alpha6-rust.log` |
| 真实枚举与自动源闭包 | 三类失败、四文件顺序、层级、源位置及8组完整真值表通过；`circuit-alpha6-enum-auto.log` |
| 解包后Qoder | Node24.15.0/Electron42.2.0执行自动源闭包、内置Slang、Worker/ELK和真值表；用户当前全加器只读生成通过；包内原生ABI可加载 |
| VSIX | 441文件、18,518,179字节；425个运行文件逐字节一致；`circuit-alpha6-package-report.json` |
| 依赖与质量 | 无循环依赖；新四模块MI为43.21/29.38/48.75/44.52，无新增模块复杂度热点 |
| 远程CI | Node22/24矩阵，最终状态见草稿PR11 |

Qoder的Node运行时模式不等于完整Webview宿主验收；本轮未重跑完整IDE UI。画布及工具入口沿用alpha5，功能回归包含既有渲染交互合同。

包：`bin/svtools-4.1.0-alpha6-win32-x64.vsix`，安装后重载窗口并重新点击当前文件的电路按钮。保持默认空sources即可自动找到半加器；已有非空sources按显式列表处理。

```text
42dc26dd0458cf267bda242cf284589473d20b99117e95454ffac10f3d1fd748
```

## 完整文件清单（相对alpha5）

| 文件 | 修改 |
|---|---|
| `.gitignore` | 纳入四个公开枚举RTL夹具，继续排除其他生成物 |
| `ARCHITECTURE.md` | 自动编译上下文、快照与共享源映射职责 |
| `CHANGELOG.md` | alpha6行为与边界 |
| `CONTEXT.md` | 本轮用户问题、验证及交接 |
| `README.md` | alpha6版本和自动源依赖说明 |
| `docs/CIRCUIT.md` | 默认闭包、显式覆盖、预算和诊断操作说明 |
| `docs/ROADMAP.md` | 当前进展同步alpha6 |
| `docs/V4_1_ALPHA6.md` | 交付数据、边界与完整清单 |
| `docs/bugs/logic-circuit-source-context.md` | 类型、依赖和摘要优先级的排查链 |
| `package.json` | 扩展版本alpha6 |
| `package-lock.json` | 扩展锁版本同步 |
| `package.nls.json` | 自动与显式sources的英文说明 |
| `package.nls.zh-cn.json` | 自动与显式sources的中文说明 |
| `scripts/verify-circuit-enum.js` | 真实编译、自动闭包、层级与8组求值复验 |
| `src/circuit/index.js` | 当前文件命令接入源上下文适配器 |
| `src/circuit/source-context.js` | VS Code发现、取消、调用时正文与Worker适配 |
| `src/circuit/source-dependencies.js` | 有界模块/接口/包文件闭包、include与歧义处理 |
| `src/circuit/source-paths.js` | 统一任务目录与脏快照的路径回映射 |
| `src/circuit/source-request.js` | 自动/显式上下文与多文件脏快照装配 |
| `src/circuit/worker.js` | 源闭包命令及共享定位映射 |
| `src/circuit/yosys-diagnostics.js` | 有界具体源码错误优先级、路径与提示 |
| `src/circuit/yosys-runner.js` | runner接入诊断收集器 |
| `src/native/Cargo.toml` | crate版本同步，Rust实现不变 |
| `src/native/Cargo.lock` | crate锁版本同步 |
| `src/native/package.json` | napi版本同步 |
| `src/native/package-lock.json` | napi锁版本同步 |
| `test/circuit_bundled_test.js` | 实际Slang枚举/依赖/真值表回归 |
| `test/circuit_commands_test.js` | 菜单默认自动包含子模块请求 |
| `test/circuit_dependencies_test.js` | 闭包、包、接口、include、歧义、预算、取消与脏快照 |
| `test/circuit_diagnostics_test.js` | 错误流先后、Windows行列、ANSI与路径映射 |
| `test/circuit_pipeline_test.js` | 通用ERROR先出现时仍显示真实源码错误 |
| `test/fixtures/circuit-enum/corelib_pkg.sv` | 标准枚举包 |
| `test/fixtures/circuit-enum/half_adder.sv` | 半加器公开夹具 |
| `test/fixtures/circuit-enum/full_adder.sv` | 包限定名和两种generate实现 |
| `test/fixtures/circuit-enum/top.sv` | 同时实例化两种枚举配置 |
