# Vivado 工程管理

## 配置并选择工程

```json
{
  "svtools.vivado.path": "C:/AMD/Vivado/2022.1",
  "svtools.vivado.part": ""
}
```

使用本机实际 Vivado 路径。4.0 已用 Vivado 2022.1.2 验收，其他版本的 Tcl 属性与导出行为需在本机核对。器件支持和许可来自 Vivado 安装。

打开工程所在文件夹，在统一的 **SV Tools 工程** 侧边栏顶部选择 Vivado 工程，或刷新工程列表。多 XPR 工作区明确选择当前工程。没有 XPR 时可用 **Vivado: 创建工程** 向导，选择源文件分类、器件和 Top；也可先建立 SV Tools 自管理工程。

<a href="https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/project-workspace-4.1-light.png"><img src="https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/project-workspace-4.1-light.png" alt="统一工程面板和树下方的 Vivado 流程" width="410"></a>

图中 **1** 切换工程，**2** 切换文件 / 实例层级，**3** 固定信号追踪，**4** 显示所选信号的文件角色，**5** 是文件树下方的 Vivado 流程与报告入口。使用同一侧边栏即可在两种工程类型间切换；自管理工程不会显示 Vivado 流程。

图示为公开界面夹具，未执行综合或布局布线。查看报告或“…”菜单展开后，再点同一按钮即可收起；点击外部区域或 Esc 也可关闭。

## 文件、Top 与运行

| 操作 | 入口与结果 |
|---|---|
| 添加文件 | 面板/文件右键添加至指定文件集 |
| 从工程移除 | 移除工程引用，磁盘文件保留 |
| 切换设计/仿真文件集 | 文件右键移到 sources_1 / sim_1 |
| 设置 Top | 分别设置综合 Top、仿真 Top |
| 编译与仿真 | 仿真 Top 详细化、xsim 仿真 |
| FPGA 流程 | 综合、布局布线、资源/时序报告、生成 Bitstream |
| 任务控制 | 刷新、全部展开、停止面板任务 |

文件集移动先添加并验证目标，再移除源引用；后续失败尝试恢复引用和常用属性。具体失败以输出和完整 Tcl 日志为准。

面板中的设置 Top 会修改所选工程上下文；查看电路的当前文件入口使用任务副本，二者用途不同。

## 三种电路入口的 Top 策略

| 从哪里进入 | 使用什么 Top |
|---|---|
| RTL 编辑器右上角 | 内置 Yosys，遵循 `svtools.circuit.*` 配置与当前文件模块选择 |
| RTL 右键“查看当前文件电路（Vivado）” | 从当前文件选模块，在任务工程副本中设置 Top |
| 工程面板/工程 Top 的电路入口 | 所选 XPR 原工程的综合 Top |

当前文件 Vivado 电路入口要求文件已保存且属于所选工程综合源；优先文件同名模块或唯一模块，多模块时供选择。只读打开原工程，在任务副本中重设 Top 和编译顺序，原 XPR 与源码保持原样。IP、宏和 include 上下文来自工程。

## Tcl、运行时间与日志

命令面板可执行 **运行 TCL 脚本**、**运行当前 TCL 脚本**、**在常驻会话中运行 TCL**、**停止**。前两个默认走批处理：每次新进程、状态隔离，适合工程脚本；**在常驻会话中运行 TCL** 复用已打开的 Vivado 会话，适合连续调试，但脚本会改变该会话的当前工程与目录，状态不再隔离。`svtools.vivado.timeoutMs` 为 batch 超时，默认 `0` 不限时；仿真运行长度使用 `svtools.vivado.simRuntime` 按本机仿真任务配置。

综合、布局布线、Bitstream 在批处理运行期间，Tcl 每 2 秒轮询 run 的 `STATUS/PROGRESS` 并打印 `SVTOOLS_RUN_PROGRESS`。状态栏显示 `<run> <百分比>`，悬停可看当前 step；工程概览在运行期间仍显示忙，结束后自动刷新最终状态。

Vivado 日志中的 `ERROR` 即使进程退出码为 0，也判定任务失败。先定位具体设计单元、端口、语法、器件或许可错误，再查看完整阶段日志。

IP 管理与 Block Design 的读写默认复用一个常驻 Tcl 会话：启动一次并打开工程，后续操作只发送脚本，不再每次点击都重新启动 Vivado 并重新打开工程。`svtools.vivado.session` 关闭后回退为每次批处理，`svtools.vivado.sessionIdleMinutes` 控制空闲关闭时间（默认 10 分钟）。会话遇到异常、工程或设计文件被外部修改、或需要执行批处理任务时会自动释放并在下次操作时重建。

## IP 管理（4.3）

在 Vivado 工程侧栏顶部点击「IP 管理」，也可从已有 IP 的右键菜单直接打开该项。左栏按名称和文件集筛选工程 IP。右栏按接口、时钟、数据等类别显示 Vivado 返回的参数，提供搜索、枚举选项和当前值。切换 IP 可保留各自的待应用修改。点击「应用参数」时，Vivado 校验并写入该 IP，页面随后显示写入后的值。

「Vivado 流程」和「IP 管理」都可以打开独立的 IP Catalog 页面，按名称、VLNV、厂商或分类查找并创建 IP。匹配当前工程和 Vivado 安装的目录缓存可先用于浏览，首次打开或缓存过期时在后台读取，亦可手动刷新。已有 IP 可先预览 `.xci` 的保存值，Vivado 核对后可编辑。参数表优先使用 IP 包里的名称、分组、说明和值域；分组内的静态说明（例如取值区间）来自 IP 自带的 XGUI。配置由 Vivado 校验并保存。已有 `.xci` 或 `.xcix` 可引用原文件或复制进工程，自定义仓库可添加、移出和刷新。IP 管理还可生成综合、仿真和例化模板，查看状态报告，并在 Vivado 报告可用升级时单独升级。启用综合检查点的 IP 可运行 OOC 综合。模板支持 Verilog、SystemVerilog 和 VHDL，可插入最近编辑的匹配语言文件。[AMD Vivado IP 指南](https://docs.amd.com/r/2022.1-English/ug896-vivado-ip)

## Block Design（4.3）

在「Vivado 流程 → Block Design」新建、引用已有 `.bd` 或选择工程成员。支持的 `.bd` 可以先从文件渲染保存的结构，Vivado 核对后补齐引脚和地址映射并开放操作。原理图按层级布置模块、左右引脚和外部端口，接口、总线与普通信号使用不同线型。接口的成员默认收起，独立连线仍显示。点击「接口信号」可以展开成员。点击模块、端口或线网会高亮对应连接。用工具栏或 Ctrl／Command 加滚轮缩放，拖动空白处平移，双击层级块可进入内部。

已读取的结构和画出的布局会缓存到当前 VS Code 工作区。工程、设计文件和相关源文件未变化时，重开可直接显示缓存中的图。使用「刷新」可要求 Vivado 重新读取当前设计。

点击「连线」后依次选择两个同层级的同类端点。检查器可搜索模块、端口和线网，也提供断开、参数配置、引出端口与地址映射。可以添加目录 IP、工程 RTL 模块引用和层级块，并新增普通信号端口或协议接口。「添加模块 → 从 Catalog 添加 IP」会打开 Block Design 专用 IP Catalog；选定 IP 并命名后创建实例，随后自动打开定制对话框。

IP 实例的「配置参数」会打开与 Vivado「Re-customize IP」同构的配置对话框：左侧按 IP 自带 XGUI 的页面与分组导航，右侧按参数类型显示复选框、下拉框、十六进制或文本输入，并显示 Vivado 的提示文字与静态说明。修改先以草稿保留，「应用」时一次提交，由 Vivado 校验并回读；依赖不满足的参数会置灰并标注来源。打开或操作工程前会核对 `.xpr` 头部记录的 Vivado 版本与 `svtools.vivado.path` 指向的 `vivado -version`；两者不一致或未找到 Vivado 时会在顶部弹出输入框，直接填写匹配版本的安装目录（也接受 bin 目录或 vivado.bat 全路径），校验通过后写入 `svtools.vivado.path` 并继续本次操作；用户取消则中止操作，避免 Vivado 自动升级或改写工程。

复杂 IP（FIFO Generator、AXI Interconnect、AXI BRAM Controller 等）的界面由 helper proc、循环和字符串生成，静态读取只能拿到部分参数。这类 IP 会请 Vivado 在独立子解释器中执行 IP 自带的 XGUI Tcl，用桩函数回收 ipgui::add_* 调用后还原页面、分组、控件与提示；子解释器在结束后销毁，不会影响工程会话。首次读取某 IP 时多花约百毫秒，结构结果按 XGUI 文件时间戳缓存。

配置对话框里，参数枚举在 Vivado `list_property_value` 为空时改用 IP 包 `component.xml` 的枚举值，因此下拉框仍可正常使用；带 `minimum`/`maximum` 的整数参数显示为数字输入。可用/禁用状态由当前参数值执行 `update_PARAM_VALUE.*` 与 `update_gui_for_PARAM_VALUE.*` 得到：打开对话框、修改参数（防抖后按草稿值回问）和每次应用后都会刷新；被禁用的项会标注“Vivado 按当前参数值禁用，应用后刷新”。XGUI 用 `set_property visible false` 隐藏的页面、分组和参数也会同步隐藏，页面/分组只在其中已无可用参数时才隐藏，避免依赖过程执行顺序造成误隐藏。静态说明会与运行时结果合并，避免 Tcl 命令替换把 `[0x0,0xFFFF]` 这类文本吞掉。对话框标题显示当前 IP 实例名，应用提示也会带上该名称；添加或创建 IP 时会先询问实例名（默认 `<IP名>_0`）。禁用与隐藏状态只就地更新已有控件，不重绘表单，输入焦点不会丢失。IP 管理面板的「配置…」或在列表里双击 IP，会打开同一套分组配置界面；应用后管理面板自动按 XCI 当前值刷新。

编辑操作由 Vivado 写入 `.bd`。工具栏提供地址自动分配、校验并保存传播后的参数、产物生成、将 HDL wrapper 加入工程及导出可重建的 Tcl。板卡预设、专用 IP 配置向导和自动化布线仍可直接在 Vivado IP Integrator 中执行。[AMD IP Integrator 指南](https://docs.amd.com/r/2022.1-English/ug994-vivado-ip-subsystems)

## 地址编辑器（4.3）

Block Design 页面顶部有 **Diagram** 和 **Address Editor** 两个标签。地址编辑器按主地址空间分组列出已映射的从设备段，显示从设备接口、基地址名称、偏移地址、范围与最高地址；外部主设备与内部主设备分开显示。未映射的从设备段单独列出。

偏移地址和范围可以在表格中直接修改，由 Vivado 按主设备 aperture 校验；越界或格式错误会保留原值并显示具体原因。**自动分配地址** 对未映射段执行 `assign_bd_address`；未映射列表中的 **映射…** 可指定目标主地址空间、偏移和范围后建立映射。地址由 Vivado 读取和写入，页面只接收结构化结果，写入后重新读取设计。

## 工程概览（4.3）

命令面板执行 **Vivado：工程概览（运行状态）** 打开面板。面板显示工程名、器件、顶层与工程目录，综合和实现的当前状态、进度、当前步骤与耗时，全部 run 的策略和刷新标记，最近一次实现的 WNS/TNS/WHS/THS 与功耗，以及工程当前的 Error/Warning 数量。每个 run 可以直接打开 `runme.log`。

面板每 5 秒读取一次状态，可关闭自动刷新。读取复用常驻会话，不启动新的构建流程；本扩展正在执行批处理任务时暂停刷新，任务结束后继续。运行由 Vivado GUI、Agent CLI 或工程面板发起时，概览按 Vivado 报告的 run 状态显示。

## 从 Agent CLI 运行 Vivado（4.2）

`project create/add/set-top` 可创建工程、加入 RTL/XDC 并设置综合和仿真顶层。`vivado run --run synth_1` 启动后台任务，用 `task status <任务 ID>` 查终态，再用 `vivado report utilization --run synth_1` 查看结构化资源报告。运行在隔离构建目录保留输入与产物身份，源码变化会使原报告显示 `stale=true`。涉及外部 Tcl 或无法捕获的工程依赖时，CLI 会提示具体原因。见 [Agent CLI 与 Skills](https://github.com/JayceVane/SV-Tools/wiki/Agent-CLI)。
