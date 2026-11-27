# 架构 CLI 参考

## 分层架构文档

先按[建模与核验约定](architecture.md)建立独立的伪 SystemVerilog 工作区。新设计和事后报告使用同一个导出命令。

```powershell
node <svtools-root>/src/cli/main.js design export --workspace <architecture-workspace> --top architecture_top --format html --out architecture.html
node <svtools-root>/src/cli/main.js design export --workspace <architecture-workspace> --top architecture_top --format pdf --out architecture.pdf
```

`design export` 由 `doctor` 声明。它使用与架构查看器相同的 struct 结构模型、布局与导出逻辑。复杂模块默认使用简图，简单模块默认显示完整连线。输出有目录、子模块章节、模块端口图、接口定义及成员方向。Vivado XPR 工程用于取证，导出的输入是单独的伪 SV 工作区。

默认格式为 HTML。PDF 使用 Edge、`SVTOOLS_PDF_BROWSER` 或显式的 `--browser <exe>`。指定 `--out` 时给出工作区内的文件路径，后缀与格式一致，已有同名文件需另选路径。省略 `--out` 时写入 `.svtools/agent/architecture/`。

JSON 返回 `data.chapterCount`、`data.interfaceCount`、结构快照 `data.revision`、输入文件指纹 `data.sourceFiles` 和 `data.limitations`。`artifacts[]` 提供实际文档位置、SHA-256 与字节数。`diagnostics[]` 包含结构解析和各模块章节的检查结果。接口同一成员有多个已声明的输出端时，`ARCH_INTERFACE_MULTI_DRIVER` 标记需要复核的仲裁或汇聚。命令成功表示文档已生成，结构与功能结论需分别核对。

## 结构快照与静态投影

```powershell
node src/cli/main.js design arch --workspace D:/project --top top
node src/cli/main.js design arch --workspace D:/project --top top --depth 1 --save arch-1
```

`design arch` 从已捕获文本建立隔离快照，字面量 include 改写到快照，源码位置映射回原文件；CLI 在返回/导出前复查上下文，变更时返回 `CONTEXT_CHANGED`。宏 include 返回 `UNSUPPORTED_INCLUDE`；未捕获的初始化数据不从实时工程补读。Yosys 路径链接空模块，依次执行 `read_verilog -sv`、`hierarchy -top <top>`、`proc`、`memory_collect`、`write_json`。Yosys 保留未连接的实例。图按顶层实例和边界端口组织，省略顶层运算和存储产生的内部单元。实例盒位宽以参数覆盖后的连接为准，模块接口表保留声明默认值。

工程中存在 SV `interface` 或实现省略符 `...` 时，架构命令选用结构前端。`--engine struct` 和 `--engine yosys` 可以显式选择。结构模型保留 `interface/modport` 的声明成员和方向，图上把接口呈现为共享总线。复杂表达式和模板实例需要结合诊断。结构输出供架构设计和审阅使用。

```powershell
node src/cli/main.js struct parse --file rtl/top.sv
node src/cli/main.js design arch --top top --engine struct --save before
node src/cli/main.js design render --top top --engine struct --format svg
node src/cli/main.js design check --top top --engine struct
node src/cli/main.js design lower --file rtl/top.sv
node src/cli/main.js design diff --top top --baseline before
```

`data` 关键字段：

- `schemaVersion`、`stage`（`source`）、`top{name,moduleId,file}`、`designId`、`modelSha256`（=`archSha256` 的明确映射）、`archSha256`、`contextRevision`、`sourceFiles[]{path,sha256}`（工作区源码/头文件的内容身份）；
- `modules[]`：架构用到的模块接口表，`id`、`name`（`$paramod\...` 还原为基础模块名+参数摘要）、`file`、`blackbox`、`empty`、`blackboxSource`（`yosys`|`structure`）、`parameters`、`ports[]{name,direction,width,source}`、`bundles[]`；
- `instances[]`：顶层实例表，`name`、`module`、`moduleId`、`implementation`（`blackbox`|`collapsed`）、`empty`、`blackboxSource`（`yosys`|`structure`）、`status`（`resolved`|`unresolved`）、`ports[]`、`bundles[]`、`source`；`implementation=blackbox` 既包括 Yosys blackbox 属性，也包括结构空模块（无 cells/processes/memories 且端口无别名/常量驱动，如 packed struct 端口的骨架模块），后者 `blackboxSource=structure`；纯 alias（`assign y=a`）、常量 assign、含 assign 表达式/always_ff 等逻辑的模块为 `collapsed`；
- `bundles[]`（模块/实例均含，additive，端口事实不变；**仅 opt-in 渲染使用**）：`name`、`prefix`、`direction`（`input`|`output`|`inout`）、`bits`、`members[]{name,width,direction}`。按端口名第一个 `_` 前的 token 建桶（如 `m`、`s0`、`s`、`ddr`），桶内先算公共前缀（去掉末尾 `_`）；**仅当前缀比桶键更长，或前缀与桶键等长且桶键长度≥2 时折叠**，否则桶内成员逐一保留为单成员端口（成员守恒）。因此 `m_axi_araddr`/`m_axi_rdata` 折叠为 `m_axi`，同桶的 `m_valid` 单独成束；`s0_*`/`m0_*`/`ddr_*` 正常折叠；单字母桶 `s_awaddr`/`s_wdata`（key=`s`，前缀=`s`）不折叠。成员方向混合时 `direction="inout"`；`clk_*`/`rst_*` 等时钟复位端口保持独立单成员，避免 `clk_sys`/`clk_pix` 误合并；
- `interfaces[]`：架构接口束，`id`、`from{kind,name}`、`to{kind,name}`、`direction`（`forward`|`bidirectional`|`connection`）、`bits`、`label`、`signals[]{name,width,direction}`、`fromPorts[]`/`toPorts[]`（端点实际端口名）。`connection` 表示共享网络相连，布局起点不代表电气驱动方向，其成员方向为 `unknown`，`bindings[]` 保存实际端口连接。已知方向的实例连接先合并双向对，再合并同源端口集合相同的扇出接口（`to.name` 用 `+` 连接多个实例）；实例↔边界按顶层端口前缀（如 `uart*`、`spi*`、`vin*`）聚合，`clk_in`/`rst_n_in`/`gpio` 等保留为独立束。`label` 优先取时钟/复位语义，其次成员信号公共前缀，否则用最多两个信号名摘要，长度不超过 48 字符；完整成员在 `signals[]` 与 SVG `<title>`；
- `unresolved[]`：工作区未声明的子模块，逐条带 `source`，不伪造端口表（图上为无端口盒，结构检查属 D2）；
- `graph`：`nodes[]`（`boundary` 顶层端口边界 / `instance` 实例盒，含 `label`、`ports`）、`edges[]`（`source`/`target`、`sourceNode`/`sourcePort`、`targetNode`/`targetPort`、`width`、`netNames`）与 `stats`（实例、边界、边与位宽统计、`depth`）；
- `checks[]`：结构诊断（见 `design check`），随架构数据一并返回并计入 `archSha256`；
- `limitations[]`：静态结构边界（未综合、不展开子层、IP/BD 等）。

`--depth` 当前固定按顶层实例投影（大于 1 尚未展开子层，在 `limitations[]` 说明）。`--save <name>` 把架构 JSON 写入 `.svtools/agent/design/<name>.json`，供后续 `design diff` 使用（同名快照直接覆盖）。实例间整体 inout 接口按共享网络生成 `direction=connection` 的架构连接，无须拆开成员；没有确定驱动方向的位仍计入 `graph.stats.ambiguousBits`，不当作电气方向已验证。Yosys 失败时保留 `.svtools/agent/design/runs/<uuid>` 任务目录作为日志 artifact，当前无自动淘汰。

`design scaffold --spec <json|file> [--out <dir>] [--force]` 按 schemaVersion=1 规格生成架构骨架（默认 `rtl/<top>.sv`）：`typedef struct packed {...} <type>_t;` 虚拟接口、只含 struct 端口的空模块、顶层 struct 总线 wire 与实例化连线。`--spec` 可为规格 JSON 文件路径（相对工作区解析）或内联 JSON（以 `{` 开头）；文件不存在返回 `INVALID_ARGUMENT` 并提示解析后的绝对路径。`--out` 必须是工作区内的目录（创建后按 realpath 复核，拒绝 symlink/junction 逃逸）；目标文件已存在且无 `--force` 时返回 `FILE_EXISTS`，`--out` 指向已有普通文件或非法路径返回 `INVALID_ARGUMENT`，写入失败返回 `DESIGN_FAILED`。主设备 `m_`/从设备 `s_` 命名是 Skill 建议而非门禁：不合建议时生成照常成功，并在 `data.suggestions[]` 返回 `{code:"PORT_NAMING",module,port,message}`，不产生 error diagnostics；其余规格问题返回 `INVALID_ARGUMENT`。规格结构：

默认接口级示例见 [architecture-interface-spec.json](../assets/architecture-interface-spec.json)：每个模块用一个整体 inout packed struct 端口连接逻辑接口，成员内容和收发约定写入架构文档。需要按通道区分方向时，可参考 [architecture-spec.json](../assets/architecture-spec.json)。`master/slave` 是接口角色，不等同于输出/输入。每个端口必须显式指定 `direction`，每个实例必须列出所有端口；显式 `null` 表示有意悬空并产生 `UNCONNECTED_PORT` 提示。生成前拒绝遗漏连接、已知方向的总线多驱动与无驱动输入；整体 inout 的成员方向不在这项检查范围内。

规格骨架可用 `design scaffold` 生成虚拟端口与空模块，再用 `design arch --top <top>` 和 `design render` 检查静态投影。时钟与复位独立声明，当前 scaffold 仅支持 struct 端口，板级顶层端口需要补充声明。分层架构文档使用 `design export`。综合、时序及功能结论来自各自的验证环节。

`design render` 用纯 Node 字符串生成自含 SVG（不依赖编辑器 DOM）：

```powershell
node src/cli/main.js design render --workspace D:/project --top top
node src/cli/main.js design render --workspace D:/project --top top --style presentation --out docs/arch --title "SoC 架构"
node src/cli/main.js design render --workspace D:/project --top top --boundary-layout ends
node src/cli/main.js design render --workspace D:/project --top top --fold-ports
node src/cli/main.js design render --workspace D:/project --top top --fold-ports --bundle-name s0=s0_axi --bundle-name m0=m0_axi
```

默认 `--style document`（黑白线稿，面向报告）：纯白背景、黑色描边、无彩色（黑白灰阶：#000/#111/#333/#fff/#f5f5f5 等 R=G=B）、无渐变/阴影；collapsed 实线 1.2px、blackbox 虚线（6,4）、unresolved 点线（2,3）并带文字角标；节点标题行浅灰底，端口/接口标签为黑色无衬线文本。`--style presentation`（别名 `ui`）保持电路视图深色展示主题，边界输入/输出/双向分别使用 theme input/output/inout 语义色。两种风格共用同一 ELK 布局坐标，仅替换配色与线型，并各自可确定性重渲染。

`design render` 和 `design report` 都支持 `--boundary-layout auto|ends`，默认 `auto`。两端布局把输入放左侧、输出和独立双向端口放右侧；混合方向的接口表在输入成员过半时靠左，其余靠右。接口表位于同侧普通端口外面，表内逐行保留真实方向。

以 `graph.edges` 的真实端点绘制连线；只在成员落在同一显示端口时聚合，旧数据缺少信号边时回退到 `interfaces[]`。默认按接口粒度绘制：每个模块与边界接口表之间合成一个虚拟锚点和一条汇总线，原始 `ports[]` 和连接仍保存在 JSON。`--detail signals` 才使用逐行物理锚点；只有显式 `--fold-ports` 才把 blackbox 与 collapsed 实例按 `bundles[]` 折叠为虚拟接口端口：多成员束标签为 `<name>* (N bits)`、混合方向为菱形 inout，端口 `<title>` 列出全部成员名与位宽；`--bundle-name <prefix>=<display>` 仅与 `--fold-ports` 同时有效，用于覆盖显示名。虚拟端口仅改变展示，不改变 `ports[]`/`bundles[]` 或 RTL 事实，图例与 limitations 明确标注「前缀折叠展示，inout 仅为架构示意」。实例与边界盒带端口标签，同一个完整源端口的多目标连接经主干扇出（不同切片不合并）（`stats.junctions` 与 evidence `export.junctionCount`），接口标签为 `label (N bits)` 并保留完整成员名在 `<title>` 中。ELK layered 使用交叉最小化与直边优先布局，连线标签作为有尺寸的布局对象预留空间，层间距按标签与线路需要扩展；宽高比作为偏好，验收以节点/标签不重叠和真实端点为准。默认输出 `.svtools/agent/design/render/<top>-<archSha前8位>-<导出参数摘要>-<style>.svg`，`--out` 指定目录（与 scaffold 同一安全模型：必须是工作区内的目录，按 realpath 复核、拒绝 symlink/junction 逃逸，越界或非目录返回 `INVALID_ARGUMENT`，写入失败清理本轮创建的目录）；图例按画布宽度自动换行，画布高度随图例行数扩展。`data`/`artifacts[]` 返回 `{kind:"image",format:"svg",path,sha256,bytes,width,height}`。SVG 根内 `<metadata id="svtools-evidence">` 含 `designId`、`modelSha256`（`archSha256` 的明确映射）、`archSha256`、`contextRevision`、`top`、`sourceFiles[]{path,sha256}`、`layout.engine`、`export`（含 `style`、`junctionCount`、`bundled`、`bundleCount`），`design.render` 的 `data.evidence` 与之一致；节点与端口带 `data-model-id`；同一输入、同一 detail 和风格的两次渲染节点坐标与 SVG SHA-256 完全一致。文本均为可选中 `<text>`。

渲染预算：节点 2000、接口/连边 6000、端口 16384，超出返回 `DESIGN_LIMIT` 且不落盘。`--format svg|png`（默认 svg）：PNG 用内置 resvg（`bin/resvg.*.node`，随 VSIX 发布，无编辑器宿主）对同一份 SVG 做 2x 栅格化，`data` 返回 `scale`、像素尺寸与 `sourceSha256`（源 SVG 哈希）；栅格化组件缺失返回 `TOOL_NOT_FOUND`。中文依赖系统字体，文档建议先用 SVG。

同一前缀的一组顶层端口（例如 `ddr_addr`、`ddr_ba`、`ddr_dq`）默认合成一张边界接口表，列为信号、相对顶层的方向和位数。各行保留原始端口 ID 与方向缩写（`i` 输入、`o` 输出、`io` 双向；全词在悬停 `<title>`，避免箭头在左右两侧表中含义翻转），表外默认一条汇总线；时钟、复位和单成员信号继续独立显示。分组只来自完整名称前缀，不代表工具识别或验证了 DDR/AXI 协议。`stats.boundaryTables` 与 SVG 证据的 `boundaryTableCount` 给出表格数量，领域模型 `graph.nodes/edges` 保持原始事实。整体 inout struct 可作为架构虚拟接口，成员内容及收发约定由配套文档声明，不强制拆分请求响应。新模型的顶层 inout 同时记录逐端口 `interfaces[].bindings`，保证表内的双向行有精确锚点。`m_`/`s_` 名称可提示请求和响应放在相对的一侧，不改变端口的真实方向。

错误码：`AMBIGUOUS_MODULE`（工作区同名模块声明，`data.candidates[]` 给出全部 `{name,file,line}`，exit 2）、`MODULE_NOT_FOUND`（`--top` 未命中）、`DESIGN_LIMIT`（架构模块 4096、实例 20000、边 50000、结构诊断 5000；渲染节点 2000、接口 6000、端口 16384；超出不产出部分模型或半成品）、`TOOL_NOT_FOUND`（内置 Yosys 或 resvg 栅格化资源缺失）；单源文件 8 MiB 与源码总量属上下文预算，超限返回 `SOURCE_LIMIT`，不映射为 `DESIGN_LIMIT`；其余 Yosys/导出失败返回 `DESIGN_FAILED` 并附日志 artifact。

`design check --top <module>` 对同一架构数据做结构检查，逐条指认问题而不是只给位计数。诊断随 `design arch` 的 `data.checks[]` 一并返回，check 命令把它们提升为顶层 `diagnostics[]`：存在 error 级问题时 `status=failed` 且 exit 1（对齐 lint：检查完成但工程有结构错误），仅 warning 时 exit 0，`data.status` 为 `errors|warnings|clean`。诊断码与语义：

- `UNRESOLVED_MODULE`（error）：实例引用工作区未声明的子模块，按无端口盒展示；
- `UNDRIVEN_INPUT`（error）：input 端口未连接（悬空），或所在网络没有任何驱动（`netNames[]` 给出网络名）；
- `MULTI_DRIVER`（error）：同一网络被多个输出端口驱动，`drivers[]` 列出全部 `实例/端口`；
- `UNCONNECTED_PORT`（warning）：output/inout 端口未连接（常见有意悬空，不阻断）；
- `UNDRIVEN_OUTPUT`（warning）：顶层输出端口没有被任何实例驱动；
- `WIDTH_MISMATCH`（warning）：连接的网络窄于端口声明，其余位由工具隐式补常量（`connectedWidth`/`declaredWidth`/`implicitBits`）；宽 wire 连窄端口的截断在 Yosys 展开后不可见，不虚构报告。

网络分析只统计网络 bit：常量驱动（如 `.rst_n(1'b0)`）是值不是连接，不产生假边、假多驱动或假无驱动诊断。诊断带源码位置（`source{file,line,column}`，模块端口声明处）；同一源码的检查结果确定。结构检查不构成功能、时序或 CDC 验证。

`design diff --top <module> --baseline <save名|快照路径>` 比较基线快照与当前架构，报告补实现前后的结构差异。`--baseline` 先按 `design arch --save` 的快照名（`.svtools/agent/design/<name>.json`）解析，也接受工作区相对的快照文件路径；基线不存在、不是 schemaVersion=1/stage=source 快照或顶层与 `--top` 不一致均返回 `INVALID_ARGUMENT`。`data.diff` 按身份报告差异：实例按名称、模块与接口按归一化 id、顶层端口按名称、源文件按路径，各维度给出 `added/removed/changed`（`changed` 记录 `{field:{baseline,current}}`，端口按 `名称:方向:位宽` 签名比较）；空骨架（blackbox）变为已实现（collapsed）的实例单独列入 `implemented[]` 与 `summary.implementedInstances`。源码未变时 `data.status=unchanged`。diff 只报告差异，不判断好坏；基线身份（`name/path/archSha256`）随结果返回可追溯。

`design report --top <module> [--out <dir>] [--style document|presentation] [--title <t>]` 一次导出报告证据包（默认 `.svtools/agent/design/report/`）：同一架构的 `SVG`、`PNG`（2x 栅格化）、`architecture.json`（含 checks 的完整模型）、`architecture.md`（图 + 模块接口分配表 + 接口连接表 + 结构检查表 + 可追溯性）与 `report.json`（产物清单与哈希、导出参数、evidence）。Markdown 表格方向缩写与 SVG 边界接口表一致（端口 `i/o/io`；连接以端点 A 为视角 `o`/`io`/`bus`，`bus` 表示共享网络、成员方向未声明）。`--out` 与 render/scaffold 同一安全模型。结构存在 error 时报告仍生成（生成不等于结构合格），结论看 `data.checksSummary` 与 Markdown 检查表。
