# 4.0.0-alpha4：工具链任务与日志可靠性

2026-10-13。开发目录 `C:\Users\JayceVane\.codex\worktrees\svtools-v4\02_svtools`，
分支 `codex/refactor-v4`。3.x 保持在原目录。本轮完成结果真实性、任务隔离/取消与日志
预算三项稳定性改造；统一编译计划、增量源码索引仍是后续工作。

## 行为与分工

主文件零错误不再等于整个任务通过：所有依赖错误、失败退出、启动失败、超时、日志
故障与不完整诊断均影响成败。success/failed/cancelled/skipped 分别表示实际状态；
无 module 的详细化不会假装成功。Vivado 日志中 ERROR 即使退出码为 0 也使任务失败，
真实退出码与供旧调用者使用的兼容 code 同时提供。

任务注册先于目录准备和工具探测，停止覆盖编译阶段；不同任务使用独立 .prj、xsim.dir、
源码快照和 vvp。新请求取代旧请求，修改/关闭文档和切换配置取消旧任务，过期输出不
覆盖新诊断或自动打开波形。诊断按触发文档拥有与合并，清掉一个文档不抹掉另一个文档
的依赖错误。不同资源的配置探测可并发，迟到结果不会污染另一配置的缓存。

进程生命周期、UTF-8 输出与日志、任务所有权、诊断/结果、引擎编排、编辑器接线分别
负责。长输出逐行捕获错误和缺失单元，完整日志带背压写盘；内存摘要、诊断与可见输出
有上限，超过诊断预算不能称为通过。仅成功仿真后实际变化的波形进入自动查看流程，
避免打开旧波形或失败的部分产物。具体操作、目录、预算和取舍见 `TOOLCHAINS.md`。

## 验证与交付

- `npm test`：63 个 JS 文件语法检查、golden 36/36、Node 合同 218/218。
  新增 49 项：输出/日志 27，任务与编辑器边界 22；原有波形 94 项继续通过。
- 合同使用真实 Node 协议子进程，覆盖取消前/中/排队、编译停止、快速替换、文档变化、
  释放扩展、脏文档快照隔离、依赖诊断归属、多配置探测竞争、早期错误、背压、日志故障、
  超长行/诊断预算、非零退出、部分波形与未改变波形。编辑器使用显式 API 边界夹具。
- Rust 112/112；native 与 CLI 重新构建，CLI 报告 `svtools 4.0.0-alpha4`。
- `scripts/verify-toolchains.js` 使用本机 Icarus 13.0 与 Vivado 2022.1.2 实际验证：
  Icarus 编译/vvp/VCD 成功；xvlog/xelab 成功；xvlog 依赖错误为主文件 0 错误、总计
  3 错误且任务失败；Vivado ERROR + exit 0 为失败且保留项目标记。
  最终报告为 `bin/toolchain-native-validation/run-roXGGr/report.json`，阶段日志位于其中。
- 占位/错误处理扫描在工具链和 batch 未报告 Blocker/Critical；6 项命名 Warning 涉及
  `data` 事件名、厂商 `data` 路径和 UVM 标识符，经人工检查未改动其外部约定。
- R1–R6 阈值扫描原始报告有 7 个 Critical：controller 回调汇总的 R1/R4、三个组合模块
  扇出、两项不同单位/资源的同值预算。已逐项按实际职责复核，无确认的 Blocker/Critical；
  同一编译超时的真实重复已集中为 compile-policy。保留原始报告与说明，不以评分宣称
  架构质量。接线集中度继续作为后续扩展的约束，见 `ARCHITECTURE.md`。
- VSIX：`bin/svtools-4.0.0-alpha4.vsix`，61 文件、2,096,963 bytes。
  SHA256：`1101e6b06ce4cd13d9f204733eb98b5c2171ce2b59530a9662c1c4dfa798bb23`。
  44 个运行 JS/CSS、扩展入口与 native 与当前构建逐字节一致；无测试、VCD、日志、CLI、
  Rust 源码或开发依赖。校验结果在 `bin/toolchain-alpha4-package-check.json`。

最终打包重新运行全部 JS/golden/Node 回归，日志为 `bin/toolchain-alpha4-package.log`；
Rust 日志 `bin/toolchain-alpha4-rust.log`，真实工具日志 `bin/toolchain-alpha4-native-final.log`，
静态报告 `bin/toolchain-alpha4-risk.json` 与 `bin/toolchain-alpha4-ai-scan.json`。

真实 VS Code 扩展宿主完整操作与其它平台尚需安装包验收。本轮没有重新测量大 VCD，
保留 alpha2/3 的性能与 memory 验收边界。xvlog 跨任务缓存暂不共享，阶段日志和仿真
产物保留后会累积磁盘占用；目前没有保留期或自动删除策略。本版本只保存本地提交和
安装包，未安装、推送、合并或发布。FSDB 开发保持取消，二维 mem 功能继续保留。

## 完整文件清单

相对路径均以本 worktree 为根；构建、日志与本机 ENVIRONMENT.md 已忽略。

| 文件 | 本轮变更 |
|---|---|
| `ARCHITECTURE.md` | 更新任务/进程/日志/引擎/编辑器边界及 R1–R6 原因与取舍。 |
| `CHANGELOG.md` | 记录 alpha4 行为、动机与兼容影响。 |
| `CONTEXT.md` | 更新版本、验证及下一轮范围。 |
| `README.md` | 开发版本指向 alpha4。 |
| `docs/TOOLCHAINS.md` | 操作、任务目录、日志预算、资源和后续边界。 |
| `docs/V4_ALPHA4.md` | 本轮实施、证据、安装包与完整文件清单。 |
| `docs/bugs/logic-toolchain-false-success-and-shared-artifacts.md` | 假成功、共享产物与流式诊断的根因及取舍。 |
| `package.json` | alpha4 版本，注册两组工具链合同。 |
| `package-lock.json` | 同步根包版本。 |
| `src/native/package.json` | 同步 native 包版本。 |
| `src/native/package-lock.json` | 同步 native 锁定版本。 |
| `src/native/Cargo.toml` | 同步 Rust 与 CLI 版本。 |
| `src/native/Cargo.lock` | 同步 Rust 锁定版本。 |
| `src/toolchains/channel.js` | 输出通道批量刷新与显示预算。 |
| `src/toolchains/compile-policy.js` | 集中 lint/详细化阶段超时。 |
| `src/toolchains/diagnostics.js` | 逐行诊断、缺失单元及共享字符预算。 |
| `src/toolchains/iverilog-controller.js` | VS Code 接线、状态栏、诊断归属、过期任务取消。 |
| `src/toolchains/iverilog-runner.js` | Icarus lint/仿真流程、独立产物、实际变化波形。 |
| `src/toolchains/iverilog.js` | 保留公共规则，注入控制器，流式依赖补编译与取消探测、缓存竞争修复。 |
| `src/toolchains/job.js` | 任务身份、AbortSignal、进程槽、独立目录和清理。 |
| `src/toolchains/output.js` | 有界 UTF-8 摘要、逐行解析、完整日志与背压/故障处理。 |
| `src/toolchains/process.js` | 进程生命周期、取消、有限完成与输出服务接入。 |
| `src/toolchains/result.js` | 成败与主文件/总错误计数、基础设施诊断。 |
| `src/toolchains/xvlog-rules.js` | 原有工具定位、诊断、UVM 与依赖规则的独立模块。 |
| `src/toolchains/xvlog-runner.js` | xvlog/xelab 阶段编排、独立目录与真实结果发布。 |
| `src/toolchains/xvlog.js` | 兼容导出入口。 |
| `src/vivado/batch.js` | Vivado ERROR、项目标记与真实退出码处理。 |
| `src/vivado/index.js` | batch 使用任务与日志服务，准备可停止，关闭释放资源。 |
| `scripts/verify-toolchains.js` | 无硬编码安装路径的真实工具验收入口。 |
| `test/process_output_test.js` | 27 项输出/日志/取消/故障合同。 |
| `test/toolchain_task_test.js` | 22 项引擎、任务、诊断归属与编辑器边界合同。 |
