# SV Tools 4.1 使用指南

SV Tools 为 Verilog/SystemVerilog 开发提供格式化、代码生成、语义补全、Icarus/Vivado 工具链，以及内嵌波形和电路查看。本指南对应 **4.1.0**，以 Windows x64 发布包为安装基线。

## 从这里开始

1. [安装与第一次运行](https://github.com/JayceVane/SV-Tools/wiki/Getting-Started)：安装 VSIX，完成一次格式化与仿真。
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

[完整界面导览](https://github.com/JayceVane/SV-Tools/wiki/Screenshots)包含波形总线/高亮、浮点、二维mem、导出选项以及电路明暗主题的6张实际内容截图。

[![波形逐位与背景高亮](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-bits-light.png)](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

[![电路总线与网络高亮](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-inspector-light.png)](https://github.com/JayceVane/SV-Tools/wiki/Circuits)

## 获取软件

- [GitHub Releases](https://github.com/JayceVane/SV-Tools/releases)：VSIX、独立 CLI、原生模块和 SHA256 清单。
- [4.1.0 发布说明](https://github.com/JayceVane/SV-Tools/releases/tag/v4.1.0)。下载渠道以实际 Release 附件为准。
- [问题反馈](https://github.com/JayceVane/SV-Tools/issues)：附最小复现、插件版本、IDE 版本和完整日志路径。

安装 VSIX 自带格式化原生模块与离线 Yosys，无需另装 Rust、Python 或 Yosys。Icarus 和 Vivado 按需安装；Vivado 仍需自己的器件支持与许可。

## 使用范围

内置波形查看支持 VCD，FSDB 查看未提供。二维 mem 依赖 VCD 中实际 dump 的元素与索引。电路来自工具的详细化/综合结果，参数与 generate 会展开；补全索引和电路都不能替代仿真、综合或完整的标准语义检查。

指南源文件保存在[源码仓库 docs/wiki](https://github.com/JayceVane/SV-Tools/tree/v4.1.0/docs/wiki)，随版本审查；Wiki 提供操作入口，源码中的格式化规范和专题文档提供更细的行为边界。
