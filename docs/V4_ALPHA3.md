# 4.0.0-alpha3：VCD 存储器查看

2026-10-13。开发目录为 `C:\Users\JayceVane\.codex\worktrees\svtools-v4\02_svtools`，
分支 `codex/refactor-v4`。3.x 原目录继续维护，FSDB 查看开发按用户决定取消。

## 使用与实现

在波形工具栏点击“存储器”，选择数组。字数组按地址显示 word，两层索引记录按矩阵显示。
面板共享波形 A/B 游标，支持 Hex/Bin/Dec/SDec、地址定位、分页、变化标记和单元加入波形。
点击单元同时选中对应波形，可继续使用真实边沿导航。当前页最多 64 格，仅查询已记录单元。

`memory.js` 负责索引归并、冲突诊断、分页和位值比较；`memory-view.js` 负责页面状态、
DOM 与有界精确读值。它们复用现有 worker 的 values 查询，不加载第二份事件序列。
快速换页或移动游标时，只保留一个正在执行的任务与最新待执行任务，迟到响应不覆盖新页。
两层索引之外的记录保持普通波形；同坐标不同 ID/range、位宽或维数冲突不会静默取一项。

“未 dump”与“—”分别表示没有该单元记录和该时刻没有初值，X/Z 保持真实状态。
二维形状依赖 VCD 导出的名称；Icarus 13.0 在样例中将原二维数组展平为线性索引，
查看器据此显示字数组。样例另有连接到同一 memory 的 escaped wire 别名，其真实 dump
保留两个索引，供矩阵验证。详细边界见 [WAVEFORM.md](WAVEFORM.md)。

## 验证与交付

- JS 语法检查 49 文件；golden 36/36；Node 合同 169/169，其中波形相关 94。
- Rust 112/112；当前平台原生模块与 CLI 重新构建，CLI 报告 `4.0.0-alpha3`。
- Icarus 13.0 实际编译并运行 `test/fixtures/memory_dump.sv`，保存其 VCD。
  worker 合同验证负地址矩阵别名、原数组线性索引、X/Z、子层级及各时间点原始位值。
- 模型覆盖 10000 个稀疏单元，分页仅生成当前页；控制器覆盖查询合并、迟到响应、关闭、
  缺失初值、精确 A/B 读值、进制切换、地址定位与布局恢复。
- 浏览器使用同一真实 VCD 和实际 worker 验证明暗主题、A=0ns/B=15ns、signed -1/-2/-128、
  X/Z、未 dump 格、单元加入波形、边沿导航启用和重载恢复；未观察到 console 错误。
- 两个新增生产模块的静态扫描未报告 Blocker/Critical。局部数组回调的四项命名 Warning
  经人工检查，无占位实现、空错误处理或事件数据复制。
- 安装包：`bin/svtools-4.0.0-alpha3.vsix`，50 文件，2,084,315 bytes。
  SHA256：`f76206a5c04acd9598bba1b2b17e73d617ab06648549af3f00bfaea3e2cda203`。
  33 个运行 JS/CSS、扩展入口和 native 与构建逐字节一致；不含测试、VCD、日志或开发依赖。
- 界面截图在 `bin/waveform-alpha3-memory-dark.jpg`、`bin/waveform-alpha3-memory-light.jpg`。

100/500 MiB 性能表沿用 alpha2 的明确语料测量；本轮没有重新测量大文件，也没有修改事件
存储和查询策略。真实 VS Code 宿主与其它 simulator 的导出约定仍需安装包实机验收。
本版本保存在本地 4.0 分支，未推送、合并或发布。

## 完整文件清单

相对路径均以本 worktree 为根。构建产物位于 `bin/` 并已忽略。

| 文件 | 本轮变更 |
|---|---|
| `.gitignore` | 仅将两份公开 memory 验收 fixture 纳入版本控制。 |
| `ARCHITECTURE.md` | 记录 memory 模型、交互与数据服务职责。 |
| `CHANGELOG.md` | 增加 alpha3 的行为、原因和影响范围。 |
| `CONTEXT.md` | 更新当前版本、验证与接续边界。 |
| `README.md` | 开发版本指向 alpha3。 |
| `docs/WAVEFORM.md` | 存储器操作、dump 要求和 simulator 导出边界。 |
| `docs/V4_ALPHA3.md` | 本轮实现、验证、安装包与文件清单。 |
| `docs/bugs/vcd-packed-bit-array-identity.md` | packed 单 bit 与数组地址混淆的根因和修复约束。 |
| `package.json` | alpha3 版本并注册两组 memory 合同。 |
| `package-lock.json` | 同步根包版本。 |
| `src/native/package.json` | 同步 native 包版本。 |
| `src/native/package-lock.json` | 同步 native 锁定版本。 |
| `src/native/Cargo.toml` | 同步 Rust 包及 CLI 版本。 |
| `src/native/Cargo.lock` | 同步 Rust 锁定版本。 |
| `src/waveform/memory.js` | 新增索引归并、有界分页和原始位值比较。 |
| `src/waveform/memory-view.js` | 新增 memory 面板控制器与精确读值合并。 |
| `src/waveform/client.js` | 连接共享游标、状态恢复、单元选择；scope 去重。 |
| `src/waveform/parser.js` | 单 bit packed 选择保留 referenceName 并正确校验范围顺序。 |
| `src/waveform/view.js` | 注册 memory 静态资源与页面控件。 |
| `src/waveform/view.css` | 存储器表格、变化状态与明暗主题。 |
| `test/waveform_memory_test.js` | 8 个模型、稀疏分页和真实 worker 合同。 |
| `test/waveform_memory_view_test.js` | 5 个控制器异步与交互合同。 |
| `test/waveform_stream_test.js` | 新增单 bit packed 元数据与重复范围拒绝合同。 |
| `test/fixtures/memory_dump.sv` | 公开的实际 memory 仿真与别名验收源。 |
| `test/fixtures/memory_dump.vcd` | Icarus 真实生成的对应波形。 |
