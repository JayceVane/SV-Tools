# 架构骨架与报告图

用于“先定模块边界和接口，再补 RTL 实现”。新架构默认通过 packed struct 声明虚拟端口，每个逻辑接口只占一个模块端口和一条连接。架构阶段可用整体 `inout axi4_t m_axi` 表达含双向成员的接口；不为出图强制拆开请求/响应或展开为物理引脚。接口成员、位宽、角色及收发约定在配套架构文档中声明。

## 端口约束

- `master` / `slave` 是架构角色。端口仍需显式指定 `direction`，整体双向接口可用 `inout`；一条连接表示接口相连，不代表所有成员都具有同一电气方向。
- 文档列出接口类型定义、成员宽度及角色相关收发约定。没有成员方向定义时标记未声明，不能仅从字段名推断；不要把虚拟 inout 当成最终 RTL 已完成方向约束或协议验证。用户要求按通道拆分时，也可以采用单独的 request/response struct。
- 新建骨架保持子模块体为空，顶层只组织声明和例化；暂不添加占位行为、常量驱动或完整控制逻辑。用户要求实现时，再按模块补行为并保留接口身份。
- 时钟与复位作为独立、方向明确的端口处理，不混入数据通道。当前 scaffold 只生成 struct 端口且顶层不暴露端口；有时钟、复位或板级顶层边界要求时，须在生成后补上对应 RTL 声明和连接再出图，不能声称生成器已经完成这些部分。
- 位宽来自用户约束或设计依据。scaffold 当前只接受整数宽度；未定宽度保留表达式并说明尚需确认，不能随意填 1 位来通过工具。
- 每个实例显式连接所有已声明端口；有意悬空使用 JSON `null`，生成 `.port()` 并返回 `UNCONNECTED_PORT` 提示。连接使用相同类型，总线只有一个 output 驱动；不能把检查通过称为功能验证通过。
- 新建骨架采用上述虚拟端口约定。分析已有 RTL 时保留其真实端口和用户命名；`--fold-ports` 只是显示折叠，不能替代对真实接口的声明与验证。这里的虚拟端口也不是 SystemVerilog class 中的 `virtual interface` 句柄。

## 最小流程

从 [architecture-interface-spec.json](../assets/architecture-interface-spec.json) 复制到目标工作区后修改接口、宽度与实例。这个例子使用一条 `control_link_t` 接口；文档中的示例约定是 request 由 controller 发往 engine，response 反向返回，这种约定并不由整体 inout 声明自动验证。需要分通道的任务可参考 [architecture-spec.json](../assets/architecture-spec.json)。

```text
node <svtools-root>/src/cli/main.js design scaffold --workspace <rtl-workspace> --spec architecture-interface-spec.json
node <svtools-root>/src/cli/main.js design arch --workspace <rtl-workspace> --top architecture_top
node <svtools-root>/src/cli/main.js design render --workspace <rtl-workspace> --top architecture_top --style document
```

检查返回的 `suggestions`、模块/实例端口、方向、位宽、`graph.edges`、未解析实例及 `limitations`。SVG 默认绘制实际声明的端口；对于上面的骨架，它们本身已经是虚拟端口，因此不需要额外折叠。

多个同前缀顶层引脚排成接口表，例如 DDR 地址、控制和数据。默认 `--detail interfaces`：每个模块与接口表之间使用一条汇总线，方向缩写（`i` 输入、`o` 输出、`io` 双向）只在表内逐行标注，不用箭头（左右两侧表中箭头含义会翻转）；表格分组不等于协议识别。底层 JSON 保留原始端口和连接，`--detail signals` 可用于信号级排查。`m_`/`s_`（含 m0_/s0_）只提示架构布局，不用于伪造驱动关系。

交付 SVG 及架构 Markdown：包含接口定义、模块接口分配、接口连接表与源码/图像身份。整体 inout 必须在图中保留连接，接口内容放进文档，不拆成每个成员的线路。确认标签可读、没有遮挡和裁剪；能看图时实际检查 SVG。图片内嵌源码哈希、上下文及导出参数，引用实际 artifact 路径和哈希。不同标题/粒度/折叠参数分别保留产物。程序化交付优先用 `design report` 一次导出证据包（SVG+PNG+`architecture.json`+`architecture.md`+`report.json` 哈希清单）；交付前用 `design check` 复核结构结论，检查表会进入报告。

## 能力边界

当前架构由 Yosys 的 `read_verilog -sv`、`hierarchy`、`proc`、`memory_collect` 得到，只投影顶层实例。它保留空模块，但并不支持完整 SystemVerilog/UVM 语言。无法展开的类型、宏、位宽或层级必须报告限制，不伪造结果。输入使用捕获文本的隔离副本；未被捕获的初始化数据或动态文件读取无法作为证据。`design check`（逐端口结构诊断）、`design diff`（快照对比）、无宿主 PNG（内置 resvg 栅格化）与 `design report`（证据包）已交付；任意深度层级展开仍未交付。scaffold 的规格检查仅覆盖其生成输入；`design check` 只报告结构事实，不代表综合结果、时序收敛、CDC 或功能验证。
