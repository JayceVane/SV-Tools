# 电路结构查看器（4.1 alpha）

## 目标与数据来源

在编辑器里查看 RTL 生成的电路连接，核对模块、寄存器、MUX、运算和存储器。技术路线为真实 Yosys JSON → netlistsvg 对照 → 独立电路模型 → ELK.js + SVG 交互；Vivado 适配同一模型。netlistsvg 用于开发验收，不参与运行时显示。

电路来自工具的详细化或综合结果，源码索引只负责选择 top。未使用逻辑可能被移除，参数和 generate 会被展开，视图不保证逐语句对应源码。UVM、class、动态数组等仿真行为不能因此变成可综合电路。与 VCD 波形查看器的数据和容量策略相互独立。

## 使用

命令面板搜索“电路结构”（英文界面搜索 Circuit）：

| 命令 ID | 操作 |
|---|---|
| `svtools.circuit.fromSource` | 当前 `.v` / `.sv` 调用本地 Yosys 生成并显示 |
| `svtools.circuit.open` | 导入已有 Yosys JSON 或本插件 Vivado 导出 JSON |
| `svtools.circuit.fromVivado` | 读取当前选中 XPR，执行只读 RTL 详细化并显示 |
| `svtools.circuit.stop` | 停止电路生成及顶层扫描 |

RTL 编辑器右键也有入口。Vivado 入口复用现有面板的工程选择与 `svtools.vivado.path`，不修改用户的工程配置。生成物和日志放在工作区 `.svtools/circuit/` 的独立任务目录，工程/补全索引会忽略这些目录。

当前未保存的编辑器正文会生成任务快照，不保存、格式化或替换磁盘文件；工具返回的快照位置回映射到原文件。其他源文件从磁盘读取。源码定位只接受模型中已有位置，并在宿主核对真实路径范围。

## Yosys 配置

VSIX 不捆绑 Yosys。使用本机可执行文件，或安装工具后通过 PATH 查找；导入已有 JSON 无需安装。前端能力取决于所配置 Yosys 及其插件。

```json
{
  "svtools.circuit.yosysPath": "yosys",
  "svtools.circuit.frontend": "verilog",
  "svtools.circuit.top": "my_top",
  "svtools.circuit.sources": ["rtl/package.sv", "rtl/child.sv", "rtl/top.sv"],
  "svtools.circuit.includeDirs": ["rtl/include"],
  "svtools.circuit.defines": ["SYNTHESIS", "WIDTH=8"],
  "svtools.circuit.generationTimeout": 120
}
```

路径相对当前文件所属工作区根目录解析，绝对路径也可用；`sources` 是有序文件列表，当前文件若未包含则追加，不展开 glob。未设置 top 时从当前文件列出模块供选择。生成入口只接受普通 ASCII HDL 模块名；带转义名称的设计可以外部生成 JSON 后导入。

`verilog` 使用 `read_verilog -sv`，适用范围由 Yosys 内建前端决定。需要更完整 SystemVerilog 时选择 `slang`，要求工具提供 `read_slang` 插件；本机未装插件时会报告工具错误，不会静默换前端。生成采用 `prep`，保留层级和已收集存储器；导入含未降低 process/memory 的原始中间 JSON 会明确提示先运行 `proc` / `memory_collect` 或 `prep`。

宏以 `NAME` 或 `NAME=正文` 形式配置，保留正文中的空格及引号，不支持换行宏。生成器用独立 HDL 包装文件传递宏和有序 include，避免不同前端的命令行引号差异。include 路径含空格时使用任务内安全别名；原生 Yosys 用目录链接，识别出的 `yowasp-yosys` 用有预算的目录快照以适配 WASI。WASI 快照遇到符号链接或超预算会报错，可改用原生 Yosys或缩小 include 目录。

## Vivado 数据

本版调用 `open_project -read_only` 与 `synth_design -rtl`，输出标明 `vivado / elaborated-rtl / flat`。单元使用完整实例路径，但不提供可下钻的 Vivado 模块树。跨层级网络使用真实 segments 与 canonical net 归一，避免同名局部网络误连。

升序、降序、非零/负起点总线按真实 BUS 元数据还原。黑盒保留为未知实例；稀疏内部总线不补造缺失位。可显示寄存器、算术、逻辑、常量和存储器类单元，但不是门级时序、布局布线或时序报告视图。真实验收使用 Vivado 2022.1.2；其他版本需复验 Tcl 对象属性与导出格式。

## 交互

拖动画布平移，滚轮以指针为中心缩放；工具栏可放大、缩小和适配。点击单元、引脚或网络查看位宽、方向、参数、别名、源位置与端点；同一网络的分支和端点一起高亮。工具生成的长单元名显示短标签，完整名保留在提示、搜索与详情里。

双击有层级的实例或点击“进入模块”下钻，返回/顶层与模块选择器切换视图。搜索单元、端口或网络，Enter 依次定位匹配。焦点在画布时，方向键平移，`F` 适配，`+` / `-` 缩放，Enter 进入实例，`Alt+←` 返回，Escape 取消拖动或选择。输入框内的编辑键不被画布截获。

模型采用模块局部位 ID 和 LSB-first 数组，不按显示名称推断连接；总线绘制合并不丢弃位映射。多驱动、无驱动、未知方向用显式节点保留。输入端口在内部图上驱动逻辑，详情仍显示 HDL 声明的 input。页面跟随 VS Code 主题；nonce CSP、SVG 文本节点与 ID 消息限制不允许网表名称变成 HTML 或脚本。

## 当前容量边界

| 边界 | 限制与行为 |
|---|---|
| JSON 读取 | 单个普通文件最多 64 MiB；严格 UTF-8，可带 BOM |
| 模型 | 最多 2,000,000 个位引用，含端口/单元/别名的引用次数 |
| 当前模块投影 | 最多 2,000 个展示节点、6,000 条边、16,384 个引脚、200,000 个位引用 |
| Worker | 每面板独立、堆预算 384 MiB；单请求 60 秒，最多 8 个在途请求 |
| 页面消息 | 单个结果最多 16 MiB；模块目录先到达，布局失败仍可选择较小模块 |
| 生成 | 默认 120 秒，可配置 5–600 秒；源文件、include 目录、宏各最多 4,096 项 |
| 未保存文件 / 顶层扫描 | 正文最多 16 MiB；扫描在 Worker 执行 |
| WASI include 快照 | 所有目录合计最多 64 MiB、4,096 文件、16,384 目录项，不跟随符号链接 |
| 详情 | 位列表显示前 256 项并明确标注截断；模型保留全部位 |

这些是保护交互和宿主的预算，不是已完成任意大电路支持的宣称。暂未实现逻辑锥、跨次生成缓存、增量布局或网表按需分页。超大模块需在生成时缩小 top，或从可读 JSON 的模块选择器打开较小模块；超 JSON/模型总预算则不能导入。

## 验证与开发

固定开发依赖 `elkjs@0.12.0`、`netlistsvg@1.0.2`。只有未修改的 ELK bundle 及 EPL-2.0 许可进入 VSIX。工具生成物、验证工程、Python/WASM 工具和测试夹具均不进入发布包。

```powershell
npm.cmd ci
npm.cmd run test:circuit
node scripts/verify-circuit.js --yosys <yosys可执行文件>
node scripts/verify-circuit.js --yosys <带slang的yosys> --frontend slang
node scripts/verify-circuit-vivado.js --vivado <Vivado安装目录>
./scripts/verify-circuit-host.ps1 -CodePath <Code.exe> -YosysPath <yosys可执行文件>
```

Yosys 验证从公开 RTL 创建独立夹具，检查宏、空格 include 路径、参数化层级、寄存器、MUX、加法器、存储器和升序/非零起点位映射，然后执行真正的 netlistsvg 与 ELK。Vivado 验证新建独立工程，核对跨层连接和 I/O buffer，并逐文件比较工程树 SHA256，验证只读流程未改变工程文件内容。

宿主验收使用独立用户目录、扩展目录和公开夹具；`-ExtensionPath` 可指定解包后的 VSIX，核对命令注册、真实 Webview ready 消息、Worker 布局及未保存快照。浏览器预览脚本仅替代宿主消息桥，用于图形交互与主题验收；不能代替真实 VS Code 宿主测试。本轮宿主启动被本机 VS Code 更新锁阻止，尚未通过。

## 依据

- [Yosys write_json 数据格式](https://yosyshq.readthedocs.io/projects/yosys/en/latest/cmd/write_json.html)
- [Yosys prep 综合入口](https://yosyshq.readthedocs.io/projects/yosys/en/latest/cmd/prep.html)
- [netlistsvg](https://github.com/nturley/netlistsvg)
- [ELK.js](https://github.com/kieler/elkjs)
- [Vivado open_project](https://docs.amd.com/r/2022.1-English/ug835-vivado-tcl-commands/open_project)

实现愿景：保持模型稳定，在不耦合外部工具、布局器与页面的前提下逐步增加局部逻辑浏览；先以真实工具、位级连接和可取消交互验收，再扩大设计规模。
