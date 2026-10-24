# 4.0.0-beta.5：电路临时文件lint误报

2026-10-16。用户清单32条错误均来自26个.svtools/circuit文件。跨文件检索打开快照，自动lint监听文档事件，外部xvlog无法解析WASM虚拟/source0或独立验证上下文，于是产生误报。

## 修复

排除策略覆盖发现、已打开缓存、定义检索、工具入口和诊断发布。内部文档返回skipped并清理其旧误报，正常RTL错误、失败状态及日志保留。仅按完整目录段匹配，Windows大小写及两种分隔符兼容；名字含.svtools但不在该目录中的真实文件保留。

独立worktree和草稿PR11继续保留，本轮提供beta.5本地VSIX，公开Release仍beta.2。用户工程、RTL和原任务日志均未写入。正式版目标4.0.0。

## 最终验证

| 检查 | 结果 |
|---|---|
| JS语法 | 154文件通过 |
| 格式化Golden | 40/40，20个用例 |
| Node功能回归 | 523项：522通过，1项可选官方目录重建跳过 |
| 电路回归 | 169/169 |
| Rust回归 | 125/125 |
| Node22.20相关回归 | 57/57 |
| 最终VSIX | 443文件，427运行文件与工作区逐字节一致 |
| 实际Qoder Node运行时 | Node24.15.0/Electron42.2.0，解包native ABI及格式化字符保全通过 |
| 用户诊断清单 | 最终包策略识别32/32为生成目录诊断；正常RTL及显式依赖路径不排除 |
| CLI | svtools 4.0.0-beta.5 |

新增7项Node回归，覆盖启动/打开/编辑/保存/配置重查、手动工具入口、旧诊断清理、跨文件定义、补全及工作区扫描。混合错误测试启动真实Node协议子进程，同一任务同时发出生成文件和node_modules内依赖错误：仅清除生成资源，真实错误及failed状态、总错误计数保留。

这些测试验证编辑器API边界，不等于完整IDE UI验收；没有重新执行无关的波形和电路浏览器性能基准。Rust测试宿主有既有N-API导出提示，125项测试通过，实际Qoder运行时加载最终原生模块另外通过。

安装`bin/svtools-4.0.0-beta.5-win32-x64.vsix`后重载窗口，诊断集合重建并跳过内部文件，无须删除任务目录。证据：`bin/circuit-beta5-package.log`、`bin/circuit-beta5-rust.log`、`bin/generated-lint-node22.log`、`bin/circuit-beta5-package-report.json`、`bin/circuit-beta5-qoder-native.log`。

最终包：`bin/svtools-4.0.0-beta.5-win32-x64.vsix`，18,532,185字节。SHA256：`88391c0086e762a8aa3a681891d97fe1fc0b170dd9fe88be7bc6e39d9e755d60`。

## 完整文件清单（相对beta.4）

| 文件 | 修改 |
|---|---|
| `src/workspace/source-policy.js` | 统一glob与直接路径排除判定 |
| `src/workspace/sources.js` | 发现结果二次过滤 |
| `src/editor/language.js` | 定义检索排除内部快照 |
| `src/editor/completion/index.js` | 过滤发现和已打开缓存，当前临时文档保持可解析 |
| `src/toolchains/iverilog-controller.js` | 工具入口跳过、旧误报清理、诊断及仿真glob过滤 |
| `src/toolchains/xvlog-runner.js` | 直接入口跳过内部文档 |
| `test/workspace_test.js` | 路径边界及索引过滤回归 |
| `test/editor_test.js` | 定义检索不打开快照回归 |
| `test/completion_index_test.js` | 打开和发现路径不污染补全回归 |
| `test/toolchain_task_test.js` | 各事件跳过、旧误报清理和真实诊断保留回归 |
| `package.json` | 扩展版本beta.5 |
| `package-lock.json` | 扩展锁版本同步 |
| `src/native/Cargo.toml` | 原生crate/CLI版本同步 |
| `src/native/Cargo.lock` | Rust锁版本同步 |
| `src/native/package.json` | 原生npm版本同步 |
| `src/native/package-lock.json` | 原生npm锁版本同步 |
| `README.md` | 当前版本及修复说明 |
| `CHANGELOG.md` | beta.5变更、原因与影响 |
| `CONTEXT.md` | 复现与交接 |
| `ARCHITECTURE.md` | 共享排除策略和文档事件边界 |
| `docs/CIRCUIT.md` | 生成目录和诊断说明 |
| `docs/ROADMAP.md` | 同步完善进度 |
| `docs/bugs/logic-generated-sources-lint.md` | 错误统计、事件链及修复取舍 |
| `docs/V4_BETA5.md` | 验证、边界与完整清单 |

原生模块、CLI、VSIX及验收探针/日志位于已忽略的bin/，不提交。

索引排除范围与工具生成目录分别由同一目录表派生。自动lint和诊断仅跳过.svtools/.Xil；显式node_modules等依赖源码仍可检查，真实错误正常显示。
