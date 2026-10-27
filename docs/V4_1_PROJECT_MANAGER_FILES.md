# 统一工程管理变更清单

| 文件 | 改动 |
|---|---|
| `src/project/manager.js` | 工程选择、配置、目录跟随、成员与文件集修改；Vivado适配边界。 |
| `src/project/rtl-worker.js` | 默认静态追踪Worker，分别读取源码和字面头文件，不启动Yosys。 |
| `src/project/rtl-model.js` | 声明、参数、明确实例与端口连接的静态领域适配。 |
| `src/project/rtl-expression.js` | 有界整数求值和直接位表达式，不执行JS或宏。 |
| `src/project/signal-flow.js` | Worker内真实实例树、跨层级位映射和有界透传查询。 |
| `src/project/flow-controller.js` | 模型生成、选择跟随／固定、取消、源码快照与失效。 |
| `src/project/tree-model.js` | 文件角色汇总和实例角色投影，不生成信号树节点。 |
| `src/project/index.js` | 单侧边栏宿主、工程切换、令牌化动作和源码定位。 |
| `src/project/view.js` | 主题化Webview与本地脚本CSP。 |
| `src/project/client.js` | 右侧角色标记、提示、文件／实例切换、菜单与展开状态。 |
| `src/extension.js` | 共享工程上下文接线，切换使源码清单世代失效。 |
| `src/workspace/project-sources.js` | 两类工程统一提供源文件集合。 |
| `src/vivado/index.js` | 注入统一选择适配器，保留Vivado执行器。 |
| `src/vivado/projectTree.js` | 复用原管理命令，界面由单一Webview呈现。 |
| `src/circuit/worker.js` | 在已验证设计世代上注册工程透传查询。 |
| `src/circuit/session.js` | 共享RPC生命周期，可由可信构造参数选择独立Worker。 |
| `src/editor/completion/syntax.js` | 导出已有顶层分组工具，避免重复词法逻辑。 |
| `package.json` | 单视图类型、入口菜单及新增测试。 |
| `.gitignore` | 纳入可复现的工程管理宿主验收脚本。 |
| `package.nls.json`、`package.nls.zh-cn.json` | 工程入口与命令中英文文本。 |
| `test/project_manager_test.js` | 配置、成员、工程切换与并发选择合同。 |
| `test/project_signal_flow_test.js` | 层级、常量、实例隔离、逻辑边界及真实工具映射。 |
| `test/project_rtl_test.js` | 静态后端、独立时间声明、参数位宽、条件边界、include与世代回归。 |
| `test/project_view_test.js` | 宿主动作用途与过期节点防护。 |
| `test/project_client_test.js` | 实际页面脚本和按工程保存状态。 |
| `test/vscode_project_host.js` | 隔离编辑器的端到端功能验收。 |
| `scripts/verify-project-host.ps1` | 启动隔离且隐藏的测试宿主，留存报告。 |
| `ARCHITECTURE.md` | 统一工程与透传模型边界。 |
| `CONTEXT.md` | 本地开发状态、验收与下一步交接。 |
| `CHANGELOG.md` | 本轮功能与影响范围。 |
| `docs/bugs/logic-project-context-notification.md` | 延迟文件事件误取消分析的根因与回归记录。 |
| `docs/bugs/compat-yosys-systemverilog-frontend.md` | 增补编译单元冲突根因、静态后端取舍与无工具验收。 |
| `docs/V4_1_PROJECT_MANAGER.md` | 用法、配置与实际能力限制。 |
| `docs/V4_1_PROJECT_MANAGER_FILES.md` | 本变更清单。 |
