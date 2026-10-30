# SV Tools 4.1 使用指南

SV Tools 为 Verilog/SystemVerilog 开发提供格式化、代码生成、语义补全、Icarus/Vivado 工具链，以及内嵌波形和电路查看。本指南对应 **4.1.0**，以 Windows x64 发布包为安装基线。

[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=JayceVane.svtools) · [Open VSX](https://open-vsx.org/extension/JayceVane/svtools) · [GitHub Releases](https://github.com/JayceVane/SV-Tools/releases/tag/v4.1.0) · [带编号的界面图解](https://github.com/JayceVane/SV-Tools/wiki/Screenshots)

## 从这里开始

1. [安装与第一次运行](https://github.com/JayceVane/SV-Tools/wiki/Getting-Started)：选择安装渠道，完成一次格式化与仿真。
2. [从 3.x / preview / beta 升级](https://github.com/JayceVane/SV-Tools/wiki/Upgrade-Guide)：了解设置继承和版本兼容。
3. 按任务选择下表中的操作页；命令面板可搜索中文名称或英文名称。

| 我要做什么 | 操作指南 |
|---|---|
| 对齐端口、例化、task 参数和默认值 | [格式化](https://github.com/JayceVane/SV-Tools/wiki/Formatting) |
| 生成例化、测试台或文件头 | [代码生成与文件头](https://github.com/JayceVane/SV-Tools/wiki/Code-Generation) |
| 使用 SystemVerilog / UVM 补全 | [代码补全](https://github.com/JayceVane/SV-Tools/wiki/Completion) |
| 语法检查并运行仿真 | [Icarus 与仿真](https://github.com/JayceVane/SV-Tools/wiki/Simulation) |
| 管理 XPR、切换 Top、运行综合与实现 | [Vivado 工程管理](https://github.com/JayceVane/SV-Tools/wiki/Vivado) |
| 调试大 VCD、展开总线、查看 mem | [波形与存储器](https://github.com/JayceVane/SV-Tools/wiki/Waveforms) |
| 从 RTL 生成电路、检查连线并导出图片 | [电路查看器](https://github.com/JayceVane/SV-Tools/wiki/Circuits) |
| 追踪信号、查看工程走向与A/B值 | [信号追踪与波形联动](https://github.com/JayceVane/SV-Tools/wiki/Signal-Tracing) |
| 查设置名、默认值与命令 ID | [配置参考](https://github.com/JayceVane/SV-Tools/wiki/Configuration)、[命令参考](https://github.com/JayceVane/SV-Tools/wiki/Command-Reference) |
| 处理启动、依赖、编译或显示错误 | [故障排查](https://github.com/JayceVane/SV-Tools/wiki/Troubleshooting) |

## 界面预览

[界面图解](https://github.com/JayceVane/SV-Tools/wiki/Screenshots)按“在哪里点击 → 画面如何变化 → 下一步做什么”组织。新版图中的数字是文档标注，对应图下的操作表，不是插件按钮。

[![4.1 波形工作区：A/B、总线展开与时间导航](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-workspace-4.1-light.png)](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

从左侧添加信号，在波形放置 A/B，展开总线观察控制位，再拖动底部时间导航条查看局部时序。[跟图操作](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

[![4.1 电路工作区：网络属性、追踪和小地图](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-workspace-4.1-light.png)](https://github.com/JayceVane/SV-Tools/wiki/Circuits)

从模块全图选中端口或网络，在属性栏指定位范围并追踪驱动/负载；局部图在时序边界停止，由你决定是否继续展开。[跟图追踪](https://github.com/JayceVane/SV-Tools/wiki/Signal-Tracing)

## 获取软件

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=JayceVane.svtools)：在 VS Code 中搜索 SystemVerilog Tools，确认发布者 JayceVane。
- [Open VSX](https://open-vsx.org/extension/JayceVane/svtools)：供使用 Open VSX 的兼容 IDE 安装。
- [GitHub Releases](https://github.com/JayceVane/SV-Tools/releases)：VSIX、独立 CLI、原生模块和 SHA256 清单。
- [4.1.0 发布说明](https://github.com/JayceVane/SV-Tools/releases/tag/v4.1.0)。市场版本以各页面为准，扩展 ID 均为 `JayceVane.svtools`。
- [问题反馈](https://github.com/JayceVane/SV-Tools/issues)：附最小复现、插件版本、IDE 版本和完整日志路径。

安装 VSIX 自带格式化原生模块与离线 Yosys，无需另装 Rust、Python 或 Yosys。Icarus 和 Vivado 按需安装；Vivado 仍需自己的器件支持与许可。

## 使用范围

当前只正式维护 **Windows x64**，VS Code / 兼容宿主需满足 **1.106.0+**。安装包标记为 `win32-x64`；旧版 `universal` 标签不能作为其他系统已通过验证的依据。

内置波形查看支持 VCD，FSDB 查看未提供。二维 mem 依赖 VCD 中实际 dump 的元素与索引。电路来自工具的详细化/综合结果，参数与 generate 会展开；补全索引和电路都不能替代仿真、综合或完整的标准语义检查。

指南源文件保存在[源码仓库 docs/wiki](https://github.com/JayceVane/SV-Tools/tree/master/docs/wiki)，按文档变更审查；Wiki 提供操作入口，源码中的格式化规范和专题文档提供更细的行为边界。
