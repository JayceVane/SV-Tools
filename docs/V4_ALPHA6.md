# 4.0.0-alpha6 交付记录

本轮在 `codex/refactor-v4` 的独立 worktree 中重构补全。原工程目录没有由本轮开发写入；没有安装到用户 IDE、推送、合并或发布。

## 结果

- 删除旧补全入口中约 260 行正则与硬编码上下文逻辑，统一到规范目录、容错解析、工程索引、类型解析、候选策略和编辑器适配。
- 关键词及固定参考库公开 API 完整索引；稀有关键词、系统任务、指令、UVM 宏和接口不再依赖零散手写常用项。
- 加入 package/import、继承/可见性、泛型及返回值链、命名连接、聚合类型、数组/二维 mem、验证对象、modport 和同文件类外方法支持。
- 增量工程缓存优先脏文档，监听工作区及外部 include 目录；取消、源码/文件/候选预算与 incomplete 明确反馈。
- 修复大作用域 O(n²) 查重、过滤前十万条候选分配、光标全文件扫描、外部 include 缓存不失效、方法返回值泄漏局部符号等问题。

配置和已验收/尚未覆盖的语义见 [COMPLETION.md](COMPLETION.md)。目录来源和许可见 [COMPLETION_SOURCES.md](COMPLETION_SOURCES.md)。本轮没有宣称完整预处理与 elaboration，不能把目录枚举覆盖当作 IEEE 全部语义的 100% 实现。

## 验收

| 检查 | 结果 |
| --- | --- |
| JS 语法 | 85 个文件通过 |
| 格式化 golden 与幂等 | 36/36，18 组样例 |
| Node 回归 | 382/382，0 fail，0 skip |
| 本轮补全合同 | 82 项：语法 32、目录 11、解析协同 28、索引 6、适配 5 |
| 固定参考目录重建 | 实际运行并逐项相等，没有跳过 |
| Rust | 原 112 项测试集通过，原生实现未改；版本同步并重新构建 |
| CLI | `svtools 4.0.0-alpha6` |
| 真实 VS Code 1.141 | 22/22，隔离用户目录与扩展目录 |
| 接受补全后编译 | Icarus 13 通过，stderr 为空 |

全量发布前测试日志：`bin/alpha6-package.log`。宿主报告：`bin/completion-host/run-96ff2f92b9c843ec8af0836fb9dcfd60/host-report.json`。覆盖真实 API、插入区间、普通文本/片段接受、UVM 版本、未保存模型、工作区和外部库事件、覆盖率对象、modport、转义名称、关键词版本区间及容量收窄。

## 性能

Node 24.17 中实际 provider/index/engine，真实生成/读取 512 个 HDL 文件和 100000 行、2599964 字节活动文档。编辑器适配类为轻量构造器；此表不是 IDE 绘制端到端耗时。

| 指标 | 实测 |
| --- | ---: |
| 冷工程索引 | 793.29 ms |
| 冷候选查询 | 21.41 ms |
| 20 次热 provider 中位数 / p95 | 6.11 / 9.53 ms |
| 单文件变化 | 3.90 ms，只重新读取该文件 |
| 活动编辑重建 | 672.09 ms，不重新读取其他文件 |
| 热请求工程扫描 / 读取 | 0 / 0 |
| 冷 heap / RSS | 约 169 / 301 MB |
| 热请求后 / 脏文档后 RSS | 约 310 / 408 MB |

报告：`bin/completion-performance/run-X1DVIw/report.json`。源码容量预算与实际堆内存不同；打开的大文件仍需要完整语义模型。性能问题的定位过程见 [调试记录](bugs/perf-completion-scope-and-prefix-allocation.md)。

## 发布包核验

- 文件：`bin/svtools-4.0.0-alpha6.vsix`。
- 大小：2282176 字节，75 个 ZIP 条目。
- SHA-256：`c1b5c8b9c433057c766b9a6d767c2bb504f0b19f2bb42a26b28882779223f25c`。
- 66 个源/运行文件逐字节比对，其中 53 个 `src` 运行 JS/CSS；native、四个标准/许可 JSON、根入口、配置、图标及语法资源均核对。
- VSIX 与清单版本一致，中英文配置键完整；没有参考库归档、native 源码、tests、scripts、日志、VCD、CLI 可执行文件或 node_modules。
- 核验报告：`bin/alpha6-package-report.json`。构建的 native 与 CLI 留在 `bin/`，没有进入 Git。

## 质量复核

架构技能扫描 7 个生产 JS，原始报告 `bin/completion-quality-final.json` 的 3 个 Blocker 均是 `DEAD-003` 将空数据字面量判作空函数体：`catalog.js:219` 是 Verilog 空内建目录，`resolve.js:225` 是空泛型绑定回退，`resolve.js:269` 是无内建目录回退。逐项复核及对应合同确认后，未解决 Blocker/Critical 均为 0；原始结果没有被改写。

Warning 主要涉及规范 API 的 snake_case、参数 data/item/obj 以及 CompletionItem 引用命名和注入的错误报告，保留领域名称和可观测错误处理。完整豁免依据：`bin/completion-quality-review.json`。

## 修改文件

以下清单由本轮 Git 差异与未跟踪源码生成；忽略的构建和验收产物另列于上文。

- `.gitignore`
- `ARCHITECTURE.md`
- `CONTEXT.md`
- `README.md`
- `docs/COMPLETION.md`
- `docs/COMPLETION_SOURCES.md`
- `docs/V4_ALPHA6.md`
- `docs/bugs/perf-completion-scope-and-prefix-allocation.md`
- `package-lock.json`
- `package.json`
- `package.nls.json`
- `package.nls.zh-cn.json`
- `scripts/generate-completion-catalog.js`
- `scripts/verify-completion-host.ps1`
- `scripts/verify-completion-performance.js`
- `src/editor/completion-data.js`
- `src/editor/completion/catalog-licenses.json`
- `src/editor/completion/catalog.js`
- `src/editor/completion/engine.js`
- `src/editor/completion/index.js`
- `src/editor/completion/language-standard.json`
- `src/editor/completion/provider.js`
- `src/editor/completion/resolve.js`
- `src/editor/completion/syntax.js`
- `src/editor/completion/templates.js`
- `src/editor/completion/uvm-1-2.json`
- `src/editor/completion/uvm-1800-2.json`
- `src/editor/language.js`
- `src/extension.js`
- `src/native/Cargo.lock`
- `src/native/Cargo.toml`
- `src/native/package-lock.json`
- `src/native/package.json`
- `test/completion_catalog_test.js`
- `test/completion_engine_test.js`
- `test/completion_index_test.js`
- `test/completion_provider_test.js`
- `test/completion_syntax_test.js`
- `test/vscode_completion_host.js`
