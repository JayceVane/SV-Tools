# 4.0.0-alpha2 交付记录

worktree：`C:\Users\JayceVane\.codex\worktrees\svtools-v4\02_svtools`；分支 `codex/refactor-v4`。
本轮基于 alpha1 提交 `869e4d1`，原 3.x 目录及其已有修改保持原状。

always 事件头在 inlineCompact 开启时安全删除冗余水平空白，关闭时保持原文。
波形数据服务与界面分离：流式 Worker + 紧凑存储 + 有界视口 + 精确游标/边沿。
工程操作和性能条件见 [波形查看器](WAVEFORM.md)。

## 实际验收

- Rust 112/112；最终无告警检查及 Rust 格式检查通过。
- JS 45 文件语法检查；golden 36/36；合同 155/155，其中波形 80、格式化器 42。
- CLI alpha2 版本、always 标准输入紧凑和 --check 幂等验证通过。
- VSIX 48 个文件、2,075,478 bytes，运行 JS/CSS/native 逐字节核对通过。
- 浏览器实际加载 100 MiB：百万事件缩放、500ns跳转到505ns下一边沿、65条信号和视口Canvas均通过。
- 生成 FIFO 波形：明暗主题、A=585ns/B=620ns/Δt=35ns、模拟量阶跃、搜索及布局恢复通过，无 console 错误。
- 基准64独立信号混合语料，热缓存：100 MiB 新加载1.092s/RSS183.6MiB；500 MiB 5.329s/RSS485.4MiB。

真实 VS Code 宿主与用户 RTL 工程仍待安装包验收；当前没有推送、发布或合并。
默认紧凑存储预算512MiB，事件密度会影响支持范围；超限清晰报错，不承诺任意大小。

## 全部文件变化

| 文件 | 说明 |
|---|---|
| [ARCHITECTURE.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/ARCHITECTURE.md>) | 记录波形 Worker、数据查询、模型、绘制和交互的职责边界。 |
| [CHANGELOG.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/CHANGELOG.md>) | 解释事件头遗漏和原波形全量读取的根因、变化及影响。 |
| [CONTEXT.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/CONTEXT.md>) | 保存 alpha2 里程碑、真实验收和下一步入口。 |
| [README.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/README.md>) | 更新 alpha2 版本、安装依赖和波形操作文档入口。 |
| [docs/FORMAT_SPEC.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/docs/FORMAT_SPEC.md>) | 明确 always 显式事件头的紧凑范围和配置保护合同。 |
| [docs/V4_ALPHA2.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/docs/V4_ALPHA2.md>) | 记录本轮所有文件变化、产物和测试结果。 |
| [docs/V4_CHANGES.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/docs/V4_CHANGES.md>) | 保留 alpha1 历史清单并连接本轮交付记录。 |
| [docs/WAVEFORM.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/docs/WAVEFORM.md>) | 说明 IC 调试操作、数据合同、实测条件和资源边界。 |
| [docs/bugs/logic-always-event-header-spacing.md](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/docs/bugs/logic-always-event-header-spacing.md>) | 保存 always 非分号块头未参与紧凑的复现与修复过程。 |
| [package-lock.json](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/package-lock.json>) | 同步扩展 alpha2 版本，保持锁定开发依赖。 |
| [package.json](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/package.json>) | 切换 alpha2，注册流式、视图和宿主合同测试。 |
| [scripts/benchmark-vcd.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/scripts/benchmark-vcd.js>) | 生成不覆盖已有文件的语料，对比明确的旧版与 Worker 基线。 |
| [src/native/Cargo.lock](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/Cargo.lock>) | 同步 Rust crate alpha2 版本。 |
| [src/native/Cargo.toml](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/Cargo.toml>) | 同步原生模块和 CLI 的 alpha2 版本。 |
| [src/native/package-lock.json](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/package-lock.json>) | 同步 napi 包的 alpha2 锁文件版本。 |
| [src/native/package.json](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/package.json>) | 同步 napi 构建包 alpha2 版本。 |
| [src/native/src/preprocess.rs](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/native/src/preprocess.rs>) | 缓存头部模式，限定事件选区并共享安全水平空白紧凑。 |
| [src/waveform/client.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/client.js>) | 虚拟信号目录、双游标、搜索、导航、分组、排序和状态恢复。 |
| [src/waveform/host.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/host.js>) | 处理 ready 竞态、加载进度、按需查询和取消关闭生命周期。 |
| [src/waveform/index.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/index.js>) | 以异步数据服务替换全文读取，保留 VS Code 命令与自定义编辑器。 |
| [src/waveform/model.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/model.js>) | 纯时间/进制/范围规则，独立同名切片标识及宽总线精度保护。 |
| [src/waveform/parser.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/parser.js>) | 共享增量 token 语法，处理范围/索引、alias 和位置诊断。 |
| [src/waveform/renderer.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/renderer.js>) | 固定视口 Canvas，绘制可见行、X/Z、数值阶跃与明确密集区。 |
| [src/waveform/session.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/session.js>) | 封装单文件 Worker 请求、进度、并发预算和终止。 |
| [src/waveform/store.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/store.js>) | typed 分块、压缩值与 alias 共享；完整精确查询和解码前响应预算。 |
| [src/waveform/view.css](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/view.css>) | 设计信号、测量、时序图区和明暗主题的独立样式。 |
| [src/waveform/view.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/view.js>) | 生成不含事件的 HTML 页面壳与 nonce CSP。 |
| [src/waveform/worker.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/src/waveform/worker.js>) | 异步字节流解码与增量解析，资源限值和可取消加载。 |
| [test/formatter_contract_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/formatter_contract_test.js>) | 锁定事件头开启/关闭、保护内容和完整管线幂等。 |
| [test/render-vcd-badge.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/render-vcd-badge.js>) | 适配按需页面的小测试桥，保留明暗总线徽章视觉回归。 |
| [test/waveform_host_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/waveform_host_test.js>) | 验证握手竞态、错误、取消和真实 Worker 清理。 |
| [test/waveform_stream_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/waveform_stream_test.js>) | 验证 chunk、范围/alias、同刻数据、密集区及资源预算。 |
| [test/waveform_ui_test.js](<C:/Users/JayceVane/.codex/worktrees/svtools-v4/02_svtools/test/waveform_ui_test.js>) | 验证 wide bus、SDec、切片标识、时间、持久化和 CSP。 |

## 本地产物（不提交）

- `bin/svtools-4.0.0-alpha2.vsix`：本地 Windows x64 安装包。
- `bin/svtools.exe` / `bin/svtools.win32-x64-msvc.node`：版本匹配的 CLI 和原生模块。
- `bin/vcd-benchmark/report.json`：100/500 MiB 实测原始记录。
- `bin/vsix-alpha2-check.json`：安装包清单、字节数和 SHA-256。
- `bin/wave-quality-reviewed.json`：自动扫描误报的实际核实证据。
- `ENVIRONMENT.md`：本机命令、工具路径和目录边界，已忽略。

测试页面通过同一 Worker 数据服务加载真实 VCD 字节流；临时服务与线程在交付前关闭。
