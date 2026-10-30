# 界面图解与操作入口

前五张图来自 **4.1.0 的真实 Webview**，使用公开 RTL / VCD 夹具，覆盖工程管理、波形、电路、信号追踪和图片导出。圆圈数字是指南标注，对照图下操作表使用；它们不是插件控件。

截图只包含扩展内容区域，IDE 外壳、字体和配色可能随宿主设置变化。工程图使用界面快照夹具，未执行 Vivado 任务；波形经过真实 VCD Worker，电路来自公开 RTL 经真实 Yosys 生成的网表。未使用私有工程或生成图片模拟界面。点击图片可查看原始分辨率；来源、版本与 SHA256 见[截图清单](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/manifest.json)。

## 1. 单侧边栏管理工程

**入口**：活动栏打开 **SV Tools 工程**，在顶部切换器选择工程。Vivado 和 SV Tools 自管理工程使用同一个侧边栏。

<a href="https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/project-workspace-4.1-light.png"><img src="https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/project-workspace-4.1-light.png" alt="4.1 工程侧边栏操作图解" width="410"></a>

| 编号 | 点击哪里 | 接下来观察什么 |
|---|---|---|
| 1 | 顶部工程切换器 | 当前工程名称和 Vivado / SV Tools 类型标签 |
| 2 | 文件 / 实例层级 | 文件归属，或同一模块在不同实例中的位置 |
| 3 | 追踪条中的“固定” | 固定当前信号；取消固定后继续跟随编辑器所选信号 |
| 4 | 文件右侧角色标记 | `●` 内部声明、`→` 输出、`←` 输入；标记不会重复列出信号名 |
| 5 | 树下方 Vivado 流程 | 综合、布局布线、Bitstream 和报告；再点“查看报告”可收起菜单 |

**下一步**：在编辑器选中一个信号，先核对追踪根，再按文件或实例观察走向。[工程信号追踪](https://github.com/JayceVane/SV-Tools/wiki/Signal-Tracing) · [Vivado 操作](https://github.com/JayceVane/SV-Tools/wiki/Vivado)

## 2. 在波形中找到需要的时间和信号

**入口**：点击 `.vcd`，或在仿真成功后打开自动生成的波形标签页。

[![4.1 波形工作区图解](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-workspace-4.1-light.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-workspace-4.1-light.png)

| 编号 | 点击哪里 | 接下来观察什么 |
|---|---|---|
| 1 | 搜索框与层级筛选 | 点击匹配的信号添加至波形；可保留完整层级以区分同名信号 |
| 2 | A/B 读值条 | 点击放置 A，Shift + 点击放置 B；此处显示时间和 Δt |
| 3 | 名称 / 读值栏边界 | 拖动调宽；名称旁三角展开总线，子位按声明下标显示 |
| 4 | 底部时间导航条 | 滑块表示当前视窗；拖动、点击轨道或点击两侧箭头平移 |
| 5 | 导出图片 | 按 A/B 区间或当前视口整理一张技术文档波形图 |

示例全程 **0–70 ns**，当前只显示 **0–55 ns**，所以滑块没有占满轨道；A 为 0 ns、B 为 40 ns。蓝色背景用于区分关注信号，X/Z 仍保留诊断颜色。

**下一步**：Ctrl/Shift 多选后右键设置背景色或分组；选择某个 bit，再用左右边沿导航核对跳变。[完整波形操作](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

## 3. 在电路全图核对端口和总线

**入口**：RTL 编辑器右上角 **查看 RTL 电路（Yosys）**。默认使用内置工具；有 Vivado 工程上下文时也可走 RTL 右键的 Vivado 入口。

[![4.1 电路工作区图解](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-workspace-4.1-light.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-workspace-4.1-light.png)

| 编号 | 点击哪里 | 接下来观察什么 |
|---|---|---|
| 1 | 模块选择 | 切换模块或双击实例下钻，核对当前层级 |
| 2 | 小地图 | 打开导航缩略图，点击定位；F 适配全图 |
| 3 | 对象属性 | 选中端口、引脚或网络后查看方向、位宽及连接关系 |
| 4 | 驱动 / 负载追踪 | 指定 `*` 或 `7:4` 等位范围，再选择追踪方向 |
| 5 | 导出图片 | 文档黑白线稿 / 当前主题，SVG / PNG |

粗线表示总线，细线表示单比特；位宽和拼接/拆分范围用于核对真实连接。示例选中的是 **q，8 bit**。

**下一步**：在属性栏将位范围设为 `*`，点击“追踪驱动 ←”，进入下图。[电路入口与数据含义](https://github.com/JayceVane/SV-Tools/wiki/Circuits)

## 4. 按边界逐步追踪，不丢失上下文

[![4.1 q 总线的局部驱动追踪](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-trace-4.1-light.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-trace-4.1-light.png)

| 编号 | 看哪里 | 如何判断和继续 |
|---|---|---|
| 1 | 追踪摘要与精度 | 核对 `q · 8/8 bit`、驱动方向及 `circuit_demo` 上下文 |
| 2 | 时序边界按钮 | 当前停在触发器输出；点击“跨时序展开”才继续查看前面的组合逻辑 |
| 3 | 返回 / 前进 | 在已访问结果间恢复展开状态和视口 |
| 4 | 小地图 | 确认当前局部图范围，点击移动视窗 |

图中的 DFF → q 是一次有明确边界的结果，不能据此认为寄存器输入侧没有逻辑。层级、黑盒和未知语义边界也会有相应提示。

**下一步**：展开一个边界后再返回；需要结合仿真时，按实际 DUT 根实例关联 VCD，观察 A/B 精确值。[信号追踪与波形联动](https://github.com/JayceVane/SV-Tools/wiki/Signal-Tracing)

## 5. 将 A/B 区间整理为文档插图

**入口**：先设置 A/B，再点击波形工具栏 **导出图片**。

[![4.1 波形图片导出图解](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-export-4.1-light.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-export-4.1-light.png)

| 编号 / 区域 | 选择什么 |
|---|---|
| 1 · 图形风格 | 文档黑白线稿适合报告；当前界面主题保留配色 |
| 2 · 文件格式 | SVG 可缩放编辑，PNG 便于直接插入文档 |
| 时间区间 | “A/B 游标之间”按真实事件重读该区间并自动调整画幅；也可选择当前视口 |
| 导出信号 | 全部已添加信号，或当前选中的信号；保留展开/折叠状态 |
| 3 · 导出图片 | 选择保存位置；旁边“复制到剪贴板”直接生成 2× PNG |

电路使用同一风格 / 格式选择方式：模块全图导出完整布局，局部追踪导出当前子图。[波形导出说明](https://github.com/JayceVane/SV-Tools/wiki/Waveforms) · [电路导出说明](https://github.com/JayceVane/SV-Tools/wiki/Circuits)

## 更多功能示例：浮点、mem 和暗色主题

以下三张为保留的 **4.0 功能截图**，用于说明浮点、存储器和暗色显示；4.1 导航和工具栏入口以前面的新版图解为准。

### 浮点与 Analog

右键“显示格式”选择 FP64、FP32、TF32、BF16、FP16 或 FP8 E3M4。Analog 行可拖动下边界调整高度；X/Z、NaN 和无穷值按各自语义显示。[格式与限制](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

[![4.0 浮点和模拟量功能示例](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-floats-dark.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-floats-dark.png)

### 二维 mem

点击“存储器”选择实际 dump 的 mem，选择读值格式。矩阵保留行列索引，并显示 A/B 值及 Δ 变化；没有 dump 的元素不会被补成零。[存储器操作](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

[![4.0 二维 mem 功能示例](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/memory-matrix-light.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/memory-matrix-light.png)

### 电路暗色主题

电路跟随 IDE 的明暗主题；网络高亮与单比特/总线差异保留。[电路交互](https://github.com/JayceVane/SV-Tools/wiki/Circuits)

[![4.0 电路暗色功能示例](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-overview-dark.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-overview-dark.png)
