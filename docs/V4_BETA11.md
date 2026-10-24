# 4.0.0-beta.11 VCD默认打开与重新仿真

本轮继续独立codex/feat-circuit-viewer，基线9f6fa64；原工程保持不变。
唯一beta.11预览号保留旧产物，不自动合并或创建Release。

## 结果与边界

点击VCD默认进入波形自定义编辑器；原文本查看入口和用户显式编辑器关联保持。
编译成功后、vvp运行前，关闭对应旧波形及VCD文本标签，并等待数据worker退出。
旧面板已关闭但worker仍在退出时也会等待。运行期间保护波形打开入口，结束后自动打开新文件。
取消、失败、超时都释放保护；编译失败不关闭旧页，关闭失败或用户取消关闭文本标签时不运行vvp。

有界扫描磁盘源码和字面include，识别dumpfile字面路径，按实际仿真cwd解析，支持子目录产物。
最多128文件、单文件1MiB、总8MiB阈值；无法完整识别或动态路径时，结合已有源码关联，
保守关闭cwd及子目录已开的波形，并在输出通道说明；其他工程目录保留。
不执行宏或路径表达式，不结束外部查看器进程，不删除旧VCD或改写用户RTL。
实现与定位见[调试笔记](bugs/logic-waveform-simulation-disposal.md)。

## 验证

- 修复前两项关联/释放回归失败，修复后通过。
- 生命周期、host、工具任务重点合同53/53；Node22.20.0波形合同23/23。
- Rust127/127，原生与CLI按beta.11重建。
- 真实Qoder源树宿主4/4：普通打开默认CustomEditor、Icarus子目录重写/自动打开、文本标签关闭、
  100MiB旧文件打开期间重新仿真。其他波形保持加载，旧文件104857906字节变为新文件262字节。
- 全量打包回归：JS179文件，golden21语料42/42，Node586项（585通过、1项官方目录重建可选跳过），电路170/170。
- VSIX457文件，441运行文件与源码/原生/vendor逐字节一致，包内默认编辑器与两个新模块均校验。
- 解包后真实Qoder生命周期4/4；记录loadingAtSimulationStart=true，证明100MiB旧数据尚在加载时已开始本轮仿真流程。
- 解包后既有波形宿主4/4，涵盖RTL角色、Webview/worker握手、布局及图片文件服务。
- 真实Icarus另外确认未指定dumpfile时生成dump.vcd，路径推断与实际工具行为一致。

本机证据：bin/beta11-before-fix.log、bin/beta11-lifecycle-contracts.log、bin/beta11-node22.log、
bin/beta11-rust.log、bin/beta11-native-build.log、bin/beta11-source-host.log。
实际宿主命令：scripts/verify-waveform-host.ps1 -CodePath <IDE> -TestPath test/vscode_waveform_lifecycle_host.js
-IcarusPath <iverilog-bin> -CygwinPath <cygwin-bin>。脚本使用独立用户、扩展与夹具目录，不安装到现有IDE。
最终证据另见bin/beta11-package.log、bin/waveform-beta11-package-report.json、
bin/beta11-packaged-lifecycle-host.log、bin/beta11-packaged-waveform-host.log、bin/beta11-default-vcd-proof.log。
实际宿主VS Code API1.106.3、Node24.15.0、Electron42.2.0。

## 安装包

源码提交`f8ed4c166016e0840a435beac8d2a059e30d8527`；后续交付记录提交仅更新文档。
唯一版本入口生成以下产物，完整追溯见bin/svtools-4.0.0-beta.11-win32-x64.manifest.json。

| 文件 | 字节 | SHA256 |
|---|---:|---|
| svtools-4.0.0-beta.11-win32-x64.vsix | 18571709 | `6bae5051df1a451f6726b6dfb108d79e9dffead8637ca2701a32d78497c3720b` |
| svtools.exe | 24050176 | `682502d417644b1753136b317991227af4796de04f87f89ad3b88ecc7ba5ea25` |
| svtools.win32-x64-msvc.node | 24199168 | `0fcc69c971a9fb30fc36e788063760730055ab8a3fe3bfc8492177a245061e70` |

使用“从VSIX安装”后重载窗口。旧版本安装包保留，未安装到用户当前IDE。

## 修改清单

| 文件 | 内容 |
|---|---|
| src/waveform/registry.js | 活动/退出中的会话、文件身份及写入租约 |
| src/waveform/index.js | 默认编辑器接线、文本标签关闭及活动面板URI |
| src/waveform/host.js | 返回并复用数据服务释放Promise |
| src/waveform/session.js | 重复关闭共享worker退出Promise |
| src/toolchains/simulation-waveforms.js | 有界字面dumpfile/include路径发现 |
| src/toolchains/iverilog-runner.js | 启动vvp前准备租约，finally释放及子目录产物快照 |
| src/toolchains/iverilog-controller.js | 波形服务生命周期依赖适配 |
| test/waveform_lifecycle_test.js | 注册表、路径发现和写入保护合同 |
| test/waveform_host_test.js | 默认关联及可等待释放回归 |
| test/toolchain_task_test.js | 等待、取消、关闭失败、运行失败及超时合同 |
| test/vscode_waveform_lifecycle_host.js | 默认关联、真实Icarus与100MiB旧波形宿主验收 |
| scripts/verify-waveform-host.ps1 | 复用宿主入口，支持测试路径和独立工具配置 |
| package.json | 默认VCD关联、合同注册及beta.11版本 |
| package-lock.json | 根包版本同步 |
| src/native/Cargo.toml | beta.11原生与CLI版本 |
| src/native/Cargo.lock | Rust包版本同步 |
| src/native/package.json | 原生构建包版本同步 |
| src/native/package-lock.json | 原生JS包锁版本同步 |
| README.md | 当前预览与仿真前释放说明 |
| CHANGELOG.md | beta.11变更及边界 |
| ARCHITECTURE.md | 文件生命周期与工具运行边界 |
| docs/WAVEFORM.md | 默认打开、文本模式及重新仿真操作 |
| docs/bugs/logic-waveform-simulation-disposal.md | 根因及诊断过程 |
| docs/V4_BETA11.md | 本轮交付、验证及逐文件清单 |
| CONTEXT.md | 当前开发状态与验证交接 |
