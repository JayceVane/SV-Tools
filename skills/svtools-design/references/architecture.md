# 分层伪 SystemVerilog 建模与核验

## 创建架构工作区

- 架构设计和事后架构报告都新建独立的伪 SystemVerilog 工作区，包含顶层、子系统和接口定义。保留源文件作为可维护的交付物。
- 新设计从需求和工程约束拟定接口契约、时钟域、复位边界和设计取舍，把未决事项写进设计说明。
- 事后报告先确认原工程的顶层、文件集和版本，从 RTL、BD 和 IP 核实关键路径。在同一交付目录写一份来源映射，记录「虚拟模块或接口、对应的 RTL 实例／端口或 BD 对象、文件与行号、已核实或待确认」。保留原工程的当前快照标识。遇到编码、宏或生成文件边界，把缺失依据标为待确认。

## 分层和接口

- 顶层组织功能块与主要数据、控制和外部接口。时钟与复位按域分开，用明确的端口名和同名标签表示分发关系。
- 将复杂子系统写成包含内部例化的伪 SV 模块，以便阅读者逐层进入。简单叶子模块可以只声明接口。只为图面分组的同层实例通过 `svtools.architecture.json` 的 `groups` 命名，`titles` 补充模块职责。
- 按协议或功能契约封装模块边界，覆盖 AXI、AXI-Stream、APB 等标准接口，以及有稳定成员和角色的项目接口，例如 `data/valid/ready` 数据流、`req/ack` 控制通道和成组视频信号。只用一次的规范接口也须封装。同一契约复用 `interface` 定义，位宽差异用参数表达，独立通道各自例化。
- `interface` 记录成员名和位宽，各端口以 `interface.modport` 声明输入、输出与双向成员。`data/valid` 从发送端流向接收端，`ready` 从接收端返回，逐项与实际契约核对。事后建模保留接口成员到原 RTL／BD 端口的映射，包括复用、自定义裁剪和实际的仲裁、选通或汇聚关系。
- 独立时钟、复位和无共同事务语义的离散信号可保留普通端口。因协议、方向或连接依据不足而未封装的成组信号，在设计说明或来源映射中记录原因与待核实项。角色与协议以需求或原工程证据为准。
- 宽度及数据方向来自设计依据。未知部分保留表达式或说明，明确标记有意未连的端口。编译、复位时序、CDC 和握手行为由对应验证环节核对。

## 生成与抽查

```powershell
node <svtools-root>/src/cli/main.js design check --workspace <architecture-workspace> --top architecture_top --engine struct
node <svtools-root>/src/cli/main.js design export --workspace <architecture-workspace> --top architecture_top --format html --out architecture.html
node <svtools-root>/src/cli/main.js design export --workspace <architecture-workspace> --top architecture_top --format pdf --out architecture.pdf
```

导出前逐层检查模块端口和实例连接，确认成组接口已通过 `interface.modport` 声明并连接，遗漏的回到伪 SV 补齐。导出 HTML 后从顶层进入子系统，点开关键接口束核对端点、成员位宽和正反向信号，并核对例外说明与来源映射。检查 `chapterCount`、`interfaceCount`、`diagnostics` 和 `limitations`，沿用已核对的模型导出 PDF。发布时交付伪 SV 和 HTML／PDF，事后报告同时交付来源映射。

## 结构投影和骨架工具

`design arch`、`design render` 和 `design report` 用于结构检查、单张静态图或机器证据包。含 SV `interface` 或 `...` 的结构模型会自动选择 struct，也可以指定 `--engine struct`。Yosys 路径适用于支持的 RTL 静态投影。结构前端保留可解析的声明和端口，复杂宏、generate、类型与动态表达式仍有解析边界。

`design scaffold` 可从规格生成 packed struct 端口骨架。使用[整体接口规格](../assets/architecture-interface-spec.json)或[分通道规格](../assets/architecture-spec.json)时，按声明写明成员收发约定，并补齐所需的时钟、复位和板级边界。完整的分层交付优先使用上面的 `interface/modport` 工作流。
