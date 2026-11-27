# 分层伪 SystemVerilog 建模与核验

## 创建架构工作区

- 架构设计和事后架构报告都新建独立的伪 SystemVerilog 工作区，包含顶层、子系统和接口定义。保留源文件作为可维护的交付物。
- 新设计从需求和工程约束拟定接口契约、时钟域、复位边界和设计取舍，把未决事项写进设计说明。
- 事后报告先确认原工程的顶层、文件集和版本，从 RTL、BD 和 IP 核实关键路径。在同一交付目录写一份来源映射，记录「虚拟模块或接口、对应的 RTL 实例／端口或 BD 对象、文件与行号、已核实或待确认」。保留原工程的当前快照标识。遇到编码、宏或生成文件边界，把缺失依据标为待确认。

## 分层和接口

- 顶层组织功能块与主要数据、控制和外部接口。时钟与复位按域分开，用明确的端口名和同名标签表示分发关系。
- **按功能和数据路径分组**。把共同完成一段功能的同层实例归到一组，例如视频处理链里的格式转换模块。卡片位置由布局引擎根据结构安排。HTML 点实例数或「组内连接」可打开整组互联图。
- 将复杂子系统写成包含内部例化的伪 SV 模块，以便阅读者逐层进入。简单叶子模块可以只声明接口。用 `groups` 给同层实例设置图面分组，用 `titles` 补充模块职责。
- 按协议或功能契约封装模块边界，覆盖 AXI、AXI-Stream、APB 等标准接口，以及有稳定成员和角色的项目接口，例如 `data/valid/ready` 数据流、`req/ack` 控制通道和成组视频信号。只用一次的规范接口也须封装。同一契约复用 `interface` 定义，位宽差异用参数表达，独立通道各自例化。
- `interface` 记录成员名和位宽，各端口以 `interface.modport` 声明输入、输出与双向成员。`data/valid` 从发送端流向接收端，`ready` 从接收端返回，逐项与实际契约核对。事后建模保留接口成员到原 RTL／BD 端口的映射，包括复用、自定义裁剪和实际的仲裁、选通或汇聚关系。
- **modport 角色名按方向约定命名**。查看器据此判定接口束的主流向，并为握手成员归类；自由命名会让方向退化为「待确认」。
  - 发起方：`master`、`source`、`initiator`、`tx`、`producer`
  - 接收方：`slave`、`sink`、`target`、`rx`、`consumer`
  - 观察方：`monitor`、`tap`（只读，由成员声明表达实际方向）
  - 同一接口的两端应成对（如 `master`/`slave`、`source`/`sink`）。多端共享束（中断汇聚等）可以各自命名，方向由成员声明决定。
- **握手成员用固定名字**：`valid`/`ready` 或 `req`/`ack`，不要在同一接口里混用 `vld`/`rdy`。只有 `valid` 与 `ready` 成对出现时，查看器才把它识别为双向握手并在图上标出正反向。
- 全双工总线（AXI、AHB 等）两端都驱动成员。除角色名外，查看器还会用「谁驱动的位数多」兜底判定主流向；两者都不成立时，图上如实显示为方向待确认，这通常说明 modport 声明缺成员或不完整。
- 独立时钟、复位和无共同事务语义的离散信号可保留普通端口。因协议、方向或连接依据不足而未封装的成组信号，在设计说明或来源映射中记录原因与待核实项。角色与协议以需求或原工程证据为准。
- 宽度及数据方向来自设计依据。未知部分保留表达式或说明，明确标记有意未连的端口。编译、复位时序、CDC 和握手行为由对应验证环节核对。

## 报告展示配置

将 `svtools.architecture.json` 放在模型工作区根目录。示例假定顶层 `architecture_top` 例化了 `u_arb` 和 `u_fifo`，两者通过 `packet_bus` 相连，`packet_fifo` 是 FIFO 的模块类型名。

```json
{
  "titles": { "architecture_top": "报文处理顶层", "packet_fifo": "报文缓冲" },
  "groups": { "architecture_top": { "u_arb": "报文通路", "u_fifo": "报文通路" } },
  "walkthroughs": {
    "architecture_top": {
      "steps": [{ "title": "仲裁送入缓冲", "description": "核对报文束两端的方向。", "links": ["packet_bus"] }],
      "clockResets": { "clk": "rst_n" }
    }
  },
  "designDocs": { "packet_fifo": "docs/packet_fifo/design.md" }
}
```

| 字段 | 填写规则 |
| --- | --- |
| `titles` | 键是模块类型名。顶层标题也从这里读取，省略时显示顶层模块名。 |
| `groups` | 外层键是父模块类型名，内层键是该父模块的直接实例名。简图把同一父章同名分组折成卡片，真实章节层级和端口绑定来自伪 SV。 |
| `walkthroughs` | 键是模块类型名，每步提供 `title`、`description` 和本章的接口连接名 `links`。失效或歧义的引用显示「未定位」。`clockResets` 只填有依据的时钟复位配对。 |
| `designDocs` | 键是模块类型名，值是模型工作区内的 UTF-8 `.md` 相对路径。可直接绑定交付用的 `design.md`。同类型的参数化章节显示同一份说明。HTML 可在章内展开，PDF 打印正文。报告保留文件路径和哈希，文档里的图片和链接以文字引用显示。 |

生成标题和分组时依据源级角色与连接。`groups` 的 JSON 键顺序可以按阅读顺序整理，图面列序由布局引擎确定。复杂子系统需要独立子章时，在伪 SV 中建立模块并实例化。绑定设计说明时，把对应版本的 Markdown 留在模型工作区，核对章内内容和 CLI 回执的 `data.designDocs`。修改已绑定文档后重新导出，使文档指纹和结构快照一致。

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
