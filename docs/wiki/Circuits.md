# 电路结构查看器

## 选择入口

- 编辑器右上角 **查看 RTL 电路（Yosys）**：默认离线内置引擎，无需另装 Yosys。
- RTL 右键 **查看当前文件电路（Vivado）**：使用所选 XPR 的 IP/宏/include 上下文，在副本中选择当前文件模块为 Top。
- Vivado 工程面板电路入口：使用原工程综合 Top。
- **打开电路网表（JSON）**：导入 Yosys JSON 或本插件 Vivado 导出 JSON。

RTL 文件含注释头是正常情况，应走“查看 RTL 电路”，不要作为 JSON 导入。导入入口用于实际 JSON 网表。

## Yosys 与依赖

默认 `yosysPath: "bundled"`、`frontend: "auto"` 使用随包 Slang 前端，支持 SystemVerilog 时序声明等语法。当前文档可以用未保存正文生成快照；其他依赖也遵循保存/快照提示。

空 `sources` 自动收集当前工作区被引用的模块、接口和包；不要求模块名与文件名相同。缺少子模块、重复定义、宏生成依赖或复杂包顺序时，显式提供有序文件表：

```json
{
  "svtools.circuit.yosysPath": "bundled",
  "svtools.circuit.frontend": "auto",
  "svtools.circuit.top": "my_top",
  "svtools.circuit.sources": ["rtl/types_pkg.sv", "rtl/child.sv", "rtl/my_top.sv"],
  "svtools.circuit.includeDirs": ["rtl/include"],
  "svtools.circuit.defines": ["SYNTHESIS", "WIDTH=8"],
  "svtools.circuit.generationTimeout": 120
}
```

路径相对当前文件所属工作区根目录；支持绝对路径。非空 `sources` 是有序文件列表，不展开 glob；当前文件若不在列表中会追加。`includeDirs` 只提供头文件搜索目录，不能代替编译源文件。

没有指定 Top 时，从当前文件的模块中选择。外部 Yosys 可填写可执行文件路径；外部 `auto` 使用旧 Verilog 前端，显式 `slang` 要求该工具提供 `read_slang`。不会编译失败后静默换前端重试。

## 看懂图与交互

![4.1 电路模块、属性、追踪入口与小地图](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-workspace-4.1-light.png)

| 图中编号 | 入口与使用方式 |
|---|---|
| 1 · 模块选择 | 切换当前模块；有层级的实例还可双击下钻，使用“返回”回到上层 |
| 2 · 小地图 | 显示或隐藏导航小地图；复杂图中点击小地图定位，再用 F 适配 |
| 3 · 对象属性 | 点击端口、引脚或网络后查看方向、位宽、信号及连接端点；总线使用粗线和位宽标记 |
| 4 · 驱动 / 负载追踪 | 在“追踪位 / 范围”填 `*` 或 `7:4` 等 HDL 下标，再选择追踪方向 |
| 5 · 导出图片 | 选择文档黑白线稿 / 当前主题，以及 SVG / PNG |

图中使用公开 `circuit-demo.sv` 经真实内置 Yosys 生成的网表；数字是指南标注。看不清属性时点击工具栏“属性”展开右侧面板。

| 操作 | 手势/入口 |
|---|---|
| 平移/缩放 | 拖动画布 / 滚轮，以指针为中心缩放 |
| 适配 | 工具栏或 F |
| 查看对象信息 | 点击单元、引脚、连线 |
| 网络高亮 | 点击连线，整条网络的分支和端点一起高亮 |
| 搜索 | 名称、端口或网络，Enter 逐个定位 |
| 层级下钻 | 双击有层级的实例，或“进入模块” |
| 返回上层 | 返回按钮或 Alt+左箭头 |
| 源码定位 | 详情中的已有源位置 |

单比特细线、多比特粗线区分；总线标注位宽，拼接/拆分节点标注主干和分支位范围。寄存器按工具给出的类型与参数表示触发沿及控制极性，未知单元保留未知信息。

Yosys 保留可用模块层级；Vivado 当前提供平坦 RTL 详细化结果，不提供同样的下钻树。

## 从全图进入局部追踪

在全图选中一个端口或网络，点击属性栏 **追踪驱动 ←** / **追踪负载 →**。先核对起点和位范围，局部图会在寄存器、未展开模块或未知语义处停下。需要继续时使用边界按钮；**跨时序展开**代表主动跨过寄存器边界。

![局部驱动追踪、时序边界和历史导航](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-trace-4.1-light.png)

图中 1 为追踪摘要与精度，2 为边界操作，3 为历史导航，4 为小地图。[按编号逐步追踪](https://github.com/JayceVane/SV-Tools/wiki/Signal-Tracing)

## 复杂设计与导出

布局在后台 worker 执行，拖动/滚轮按帧合并，视口外对象按需挂载，缩小时简化文字细节。放大恢复细节，搜索仍可定位屏外对象。超预算时选择更小子模块或调整源文件/Top，不将“没有画出全部”误认为逻辑已不存在。

点击 **导出图片**，选黑白技术文档风或当前主题，再选 SVG/PNG。模块视图导出当前模块完整布局，包含屏幕外节点；局部追踪视图导出当前追踪子图。切到所需模块或追踪范围后再导出，超出 PNG 图幅预算时改用 SVG。需要直接贴到文档时，点“复制到剪贴板”会生成 2× PNG。

## 数据含义与错误日志

这是工具详细化/综合后的连接结果，常量折叠、未使用逻辑移除、参数和 generate 展开均可能发生；不是源码每条语句的逐行示意，也不是布局布线或门级时序分析。仿真专用 class/UVM 行为不能转换为可综合硬件。

日志在 `<工作区>/.svtools/circuit/<任务>/`；错误摘要尽量映射回原文件行列。先看具体缺模块/类型/语法错误，通用的 `Design elaboration failed` 只是总结。必要时提供完整 `01-yosys.log` 或 `01-vivado.log`。

[Top 策略](https://github.com/JayceVane/SV-Tools/wiki/Vivado) · [详细配置与容量边界](https://github.com/JayceVane/SV-Tools/blob/v4.1.0/docs/CIRCUIT.md)
