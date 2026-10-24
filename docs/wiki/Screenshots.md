# 界面导览

以下为4.0当前源码的真实Webview内容截图，使用仓库公开VCD验收数据，以及公开RTL经真实Yosys生成的电路数据。截图只包含扩展内容区域；IDE外壳、字体和配色可能随宿主设置变化。未使用私有工程，未用生成图片模拟界面。

点击图片可查看原始分辨率。每张图片的来源与SHA256保存在[截图清单](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/manifest.json)。

## 总线与信号调试

在左侧目录添加信号；名称旁的三角展开总线位。Ctrl/Shift多选后右键，选择背景高亮或分组。顶部可调整A/B、时间范围、边沿导航和导出。

[![总线与信号调试](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-bits-light.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-bits-light.png)

[操作步骤](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

## 浮点和模拟量

显示格式支持FP64、FP32、TF32、BF16、FP16和FP8 E3M4；Analog行可拖动下边界改变高度。图中X/Z与NaN分别显示，A/B精确值位于名称右侧。

[![浮点和模拟量](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-floats-dark.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-floats-dark.png)

[操作步骤](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

## 二维mem

点击“存储器”，选择mem并设置FP32等格式。示例A为0ns、B为300ns，矩阵保留行列索引，每个单元显示两个时刻的值与Δ变化。

[![二维mem](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/memory-matrix-light.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/memory-matrix-light.png)

[操作步骤](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

## 导出技术文档图片

点击“导出图片”，选择文档黑白线稿/当前主题、SVG/PNG、A/B区间/当前视口及全部/所选信号。示例区间来自A/B游标，不需要先手工截图裁剪。

[![导出技术文档图片](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-export-dialog.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-export-dialog.png)

[操作步骤](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

## 电路连线与详情

示例由公开circuit_demo经真实Yosys生成。粗线表示总线；点击a[7:0]网络后相关分支和端点高亮，右侧列出位宽、位ID、关联信号和端点。

[![电路连线与详情](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-inspector-light.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-inspector-light.png)

[操作步骤](https://github.com/JayceVane/SV-Tools/wiki/Circuits)

## 电路暗色主题

电路沿用IDE主题。模块选择、适配、搜索和导出位于工具栏；双击有层级的模块可下钻。

[![电路暗色主题](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-overview-dark.png)](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-overview-dark.png)

[操作步骤](https://github.com/JayceVane/SV-Tools/wiki/Circuits)
