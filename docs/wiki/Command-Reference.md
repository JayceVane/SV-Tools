# 命令与快捷键参考

在命令面板搜索下表中文名称。英文界面显示相应英文名称；命令ID用于快捷键配置和定位入口。

`Shift+Alt+F`是VS Code的格式化文档快捷键。下列代码生成快捷键在Verilog/SystemVerilog编辑器内生效；macOS用Cmd替代Ctrl。

| 命令 | 快捷键 | 命令ID |
|---|---|---|
| 格式化文档 | — | `svtools.formatDocument` |
| 生成模块实例化 | ctrl+shift+c | `svtools.moduleInstantiation` |
| 生成测试台 | ctrl+shift+t | `svtools.generateTestbench` |
| 按数字重复代码 | ctrl+f12 | `svtools.repeatCode` |
| 对齐所选代码 | ctrl+shift+x | `svtools.alignCode` |
| 插入文件头 | ctrl+shift+insert | `svtools.insertHeader` |
| Icarus Verilog: 语法检查当前文件 | — | `svtools.iverilog.lint` |
| Lint：选择引擎（iverilog / xvlog） | — | `svtools.lint.selectEngine` |
| Lint：xelab 详细化检查（当前文件 + 工作区依赖） | — | `svtools.xvlog.elaborate` |
| Icarus Verilog: 运行仿真 | — | `svtools.iverilog.simulate` |
| Icarus Verilog: 停止仿真 | — | `svtools.iverilog.stopSimulation` |
| Icarus Verilog: 打开 VCD 波形查看器 | — | `svtools.iverilog.openWaveform` |
| VCD: 以波形打开 | — | `svtools.iverilog.waveformFromText` |
| VCD: 以文本显示 | — | `svtools.iverilog.showText` |
| Vivado: 运行 TCL 脚本 | — | `svtools.vivado.runScript` |
| Vivado: 运行当前 TCL 脚本 | — | `svtools.vivado.runActiveScript` |
| Vivado: 停止 | — | `svtools.vivado.stop` |
| Vivado: 创建工程 | — | `svtools.vivado.createProject` |
| Vivado: 添加文件进工程 | — | `svtools.vivado.addToFileset` |
| Vivado: 从工程移除文件 | — | `svtools.vivado.removeFromFileset` |
| Vivado: 仿真当前文件 (xsim) | — | `svtools.vivado.simulate` |
| 仿真… | — | `svtools.simulate.pick` |
| Vivado：OOC 报告（资源占用 + 逻辑级数） | — | `svtools.vivado.reports` |
| 刷新工程树 | — | `svtools.vivado.tree.refresh` |
| 添加文件到工程 | — | `svtools.vivado.tree.addFile` |
| 从工程移除文件 | — | `svtools.vivado.tree.removeFile` |
| 设为综合顶层 | — | `svtools.vivado.tree.setTopSynth` |
| 设为仿真顶层 | — | `svtools.vivado.tree.setTopSim` |
| 移到 sim_1（仿真源文件） | — | `svtools.vivado.tree.moveToSim` |
| 移到 sources_1（设计源文件） | — | `svtools.vivado.tree.moveToSources` |
| xelab 详细化（顶层模块） | — | `svtools.vivado.tree.elaborate` |
| 运行综合 | — | `svtools.vivado.tree.synthesize` |
| 运行布局布线 | — | `svtools.vivado.tree.implement` |
| 综合报告（资源占用 + 逻辑级数） | — | `svtools.vivado.tree.reportSynth` |
| 实现报告（时序汇总 + 资源占用） | — | `svtools.vivado.tree.reportImpl` |
| 布局布线报告（资源占用） | — | `svtools.vivado.tree.reportImplUtil` |
| 时序报告（WNS/TNS） | — | `svtools.vivado.tree.reportTiming` |
| 生成 Bitstream | — | `svtools.vivado.tree.bitstream` |
| 仿真 Top 详细化（xelab） | — | `svtools.vivado.tree.quickElaborate` |
| 全部展开 | — | `svtools.vivado.tree.expandAll` |
| Vivado：选择工程 | — | `svtools.vivado.tree.selectProject` |
| Vivado：停止面板任务 | — | `svtools.vivado.tree.stop` |
| 打开电路网表（JSON） | — | `svtools.circuit.open` |
| 查看 RTL 电路（Yosys） | — | `svtools.circuit.fromSource` |
| 查看工程 Top 电路（Vivado） | — | `svtools.circuit.fromVivado` |
| 停止电路生成 | — | `svtools.circuit.stop` |
| 查看当前文件电路（Vivado） | — | `svtools.circuit.fromVivadoFile` |
| 追踪信号驱动 | — | `svtools.circuit.traceDrivers` |
| 追踪信号负载 | — | `svtools.circuit.traceLoads` |
| SV Tools：选择工程 | — | `svtools.project.choose` |
| SV Tools：创建工程 | — | `svtools.project.create` |
| SV Tools：添加文件 | — | `svtools.project.add` |
| 添加到SV Tools工程 | — | `svtools.project.addToProject` |
| 在工程中追踪信号 | — | `svtools.project.trace` |
| 刷新SV Tools工程 | — | `svtools.project.refresh` |

波形和电路视图内部的手势与按键见[波形](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)和[电路](https://github.com/JayceVane/SV-Tools/wiki/Circuits)页面。
