# 4.1 M2文件清单

功能、验收和限制见[M2记录](V4_1_M2.md)。以下38个版本控制文件属于本轮；`bin/`仅保存本地验收产物，`src/private/`未修改。

| 路径 | 改动 |
|---|---|
| [.gitignore](../.gitignore) | 纳入真实IDE追踪验收脚本 |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | 记录M2来源、投影、导航与页面边界 |
| [CHANGELOG.md](../CHANGELOG.md) | 记录M2功能及影响范围 |
| [README.md](../README.md) | 更新4.1开发进展和使用入口 |
| [CONTEXT.md](../CONTEXT.md) | 保存阶段交接及尚未完成的视觉验收 |
| [docs/V4_1_PLAN.md](V4_1_PLAN.md) | 更新M2结果和M3门槛 |
| [docs/V4_1_M2.md](V4_1_M2.md) | 使用方式、容量、性能、验收与限制 |
| [docs/V4_1_M2_FILES.md](V4_1_M2_FILES.md) | 保存本轮完整清单 |
| [docs/bugs/logic-circuit-source-trace-identity.md](bugs/logic-circuit-source-trace-identity.md) | 记录Slang位置、容错解析与作用域错配陷阱 |
| [package.json](../package.json) | 注册两项源码追踪命令及RTL菜单 |
| [package.nls.json](../package.nls.json) | 英文命令名称 |
| [package.nls.zh-cn.json](../package.nls.zh-cn.json) | 中文命令名称 |
| [scripts/benchmark-circuit-trace-view.js](../scripts/benchmark-circuit-trace-view.js) | 固定规模的Worker至ELK性能基准 |
| [src/circuit/adapters/yosys.js](../src/circuit/adapters/yosys.js) | 保留可用的网络源码位置 |
| [src/circuit/model.js](../src/circuit/model.js) | 验证并保留信号源码字段 |
| [src/circuit/layout.js](../src/circuit/layout.js) | 全模块与局部图共用布局接口 |
| [src/circuit/worker.js](../src/circuit/worker.js) | 接入来源、局部布局、上下文和取消RPC |
| [src/circuit/host.js](../src/circuit/host.js) | 面板导航、局部图消息与受限源码动作 |
| [src/circuit/index.js](../src/circuit/index.js) | 编辑器命令、候选选择、快照与跳转校验 |
| [src/circuit/source-snapshots.js](../src/circuit/source-snapshots.js) | 有界内容身份、生成后验证和声明定位 |
| [src/circuit/source-watch.js](../src/circuit/source-watch.js) | 监听本次输入的编辑变更并提示过期 |
| [src/circuit/trace-source.js](../src/circuit/trace-source.js) | 声明作用域、静态位和真实实例匹配 |
| [src/circuit/trace-projection.js](../src/circuit/trace-projection.js) | 局部结果合并、原位裁剪与常量隔离 |
| [src/circuit/trace-view.js](../src/circuit/trace-view.js) | 边界重放、布局、锚点与迟到结果失效 |
| [src/circuit/trace-controller.js](../src/circuit/trace-controller.js) | 历史、展开树、关注对象与操作代次 |
| [src/circuit/trace-actions.js](../src/circuit/trace-actions.js) | 当前图到原始位身份的共享映射 |
| [src/circuit/trace-client.js](../src/circuit/trace-client.js) | 追踪控件、状态及分支动作 |
| [src/circuit/client.js](../src/circuit/client.js) | 接入追踪、相机连续性、历史与过期提示 |
| [src/circuit/renderer.js](../src/circuit/renderer.js) | 绘制新增节点和固定关注状态 |
| [src/circuit/view.js](../src/circuit/view.js) | 追踪导航、位选择及详情动作布局 |
| [src/circuit/view.css](../src/circuit/view.css) | 紧凑追踪面板、焦点和新增部分样式 |
| [test/circuit_host_test.js](../test/circuit_host_test.js) | 验证真实实例面包屑身份 |
| [test/circuit_trace_session_test.js](../test/circuit_trace_session_test.js) | 超全图预算局部ELK与过期世代回归 |
| [test/circuit_view_test.js](../test/circuit_view_test.js) | 控件、忙碌、相机、搜索、过期及释放回归 |
| [test/circuit_trace_projection_test.js](../test/circuit_trace_projection_test.js) | 位下标、常量隔离、合并与模型不可变回归 |
| [test/circuit_trace_source_test.js](../test/circuit_trace_source_test.js) | 来源、遮蔽、条件编译、快照和队列预算回归 |
| [test/circuit_trace_view_test.js](../test/circuit_trace_view_test.js) | 连续展开、历史、关注、收起和迟到布局回归 |
| [test/vscode_circuit_trace_host.js](../test/vscode_circuit_trace_host.js) | Qoder和VS Code真实命令流程验收 |
