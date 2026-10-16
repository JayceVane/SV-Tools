# 电路结构查看器（4.0 beta）

当前4.0.0-beta.2要求VS Code 1.106或更新版本；内置固定WASM需要新版V8类型支持。纯Node开发验收基线为22.20.0，CI覆盖22/24。不支持的宿主会提示升级或配置外部Yosys，此前4.0.0-preview.1仍可用于旧版VS Code。

## 目标与数据来源

在编辑器里查看 RTL 生成的电路连接，核对模块、寄存器、MUX、运算和存储器。技术路线为真实 Yosys JSON → netlistsvg 对照 → 独立电路模型 → ELK.js + SVG 交互；Vivado 适配同一模型。netlistsvg 用于开发验收，不参与运行时显示。

电路来自工具的详细化或综合结果，源码索引只负责选择 top。未使用逻辑可能被移除，参数和 generate 会被展开，视图不保证逐语句对应源码。UVM、class、动态数组等仿真行为不能因此变成可综合电路。与 VCD 波形查看器的数据和容量策略相互独立。

## 使用

命令面板搜索“电路”（英文界面搜索 Circuit）：

| 命令 ID | 操作 |
|---|---|
| `svtools.circuit.fromSource` | 当前 `.v` / `.sv` 默认调用内置 Yosys 生成并显示 |
| `svtools.circuit.open` | 导入已有 Yosys JSON 或本插件 Vivado 导出 JSON |
| `svtools.circuit.fromVivado` | 读取当前选中 XPR，执行只读 RTL 详细化并显示 |
| `svtools.circuit.fromVivadoFile` | RTL 右键查看当前文件，在任务副本中使用该文件模块作为 Vivado top |
| `svtools.circuit.stop` | 停止电路生成及顶层扫描 |

编辑器右上角默认调用内置 Yosys；RTL 右键子菜单提供 Yosys 与当前文件 Vivado 入口。Vivado 入口复用现有面板的工程选择与 `svtools.vivado.path`，不修改用户的工程配置。生成物和日志放在工作区 `.svtools/circuit/` 的独立任务目录，工程/补全索引会忽略这些目录。

Yosys 入口对当前未保存正文生成任务快照，不保存、格式化或替换磁盘文件；工具返回的快照位置回映射到原文件。其他源文件从磁盘读取。Vivado 当前文件入口要求先保存，不自动修改编辑器正文。源码定位只接受模型中已有位置，并在宿主核对真实路径范围。JSON 导入只出现在 JSON 编辑器上下文与命令面板；旧绑定传入 RTL URI 时也会转入生成流程。

## 单比特与总线

当前版本以真实位数组区分单比特细线与多比特粗线，选中、悬停和搜索也保持差异。多比特引脚同步加粗，顶层I/O显示实际位数；不根据名称中的方括号猜测总线，也不把位数伪装成未知的声明范围。

总线在有空间的正交长段标注“斜杠 / 位宽数字”，点击数字或斜杠可选择对应网络。标记会避让重合标签，文字使用轻轮廓衬底；短线或拥挤区域仅保留粗线，悬停和详情仍显示位宽。切片/分支可能显示8和24，而端口总宽为32；标记表示该路由的位组，不把整端口宽度强加给切片。

缩小到紧凑视图时隐藏位宽数字，总览隐藏装饰但保留粗细。标记位置与视口索引共用，防止高倍率只剩文字可见时提前裁掉整条线。

## 时序符号

alpha7按明确的Yosys内部字级单元类型和参数绘制寄存器：CLK三角与真实引脚对齐，下降沿时钟及低有效控制带空心气泡，普通端点是直线。DFF与电平敏感LATCH、SR锁存器、隐式全局时钟FF分别标注；未知类型保持REG。缺失或非法极性不猜测，控制/时钟标签附问号，详情显示未知。当前只解释已知Yosys字级单元，不为Vivado或门级未知单元按名字补造极性。

例如`sync_resetn`可能被Slang生成`$aldff`：`D=1`、`AD=0`、`CLK_POLARITY=1`、`ALOAD_POLARITY=0`，其行为是低电平异步清零、释放后下一上升沿输出1。视图保留`ALOAD`/`AD`与原始类型，不把异步装载重命名为复位单元。点击控制引脚可看有效电平和装载数据；点击单元可看原工具参数（最多展示32项，每项值256字符，截断时标明总项数或总字符数，完整值仍在网表）。该RTL只有一级触发器。

语义依据：[Yosys内部寄存器文档](https://yosyshq.readthedocs.io/projects/yosys/en/latest/cell/word_reg.html)。连线仍完全来自网表；本层只决定符号与文字。

## Yosys 配置

VSIX 内置固定 YoWASP/Yosys 0.68.1207 的 WASM 和 share，首次使用也可离线运行，无需 Python、系统 PATH 或额外安装。默认值 `bundled` 使用内置工具；需要本机其它版本时，配置其可执行文件路径即可。内置 builtin/slang 前端均经真实编译验证；外部前端能力由所选工具及其插件决定。

```json
{
  "svtools.circuit.yosysPath": "bundled",
  "svtools.circuit.frontend": "auto",
  "svtools.circuit.top": "my_top",
  "svtools.circuit.sources": ["rtl/package.sv", "rtl/child.sv", "rtl/top.sv"],
  "svtools.circuit.includeDirs": ["rtl/include"],
  "svtools.circuit.defines": ["SYNTHESIS", "WIDTH=8"],
  "svtools.circuit.generationTimeout": 120
}
```

路径相对当前文件所属工作区根目录解析，绝对路径也可用；`sources` 非空时是有序文件列表，当前文件若未包含则追加，不展开 glob、不再自动发现。留空时自动收集当前工作区文件夹内被引用的模块、接口和包文件，依赖先于使用方；不会将整个工作区直接交给综合器。未设置 top 时从当前文件列出模块供选择。生成入口只接受普通 ASCII HDL 模块名；带转义名称的设计可以外部生成 JSON 后导入。

自动源收集在可取消Worker中复用SystemVerilog语义解析，支持参数化、实例数组、generate块和`pkg::name`；不要求文件名与模块名相同。用到的定义若在多个文件中出现，必须用显式sources选定上下文，不能按扫描顺序选择。已选中的未保存依赖也会写入任务快照，回映射原文件，原始磁盘内容保留。含include的未保存依赖要求先保存，避免快照位置改变局部头文件的搜索语义；当前文件的未保存快照保持原策略。字面include已提供的SV文件不会重复单独读入；包含路径仍由实际预处理器解释。

扫描候选仅含`.sv/.v`，排除工具快照/依赖缓存；上限4096文件、单文件2 MiB、总量32 MiB，限于当前文件的工作区根和真实路径。超限、非UTF-8或外部链接明确失败，显式sources可用于大型工程或外部库。自动收集不展开宏、条件编译和generate，不为未限定的类型自动添加import；复杂文件表、宏生成依赖和仅在头文件中的依赖可配置显式sources/includeDirs。Slang负责最终合法性判断。

alpha6错误摘要优先具体源码诊断，即使通用`ERROR: Design elaboration failed`先到达；WASI和任务快照路径会映射回用户原文件与行列。日志写入/启动错误仍优先，完整日志始终保留。缺定义会提示检查依赖与包可见性，不能把`includeDirs`当成已编译的源文件列表。

`auto`为默认：内置Yosys固定提供Slang，自动使用`read_slang`；外部Yosys沿用`read_verilog -sv`以兼容未安装Slang的工具。可显式选择`slang`或`verilog`，不会在编译失败后静默重试其它前端。`slang`支持编译单元及模块内的`timeunit`/`timeprecision`；显式选择`verilog`时仍受旧前端语法范围限制，报错会提示更换前端。外部`slang`要求工具提供`read_slang`。生成采用 `prep`，保留层级和已收集存储器；导入含未降低 process/memory 的原始中间 JSON 会明确提示先运行 `proc` / `memory_collect` 或 `prep`。

宏以 `NAME` 或 `NAME=正文` 形式配置，保留正文中的空格及引号，不支持换行宏。生成器用独立 HDL 包装文件传递宏和有序 include，避免不同前端的命令行引号差异。内置引擎直接映射明确配置的源目录/include 与任务目录，支持空格、中文路径及工作区相对 readmem 文件。外部原生 Yosys 的空格 include 使用目录链接，识别出的 `yowasp-yosys` exe/cmd/bat 则使用有预算的目录快照；外部 YoWASP 快照遇到符号链接或超预算会报错。

## Vivado 数据

本版调用 `open_project -read_only` 与 `synth_design -rtl`，输出标明 `vivado / elaborated-rtl / flat`。单元使用完整实例路径，但不提供可下钻的 Vivado 模块树。跨层级网络使用真实 segments 与 canonical net 归一，避免同名局部网络误连。

RTL 右键“查看当前文件电路（Vivado）”优先选择与文件名相同的模块，或文件内唯一模块；有多个候选时供用户选择。原工程只读打开，在独立任务目录保存排除run结果的工程副本，再设置副本top并更新编译顺序，最后执行`-rtl`详细化。这样旧top未引用、被AutoDisabled的源文件也可查看；宏、include、文件类型和IP上下文沿用工程。工程管理面板标题和top节点入口均使用原工程top。右上角按钮始终调用Yosys，遵守`svtools.circuit.*`设置。

当前文件必须是所选工程的已保存综合源。工程外/未保存文件会明确提示先加入并保存，或改用内置 Yosys。当前文件的top和编译顺序只写入任务副本；原工程、源文件和编辑器正文保持原样。Vivado错误提示优先显示具体的模块、语法或端口错误，同时提供完整日志。

升序、降序、非零/负起点总线按真实 BUS 元数据还原。黑盒保留为未知实例；稀疏内部总线不补造缺失位。可显示寄存器、算术、逻辑、常量和存储器类单元，但不是门级时序、布局布线或时序报告视图。真实验收使用 Vivado 2022.1.2；其他版本需复验 Tcl 对象属性与导出格式。

## 交互

拖动画布平移，滚轮以指针为中心缩放；工具栏可放大、缩小和适配。点击单元、引脚或网络查看位宽、方向、参数、别名、源位置与端点；同一网络的分支和端点一起高亮。工具生成的长单元名显示短标签，完整名保留在提示、搜索与详情里。

双击有层级的实例或点击“进入模块”下钻，返回/顶层与模块选择器切换视图。搜索单元、端口或网络，Enter 依次定位匹配。焦点在画布时，方向键平移，`F` 适配，`+` / `-` 缩放，Enter 进入实例，`Alt+←` 返回，Escape 取消拖动或选择。输入框内的编辑键不被画布截获。

alpha5起，拖拽和滚轮按动画帧合并刷新；屏外图元按视口挂载，完整模型、搜索与网络高亮仍然保留。小于65%时隐藏引脚名，小于35%时隐藏文字、时钟符号与引脚，总览保留单元外形和连线，放大恢复细节。搜索屏外对象会居中显示。Tab只经过当前已挂载的单元，可用搜索或平移访问屏外对象。

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

固定开发依赖 `elkjs@0.12.0`、`netlistsvg@1.0.2`、`@yowasp/yosys@0.68.1207`。ELK bundle/许可，以及原始 Yosys core WASM、share、校验清单与第三方许可进入 VSIX；不包含 Python、netlistsvg、开发 node_modules、验证工程、用户生成物或测试夹具。原始资源文件内的版权声明保留，完整声明见 `bin/vendor/yosys/THIRD-PARTY-NOTICES.txt`。

```powershell
npm.cmd ci
npm.cmd run test:circuit
node scripts/verify-circuit.js
node scripts/verify-circuit-enum.js
node scripts/benchmark-circuit-interaction.js --browser <Chromium浏览器exe> --nodes 2000 --acceptance
node scripts/verify-circuit.js --yosys bundled --frontend slang
node scripts/verify-circuit.js --yosys <外部yosys可执行文件>
node scripts/verify-circuit.js --yosys <带slang的yosys> --frontend slang
node scripts/verify-circuit-vivado.js --vivado <Vivado安装目录>
./scripts/verify-circuit-host.ps1 -CodePath <Code.exe>
```

Yosys 验证从公开 RTL 创建独立夹具，检查宏、空格 include 路径、参数化层级、寄存器、MUX、加法器、存储器和升序/非零起点位映射，然后执行真正的 netlistsvg 与 ELK。Vivado 验证新建独立工程，核对跨层连接和 I/O buffer，并逐文件比较工程树 SHA256，验证只读流程未改变工程文件内容。

宿主验收使用独立用户目录、扩展目录和公开夹具；`-ExtensionPath` 可指定解包后的 VSIX，核对命令注册、真实 Webview ready 消息、Worker 布局及未保存快照。浏览器预览脚本仅替代宿主消息桥，用于图形交互与主题验收；不能代替真实 VS Code 宿主测试。本轮宿主启动被本机 VS Code 更新锁阻止，尚未通过。

交互基准在独立隐藏浏览器中加载正式页面，使用生成的已布局图和替代消息桥；报告包含输入处理耗时、rAF帧间隔、活动DOM数量和明暗主题截图。它不包含Yosys/ELK耗时，也不代表真实IDE宿主或所有设计都达到同一帧率。可用`--extension-root`对照旧VSIX解包目录，详细数据见[V4_1_ALPHA5.md](V4_1_ALPHA5.md)。

## 依据

- [Yosys write_json 数据格式](https://yosyshq.readthedocs.io/projects/yosys/en/latest/cmd/write_json.html)
- [Yosys prep 综合入口](https://yosyshq.readthedocs.io/projects/yosys/en/latest/cmd/prep.html)
- [netlistsvg](https://github.com/nturley/netlistsvg)
- [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
- [SVG绘制模型](https://www.w3.org/TR/SVG/render.html)
- [ELK.js](https://github.com/kieler/elkjs)
- [Vivado open_project](https://docs.amd.com/r/2022.1-English/ug835-vivado-tcl-commands/open_project)

实现愿景：保持模型稳定，在不耦合外部工具、布局器与页面的前提下逐步增加局部逻辑浏览；先以真实工具、位级连接和可取消交互验收，再扩大设计规模。
