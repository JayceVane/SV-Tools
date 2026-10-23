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
- 完整打包回归与解包后验收见后续安装包记录。

本机证据：bin/beta11-before-fix.log、bin/beta11-lifecycle-contracts.log、bin/beta11-node22.log、
bin/beta11-rust.log、bin/beta11-native-build.log、bin/beta11-source-host.log。
实际宿主命令：scripts/verify-waveform-host.ps1 -CodePath <IDE> -TestPath test/vscode_waveform_lifecycle_host.js
-IcarusPath <iverilog-bin> -CygwinPath <cygwin-bin>。脚本使用独立用户、扩展与夹具目录，不安装到现有IDE。

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
