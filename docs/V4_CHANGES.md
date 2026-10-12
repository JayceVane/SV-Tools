# 4.0.0-alpha1 变更清单

开发 worktree：`C:\Users\JayceVane\.codex\worktrees\svtools-v4\02_svtools`；分支：`codex/refactor-v4`。
基线：`49f54f97119a996991d40a059b01a0ae589e85db`。3.x 原目录继续维护，未复制其未提交内容。

## 验收结果

- Rust 106/106；无告警编译检查及 Rust 格式检查通过。
- JS 语法检查 34 文件；golden 36/36；模块合同 78/78，其中格式化器 31。
- CLI 版本、帮助及 18 组文件/标准输入/检查模式通过。
- VSIX 40 文件、2,064,184 bytes，运行 JS 与 native 产物逐字节一致，无开发资源混入。
- 同 18 个样例、18,848 bytes，预热后交错 5 轮：3.x/4.0 耗时中位 629/541ms，CPU 中位 626/531ms；仅代表该语料。

真实 VS Code 宿主、FPGA 工具工作流及其它平台仍待独立验收；本地 alpha 未发布。

## 逐文件变更

重命名行同时标出旧路径和新路径。未修改逻辑的文件只做目录迁移；删除行指向替代职责。

| 状态 | 文件 | 说明 |
|---|---|---|
| 修改 | [.github/workflows/ci.yml](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/.github/workflows/ci.yml>) | 同步 4.0 原生构建、Rust 和 JS 回归路径。 |
| 修改 | [.github/workflows/release.yml](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/.github/workflows/release.yml>) | 使用锁文件安装，发布 bin 中的原生模块和 CLI。 |
| 修改 | [.gitignore](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/.gitignore>) | 忽略 bin 产物，跟踪依赖锁文件及新增合同测试。 |
| 修改 | [.vscode/launch.json](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/.vscode/launch.json>) | 将开发宿主配置指向新的构建产物布局。 |
| 修改 | [.vscodeignore](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/.vscodeignore>) | 只打包运行资源，排除 Rust 源码、测试和开发依赖。 |
| 新增 | [ARCHITECTURE.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/ARCHITECTURE.md>) | 记录职责边界、词法保护合同、实现方向及尚待验收的范围。 |
| 修改 | [CHANGELOG.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/CHANGELOG.md>) | 解释 4.0 重构动机、行为修复和影响面。 |
| 新增 | [CONTEXT.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/CONTEXT.md>) | 保存 4.0 里程碑、验证结果与后续开发入口。 |
| 修改 | [CONTRIBUTING.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/CONTRIBUTING.md>) | 同步依赖安装、目录结构、格式化与回归约定。 |
| 修改 | [INSTALL.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/INSTALL.md>) | 同步 4.0 安装与原生模块构建路径。 |
| 修改 | [PUBLISH.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/PUBLISH.md>) | 同步 bin 产物与发布打包流程。 |
| 修改 | [README.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/README.md>) | 更新 4.0 结构、构建说明及 CLI 标准输入用法。 |
| 修改 | [docs/FORMAT_SPEC.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/docs/FORMAT_SPEC.md>) | 明确保护区、assign 分组空行和完整管线验收合同。 |
| 新增 | [docs/V4_CHANGES.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/docs/V4_CHANGES.md>) | 汇总逐文件变更与实际验收结果。 |
| 新增 | [docs/bugs/logic-protected-source-through-layout.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/docs/bugs/logic-protected-source-through-layout.md>) | 保存多阶段词法保护缺失的复现、排查和修复证据。 |
| 修改 | [example/target/ex14_consecutive_instances.sv](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/example/target/ex14_consecutive_instances.sv>) | 按规范保留实例与 assign 之间的用户空行。 |
| 修改 | [extension.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/extension.js>) | 保留 VS Code 兼容入口，委托 src/extension.js。 |
| 新增 | [package-lock.json](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/package-lock.json>) | 锁定扩展开发依赖，支持 npm ci。 |
| 修改 | [package.json](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/package.json>) | 切换 4.0 alpha 版本，统一构建、语法检查和合同回归入口。 |
| 修改 | [scripts/build-native.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/scripts/build-native.js>) | 异步复用工具进程 runner，独立构建 napi 与 CLI，复制到 bin。 |
| 新增 | [scripts/check-js.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/scripts/check-js.js>) | 为运行与开发 JavaScript 提供语法检查入口。 |
| 删除 | `src-rust/src/beautifier.rs` | 由 formatter 各职责模块及兼容导出替代。 |
| 删除 | `src-rust/src/tokenizer.rs` | 由共享词法扫描与新 tokenizer 替代。 |
| 新增 | [src/configuration.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/configuration.js>) | 以 manifest 默认值作为配置单一来源。 |
| 新增 | [src/editor/commands.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/editor/commands.js>) | 抽出实例化、testbench 和编辑器命令实现。 |
| 新增 | [src/editor/completion-data.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/editor/completion-data.js>) | 将补全静态数据与 provider 行为分离。 |
| 新增 | [src/editor/formatting.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/editor/formatting.js>) | 独立格式化范围、配置读取与 native 调用适配。 |
| 新增 | [src/editor/language.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/editor/language.js>) | 独立语言符号、定义、补全与 hover provider。 |
| 新增 | [src/extension.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/extension.js>) | 只组装并注册扩展 provider、命令和集成模块。 |
| 新增 | [src/native-loader.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native-loader.js>) | 按平台惰性加载 bin 原生模块，支持依赖注入。 |
| 迁移 | `src-rust/.gitignore` → [src/native/.gitignore](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/.gitignore>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/Cargo.lock` → [src/native/Cargo.lock](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/Cargo.lock>) | 迁移并同步 crate 版本。 |
| 迁移 | `src-rust/Cargo.toml` → [src/native/Cargo.toml](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/Cargo.toml>) | 迁移 crate，使用 svtools-cli target 避免构建产物冲突。 |
| 迁移 | `src-rust/build.rs` → [src/native/build.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/build.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/index.d.ts` → [src/native/index.d.ts](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/index.d.ts>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/index.js` → [src/native/index.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/index.js>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/package-lock.json` → [src/native/package-lock.json](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/package-lock.json>) | 迁移并同步 napi CLI 依赖锁文件。 |
| 迁移 | `src-rust/package.json` → [src/native/package.json](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/package.json>) | 同步 native 版本、构建入口与库输出。 |
| 迁移 | `src-rust/src/align/assign.rs` → [src/native/src/align/assign.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/align/assign.rs>) | 类型化赋值类别，缓存模式；所有布局遍次使用原文 captures。 |
| 迁移 | `src-rust/src/align/decl.rs` → [src/native/src/align/decl.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/align/decl.rs>) | 命名字段与原文 captures 重建声明，保护字面量与维度。 |
| 迁移 | `src-rust/src/align/instance.rs` → [src/native/src/align/instance.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/align/instance.rs>) | 复用共享分隔符和括号扫描，保留实例布局规则。 |
| 迁移 | `src-rust/src/align/mod.rs` → [src/native/src/align/mod.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/align/mod.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/align/module_port.rs` → [src/native/src/align/module_port.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/align/module_port.rs>) | 复用参数/端口扫描并稳定逗号旁注释的归属。 |
| 迁移 | `src-rust/src/align/task_func_param.rs` → [src/native/src/align/task_func_param.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/align/task_func_param.rs>) | 复用参数分隔与括号事实，保留所属构造列宽策略。 |
| 迁移 | `src-rust/src/analyzer/mod.rs` → [src/native/src/analyzer/mod.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/analyzer/mod.rs>) | 迁移设计单元分析，统一代码风格。 |
| 新增 | [src/native/src/beautifier.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/beautifier.rs>) | 兼容重导出新的 formatter 实现。 |
| 新增 | [src/native/src/bindings.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/bindings.rs>) | 分离 napi host 导出与纯格式化核心。 |
| 迁移 | `src-rust/src/blank_rules.rs` → [src/native/src/blank_rules.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/blank_rules.rs>) | 全文词法扫描裁决空行，保留跨行宏和字面量上下文。 |
| 迁移 | `src-rust/src/codegen/align_code.rs` → [src/native/src/codegen/align_code.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/codegen/align_code.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/codegen/header.rs` → [src/native/src/codegen/header.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/codegen/header.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/codegen/mod.rs` → [src/native/src/codegen/mod.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/codegen/mod.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/codegen/module_inst.rs` → [src/native/src/codegen/module_inst.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/codegen/module_inst.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/codegen/repeat.rs` → [src/native/src/codegen/repeat.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/codegen/repeat.rs>) | 迁移重复代码生成并规范 Rust 格式。 |
| 迁移 | `src-rust/src/codegen/testbench.rs` → [src/native/src/codegen/testbench.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/codegen/testbench.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/config.rs` → [src/native/src/config.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/config.rs>) | 统一配置访问，约束缩进和端口列距边界。 |
| 新增 | [src/native/src/formatter/blocks.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/formatter/blocks.rs>) | 负责块提交、构造对齐调用与结束输出。 |
| 新增 | [src/native/src/formatter/instances.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/formatter/instances.rs>) | 集中实例候选分类和参数/端口列表处理。 |
| 新增 | [src/native/src/formatter/layout.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/formatter/layout.rs>) | 负责 token 的空格、缩进与行提交。 |
| 新增 | [src/native/src/formatter/mod.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/formatter/mod.rs>) | 保留小型调度循环，以栈上缓冲替代标点永久分配。 |
| 新增 | [src/native/src/formatter/procedural.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/formatter/procedural.rs>) | 隔离过程赋值的布局与续行规则。 |
| 新增 | [src/native/src/formatter/protected.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/formatter/protected.rs>) | 原文提交字符串、注释、宏和转义标识符。 |
| 新增 | [src/native/src/formatter/session.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/formatter/session.rs>) | 集中一次调用的输出、缩进、续行和词历史状态。 |
| 新增 | [src/native/src/formatter/state.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/formatter/state.rs>) | 用枚举表达语法上下文、块状态与调度动作。 |
| 新增 | [src/native/src/formatter/structure.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/formatter/structure.rs>) | 隔离语句结构分类和上下文推进。 |
| 迁移 | `src-rust/src/lib.rs` → [src/native/src/lib.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/lib.rs>) | 纯格式化管线和模块注册，与 napi 适配分离。 |
| 迁移 | `src-rust/src/main.rs` → [src/native/src/main.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/main.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/parser/comments.rs` → [src/native/src/parser/comments.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/parser/comments.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/parser/mod.rs` → [src/native/src/parser/mod.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/parser/mod.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/parser/module.rs` → [src/native/src/parser/module.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/parser/module.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/parser/patterns.rs` → [src/native/src/parser/patterns.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/parser/patterns.rs>) | 迁移并规范共享正则模式与辅助规则。 |
| 迁移 | `src-rust/src/postprocess.rs` → [src/native/src/postprocess.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/postprocess.rs>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `src-rust/src/preprocess.rs` → [src/native/src/preprocess.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/preprocess.rs>) | 使用共享词法事实，保护 UTF-8 和注释中的控制关键字。 |
| 新增 | [src/native/src/source_scan.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/source_scan.rs>) | 提供 lossless 区间、掩码、分隔符及原文 captures 适配。 |
| 新增 | [src/native/src/tokenizer.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/tokenizer.rs>) | 将保护区作为原子 token，代码区模式惰性缓存。 |
| 迁移 | `iverilog.js` → [src/toolchains/iverilog.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/toolchains/iverilog.js>) | 复用工具进程生命周期，使用共享工作区源码索引。 |
| 新增 | [src/toolchains/process.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/toolchains/process.js>) | 集中 UTF-8 流解码、超时、停止和 Windows 进程树处理。 |
| 迁移 | `xvlog.js` → [src/toolchains/xvlog.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/toolchains/xvlog.js>) | 复用进程 runner 与错误处理，保留引擎诊断适配。 |
| 迁移 | `vivado/index.js` → [src/vivado/index.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/vivado/index.js>) | 迁移 Vivado 集成并同步源码资源路径。 |
| 迁移 | `vivado/parts.js` → [src/vivado/parts.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/vivado/parts.js>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `vivado/projectTree.js` → [src/vivado/projectTree.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/vivado/projectTree.js>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `vivado/reportView.js` → [src/vivado/reportView.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/vivado/reportView.js>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `vivado/scan.js` → [src/vivado/scan.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/vivado/scan.js>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `vivado/structure.js` → [src/vivado/structure.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/vivado/structure.js>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `vivado/tclgen.js` → [src/vivado/tclgen.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/vivado/tclgen.js>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 迁移 | `vivado/toolchain.js` → [src/vivado/toolchain.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/vivado/toolchain.js>) | 以共享进程 runner 执行 Vivado batch。 |
| 迁移 | `vivado/xpr.js` → [src/vivado/xpr.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/vivado/xpr.js>) | 迁移至职责所属源码目录，逻辑保持原样。 |
| 新增 | [src/waveform/index.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/index.js>) | 提供波形模块的统一注册入口。 |
| 新增 | [src/waveform/parser.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/parser.js>) | 分离 VCD 解析，修复单行头与非零 dumpall 时刻处理。 |
| 迁移 | `vcd.js` → [src/waveform/view.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/view.js>) | 迁移波形视图并与 parser 分离。 |
| 新增 | [src/workspace/sources.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/workspace/sources.js>) | 共享设计单元索引，忽略注释/字符串并处理跨行名称。 |
| 新增 | [test/editor_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/editor_test.js>) | 验证格式化适配、配置与 native 加载错误。 |
| 新增 | [test/formatter_contract_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/formatter_contract_test.js>) | 验证配置组合、原文保护、附近代码对齐与幂等性。 |
| 修改 | [test/golden_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/golden_test.js>) | 改由 bin 加载 native，保持全文和幂等比对。 |
| 修改 | [test/render-vcd-badge.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/render-vcd-badge.js>) | 同步视图源码路径，保留徽章样式回归。 |
| 新增 | [test/toolchain_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/toolchain_test.js>) | 验证 UTF-8、BAT 路径、超时、终止和执行错误合同。 |
| 新增 | [test/waveform_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/waveform_test.js>) | 验证 VCD 头、时刻、总线和标量解析。 |
| 新增 | [test/workspace_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/workspace_test.js>) | 验证源码索引、保护区过滤和模块名识别。 |

## 本地产物（不提交）

| 文件 | 用途 |
|---|---|
| `bin/svtools.win32-x64-msvc.node` | Windows x64 原生模块，VSIX 运行依赖。 |
| `bin/svtools.exe` | 复用同一格式化核心的 CLI。 |
| `bin/svtools-4.0.0-alpha1.vsix` | 可安装的本地 alpha 验收包。 |
| `bin/vsix-check.json` | 包清单与 SHA-256 验证记录。 |
| `bin/protection-before-after.json` | 只读比较 3.x/4.0 的保真修复证据。 |
| `ENVIRONMENT.md` | 本机环境、工作目录和命令备忘，已忽略。 |
