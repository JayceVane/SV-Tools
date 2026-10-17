# 4.1.0-alpha1 电路查看器交付记录

日期：2026-10-15。分支：`codex/feat-circuit-viewer`，基线 `4cc1c737c74e442c76fc618fd90bf6b0e42fcd04`。

4.0.0-preview.1 已由 [PR #10](https://github.com/JayceVane/SV-Tools/pull/10) 合入原工程并发布到 [GitHub Release](https://github.com/JayceVane/SV-Tools/releases/tag/v4.0.0-preview.1)。本记录描述其后的独立开发版本；4.1 尚未发布 Release 或合入 master。

## 实现与范围

真实 Yosys JSON 经 netlistsvg 核验后适配到独立 Design 模型；正式视图使用 ELK.js 正交布局与 SVG。模型保留模块局部位 ID、LSB-first 位序、总线范围、参数、别名、常量及源位置，布局坐标不污染领域对象。Vivado 适配同一合同，当前为只读 RTL 详细化后的平坦结构。

支持当前 RTL 生成、已有 JSON 导入、所选 XPR 生成、停止；交互包括模块选择/下钻/返回、搜索、网络分支与端点高亮、详情、源码定位、键鼠平移缩放和明暗主题。未保存正文走独立快照，关闭/刷新取消工具任务，Worker 隔离解析及布局。

用户指南和预算见 [CIRCUIT.md](CIRCUIT.md)。容量是 JSON 64 MiB、模型 2M 位引用、当前模块最多 2,000 节点/6,000 边/16,384 引脚/200k 位引用；超预算提示并保留可用的模块选择。逻辑锥、跨次生成缓存、增量布局和任意大设计按需加载尚未实现。

## 本轮实际验证

| 验证 | 结果与证据（工作树 `bin/`，不入仓库） |
|---|---|
| JS 语法 | 135 文件，`circuit-package.log` |
| Golden | 19 用例、38 断言通过 |
| 既有 Node 回归及索引策略回归 | 511 项：510 通过、1 项可选目录重建跳过、0 失败 |
| 电路回归 | 75/75，Node 24 与 Node 20 均通过；`circuit-node20-test-final.log` |
| Rust | 121/121，`circuit-rust-test.log` |
| 真实 Yosys builtin | YoWASP Yosys 0.69；`circuit-validation/run-cSxiOx/report.json` |
| 真实 Yosys slang | 同工具 slang 前端；`circuit-validation/run-ZKQX6r/report.json` |
| netlistsvg / ELK | 1.0.2 / 0.12.0，前述两份报告；顶层 21 节点、29 边，参数化子模块 5 节点 |
| 真实 Vivado | 2022.1.2，新建公开夹具工程；14 单元、6 顶层端口，`vivado-circuit-validation/run-uihwwj/report.json` |
| Vivado 连接与只读性 | RTL_ADD/RTL_REG、时钟/使能、跨层 segments、升序及非零起点总线、I/O buffer 连接；工程文件树 SHA256 前后相同 |
| 真实浏览器 | 明暗主题、参数化实例下钻、输入声明方向、网络位序/端点高亮、键盘及拖动平移、源码回调；控制台无 warning/error |
| Windows x64 VSIX | 104 文件、2,844,669 字节；88 个运行文件与源/构建产物逐字节一致，包内 native `formatText`/`extractSymbols` 通过，CLI 版本 4.1.0-alpha1 |
| 真正 VS Code 宿主 | **未通过，环境阻挡**：启动返回 `Code is currently being updated. Please wait for the update to complete before launching.`，`circuit-host.log` |

VSIX：`bin/svtools-4.1.0-alpha1-win32-x64.vsix`。SHA256：

```text
aa930bae9f57e740f05d2d76e359f5163d6fc66008c24c2be292c801047a7f1e
```

包内包含运行时电路 JS/CSS/Tcl、原生模块和固定 ELK bundle/许可；不含 Yosys、Python、netlistsvg、node_modules、测试夹具、任务日志或用户工程。核验记录为 `bin/circuit-package-report.json`。

宿主脚本在更新完成后可复验：`scripts/verify-circuit-host.ps1 -CodePath <Code.exe> -ExtensionPath <解包后的extension目录> -YosysPath <yosys可执行文件>`。预期生成 `host-report.json` 并核对 ready 消息、命令和 Worker；启动失败、缺报告或断言失败均不算通过。脚本使用独立 profile/extensions/workspace，无需改动当前 IDE 配置；关闭测试宿主即可退出该隔离环境。本轮不终止安装器或绕过更新保护。

## 架构复核

依赖扫描 `circuit-dependency-scan.json` 未发现循环。模型不依赖 VS Code、ELK、工具进程或页面；适配器只转换工具方言；正式渲染不依赖 netlistsvg。外部工具复用既有任务、进程与输出模块，扩展仅新增一处激活注册。

静态模式扫描 `circuit-code-scan.json` 原始报告 15 个 Blocker、1 个 Critical，逐项核对均为正则误报：`|| {}`、默认对象参数和传给文本节点的空属性对象被当作空函数体，搜索输入框的 HTML `placeholder` 被当作占位实现。它们均有实际逻辑和对应回归，不改写代码来迎合错误计分。该工具只识别了部分 JS 文件，不能据其原始分数宣称整个模块的健康度；本记录以真实执行、依赖方向和人工边界检查为依据。

主要剩余风险为工具版本差异、平坦 Vivado 图的规模及大模块布局成本；使用明确 provenance、真实工具夹具和硬预算限制范围。所有异常路径向用户报告或使当前任务失败，不用假布局替代失败数据。Yosys 参数与 WASI 文件系统兼容性诊断见 [bug 笔记](bugs/compat-yosys-script-arguments.md)。

## 完整文件清单

| 文件 | 改动 |
|---|---|
| `.github/workflows/ci.yml` | 干净 CI 安装根构建与测试依赖 |
| `.gitignore` | 允许提交公开电路 RTL 夹具 |
| `.vscodeignore` | 发布固定 ELK bundle 与许可，继续排除开发产物 |
| `ARCHITECTURE.md` | 电路模块边界、数据流、取消和容量设计 |
| `CHANGELOG.md` | 4.1 alpha 变更、动机和影响 |
| `CONTEXT.md` | 已发布基线、新工作树、验证与待办交接 |
| `NOTICE` | ELK 来源、版本和 EPL-2.0 许可说明 |
| `README.md` | 开发版本、电路入口与已发布 preview 下载 |
| `docs/CIRCUIT.md` | 用户配置、交互、数据语义、预算与验证指南 |
| `docs/ROADMAP.md` | 更新电路进度与候选项，保持 IP 延后、FSDB 取消 |
| `docs/V4_1_ALPHA1.md` | 本交付记录、限制和文件清单 |
| `docs/bugs/compat-yosys-script-arguments.md` | 真实参数、宏、WASI 路径问题的诊断与取舍 |
| `package.json` | 版本、命令、菜单、设置、固定开发依赖与构建测试入口 |
| `package-lock.json` | 固定 ELK/netlistsvg 及传递开发依赖 |
| `package.nls.json` | 电路命令和设置的英文文案 |
| `package.nls.zh-cn.json` | 电路命令和设置的中文文案 |
| `scripts/build-circuit-assets.js` | 从固定 npm 依赖复制 ELK 及许可 |
| `scripts/preview-circuit.js` | 回环地址预览，复用正式 Worker/页面，仅替换消息桥 |
| `scripts/test-circuit.js` | 枚举并运行电路回归 |
| `scripts/verify-circuit-host.ps1` | 隔离 VS Code 真实宿主验收启动器 |
| `scripts/verify-circuit-vivado.js` | 新建公开工程验证真实 Vivado 连接与只读性 |
| `scripts/verify-circuit.js` | 真实 Yosys → netlistsvg → 模型 → ELK 验证 |
| `src/circuit/adapters/vivado.js` | Vivado 导出格式到领域模型的严格转换 |
| `src/circuit/adapters/yosys.js` | Yosys 层级、参数、位序和源位置转换 |
| `src/circuit/client.js` | 页面导航、搜索、选择、详情、键鼠及状态 |
| `src/circuit/host.js` | ready 协议、对象 ID 白名单、世代与关闭取消 |
| `src/circuit/index.js` | 四个命令、配置、任务与编辑器接线 |
| `src/circuit/layout.js` | 按需 ELK 加载与几何校验 |
| `src/circuit/model.js` | 独立 Design schema、标识引用和数据预算 |
| `src/circuit/projection.js` | 模块连接投影、总线合并、方向及展示预算 |
| `src/circuit/renderer.js` | 纯文本 SVG、单元符号及高亮 |
| `src/circuit/session.js` | Worker RPC、超时、容量及销毁 |
| `src/circuit/source-request.js` | top 候选、有序配置及未保存正文快照 |
| `src/circuit/view.css` | 主题、布局、焦点与对象样式 |
| `src/circuit/view.js` | nonce CSP、静态页面与资源装配 |
| `src/circuit/vivado-export.js` | Tcl 调用包装与安全参数 |
| `src/circuit/vivado-export.tcl` | 只读 RTL 详细化和真实连接/总线导出 |
| `src/circuit/vivado-runner.js` | Vivado 任务、输出验证与失败诊断 |
| `src/circuit/worker.js` | 有界 UTF-8 读取、适配/布局和源位置回映射 |
| `src/circuit/yosys-runner.js` | Yosys 前端、宏包装、include 别名/快照与取消 |
| `src/editor/completion/index.js` | 复用统一生成目录排除策略 |
| `src/extension.js` | 独立激活电路模块 |
| `src/native/Cargo.lock` | native 版本同步 4.1.0-alpha1 |
| `src/native/Cargo.toml` | crate 版本同步 |
| `src/native/package-lock.json` | napi 包锁版本同步 |
| `src/native/package.json` | napi 包版本同步 |
| `src/workspace/source-policy.js` | 共享 `.svtools`、`.Xil` 等目录排除规则 |
| `src/workspace/sources.js` | 设计索引应用共享排除规则 |
| `test/circuit_host_test.js` | 消息协议、导航竞态、取消和错误恢复 |
| `test/circuit_layout_test.js` | 真实 ELK、多驱动/未知连接与投影预算 |
| `test/circuit_model_test.js` | 模型、Yosys 方言、位序和非法输入 |
| `test/circuit_pipeline_test.js` | 生成参数、快照、工具语义错误和取消 |
| `test/circuit_session_test.js` | 真实 Worker、导入/布局、UTF-8、退出和回映射 |
| `test/circuit_view_test.js` | 真实控制器、SVG、注入、手势、主题和恢复 |
| `test/circuit_vivado_runner_test.js` | 独立任务、超时、取消与输出校验 |
| `test/circuit_vivado_test.js` | 平坦连接、真实 BUS 元数据和未知单元 |
| `test/fixtures/circuit-demo.sv` | 层级、运算、存储器及总线公开验证语料 |
| `test/vscode_circuit_host.js` | 命令/真实 Webview/Worker/未保存快照宿主断言 |
| `test/workspace_test.js` | 生成目录排除的回归 |
