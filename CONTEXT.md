# 4.0 开发交接

最后更新：2026-10-13。当前里程碑为本地 `4.0.0-alpha1`，分支 `codex/refactor-v4`。

## 完成内容

- 独立 worktree：`C:\Users\JayceVane\.codex\worktrees\svtools-v4\02_svtools`。
- `src/` 放源码，`bin/` 放产物；Rust crate 为 `src/native/`。
- 格式化器使用共享词法扫描、类型化上下文和单次会话状态，拆开结构识别与布局。
- 所有 pass 保留字符串、注释、宏正文和转义标识符；去除标点 `Box::leak`。
- 扩展按编辑器、工具进程、工作区索引、波形、Vivado 分工；配置默认值来自 manifest。
- 发布流程、锁文件、构建脚本和文档已同步。完整文件列表见 `docs/V4_CHANGES.md`。

## 验证

- Rust 单元测试 106/106；`cargo check` 无告警；`cargo fmt --check` 通过。
- `npm test`：34 个 JS 文件语法检查、golden 36/36、模块合同 78/78（格式化器 31）。
- CLI 的版本、帮助和 18 组文件输入/标准输入/检查模式与 golden 一致。
- 本地 VSIX：`bin/svtools-4.0.0-alpha1.vsix`，40 个文件、2,064,184 bytes；
  运行源码与 native 模块逐字节核对通过，无开发依赖、日志、Rust 源码。
- 同 18 样例 18,848 bytes、预热后交错 5 轮：3.x/4.0 墙钟中位 629/541ms，
  CPU 中位 626/531ms。仅代表该语料，不代表大工程和 UI。

## 环境与开发边界

本机路径和依赖见已忽略的 `ENVIRONMENT.md`。开发和验证只写本 worktree；
`D:\Workspace\FPGA\02_svtools` 仍在 `feat/3.5`，保留原有 `M src-rust/index.d.ts`。
本里程碑保存为 4.0 分支本地提交，没有推送、合并、打 tag 或发布。

没有已知未解决的回归失败。真实 VS Code 宿主交互、Vivado/Icarus 工作流及其它平台
未完成验收；布局仍基于词法和正则规则，没有完整 SystemVerilog AST。

## 下一步

1. 用本 worktree F5 或 VSIX 验证真实编辑器命令、诊断、工具链和波形交互。
2. 补充实际大型 RTL 工程的格式化保真与性能语料。
3. 审查 4.0 分支后走 PR 和发布流程；Marketplace 预发行需采用其接受的版本格式。
