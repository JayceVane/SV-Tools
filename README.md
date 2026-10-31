# SV Tools · Verilog / SystemVerilog 开发工具

[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Marketplace-Install-007ACC)](https://marketplace.visualstudio.com/items?itemName=JayceVane.svtools)
[![Open VSX](https://img.shields.io/open-vsx/v/JayceVane/svtools?label=Open%20VSX&color=C160EF)](https://open-vsx.org/extension/JayceVane/svtools)
[![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4)](#系统要求)
[![Apache-2.0](https://img.shields.io/github/license/JayceVane/SV-Tools)](LICENSE)

在 VS Code 中完成 RTL 格式化、代码生成、补全、工程管理、仿真、波形分析和电路信号追踪。核心引擎使用 **Rust 原生模块（napi-rs）**，安装包自带离线 Yosys，无需另外安装 Rust、Python 或 Yosys；设置与命令支持中英文自动切换。

**当前正式版本：4.1.1 · 正式支持平台：Windows x64。** 各市场版本以其详情页为准，4.1.1 的完整发布附件见 [GitHub Releases](https://github.com/JayceVane/SV-Tools/releases/tag/v4.1.1)。

[安装与第一次运行](https://github.com/JayceVane/SV-Tools/wiki/Getting-Started) · [图解使用指南](https://github.com/JayceVane/SV-Tools/wiki/Screenshots) · [4.1 信号追踪](https://github.com/JayceVane/SV-Tools/wiki/Signal-Tracing) · [版本说明](docs/releases/v4.1.1.md) · [反馈问题](https://github.com/JayceVane/SV-Tools/issues)

## 4.1：从信号出发查看设计

在 RTL 中选中信号，工程侧边栏会标出它经过的文件和实例；在电路中查看驱动、负载及位范围，逐级展开并定位源码；关联 VCD 后，可核对 A/B 游标处的精确值与变化位。

| 工作环节 | 能做什么 | 使用指南 |
|---|---|---|
| 编写 RTL | 声明、例化、赋值、task 参数对齐；语义补全、跳转和代码生成 | [格式化](https://github.com/JayceVane/SV-Tools/wiki/Formatting)、[补全](https://github.com/JayceVane/SV-Tools/wiki/Completion) |
| 管理工程 | 单侧边栏切换 Vivado / SV Tools 工程，按文件或实例层级查看信号走向 | [工程与信号追踪](https://github.com/JayceVane/SV-Tools/wiki/Signal-Tracing) |
| 运行仿真 | Icarus / Vivado xsim 工具链，检查诊断、停止任务并打开 VCD | [仿真](https://github.com/JayceVane/SV-Tools/wiki/Simulation) |
| 分析波形 | 后台加载大 VCD、A/B 读值、逐位展开、浮点、二维 mem 和布局保存 | [波形与存储器](https://github.com/JayceVane/SV-Tools/wiki/Waveforms) |
| 查看电路 | 标准 EDA 符号、总线位宽、网络高亮、小地图及局部驱动/负载追踪 | [电路查看器](https://github.com/JayceVane/SV-Tools/wiki/Circuits) |
| 整理文档 | 波形按 A/B 区间导出；电路导出模块全图；支持黑白线稿、当前主题、SVG / PNG | [界面图解](https://github.com/JayceVane/SV-Tools/wiki/Screenshots) |

### 界面预览

[![4.1 波形工作区：A/B 游标、总线展开与时间导航](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-workspace-4.1-light.png)](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

[![4.1 电路工作区：网络属性、驱动负载追踪与小地图](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/circuit-workspace-4.1-light.png)](https://github.com/JayceVane/SV-Tools/wiki/Circuits)

截图使用公开示例数据与实际 Webview，编号对应 [Wiki 图解](https://github.com/JayceVane/SV-Tools/wiki/Screenshots)。更多实例、配置和使用边界见各专题页。

### 格式化的基本约束

格式化只能改变普通空格、Tab、CR、LF；其它字符的内容、次数和顺序必须保持，即使输入全部乱码或语法不完整。无法安全提交的布局保留原文，详见 [格式化规范](docs/FORMAT_SPEC.md)。

## 功能总览

4.2 的开发入口见 [CLI 使用说明](docs/CLI.md)：可在不启动 IDE 的情况下查询工程、格式化源码、运行 Icarus 检查并管理后台任务。Agent 可配合仓库中的 [SV Tools Skill](skills/svtools-agent/SKILL.md) 使用；其余能力按 [4.2 计划](docs/V4_2_PLAN.md)推进。

**格式化**（手动 / 选中区域，`docs/FORMAT_SPEC.md` 为唯一行为规范）

- 端口/信号/参数声明、模块例化端口、赋值、case、always 对齐
- 单行/多行双轨：单行语句紧凑，显式换行走列对齐；空行规则统一裁决
- `` `pragma protect `` 加密区（Xilinx/Synopsys IP）逐字节透传，不破坏解密
- 行内紧凑 / 行间紧凑 / 端口名列间距等可配置，缩进空格或 Tab

**代码智能**

- 语法高亮（TextMate，含例化端口着色）
- 大纲 / 面包屑（tree-sitter：module、port、parameter、instance 等）
- Go to Definition（Ctrl+Click 例化跳转，跨文件）
- Hover 悬浮（模块端口/参数摘要、信号声明详情）
- 上下文补全与增量工程索引，支持 Verilog/SystemVerilog 版本、UVM 1.2/1800.2、类成员及端口/参数；[覆盖范围与限制](docs/COMPLETION.md)

**生产力工具**（源自 Verilog-Gadget）

- 模块实例化生成（逐端口同名连接，保留独立时钟/复位域，可附带端口声明）
- 测试台生成（时钟/复位/波形 dump/init/drive 任务）
- 代码重复编号（`{:d}`、`{0:03x}` 占位符，行列步进）
- 代码对齐、文件头插入

**Icarus Verilog 工具链**（可选）

- Lint：输入防抖 / 打开 / 保存自动检查，跨文件模块解析（工作区索引 + `-y`）
- 仿真：状态栏 ▶ 一键编译运行，输出流式，可停止/超时
- 默认点击 `.vcd` 打开内置波形查看器；多选分组、背景高亮、总线展开、FP64/FP32/TF32/BF16/FP16/FP8 和二维 mem
- 后台流式加载与按需时间窗，已实测 100/500 MiB VCD；[性能数据与验收范围](docs/WAVEFORM.md)

**Vivado 集成**（可选）

- 运行 TCL 脚本（工作区选择 / 右键当前文件）
- ▶ 仿真（Icarus / Vivado xsim 引擎选择）与统一工程侧边栏
- 工程创建向导（源文件分类、器件选型逐级筛选、顶层识别）+ 工程结构模板

**电路结构查看器**（内置 Yosys，可选本地 Vivado）

- 内置离线 Yosys，无需 Python 或额外安装；从当前 RTL 生成，或导入已有 JSON，支持源文件顺序、顶层、include 和宏
- 默认自动收集工作区子模块与包依赖，显式 sources 保留编译顺序；错误摘要显示原文件行列
- 独立电路模型与 ELK.js 正交布局，SVG 平移缩放、搜索、网络高亮、参数化模块下钻和源码定位
- 编辑器右上角默认使用内置 Yosys；RTL 右键用 Vivado 查看当前文件模块，工程面板使用工程 top
- Yosys 寄存器按明确参数显示触发沿与控制极性，锁存器独立符号；引脚详情保留原始名称、语义与工具参数
- 单比特细线与多比特粗线区分，总线斜杠位宽标记、I/O位数与可点击标签，选中和总览保留线型差异
- 拼接/拆分节点显示完整总线主干及分支位位置，重复常量明确标出复制次数；详情保留逐位映射
- 相机按帧刷新、视口外 SVG 按需挂载；总览自动简化细节，选择与搜索共享拓扑索引
- 解析和布局运行在 Worker；超预算明确提示，并保留模块选择以便查看较小子模块

命令面板搜索“电路”，或在 RTL 编辑器右键用内置 Yosys 生成；`svtools.circuit.yosysPath` 默认为 `bundled`，也可指定外部工具。前端默认`auto`：内置工具使用Slang解析SystemVerilog，外部工具兼容旧前端。Vivado 右键入口要求当前文件已保存且属于所选工程综合源，在任务副本中重建 top 与编译顺序。配置、数据语义、容量边界及验证命令见 [电路查看器](docs/CIRCUIT.md)。

**CLI 格式化器**：独立 `svtools.exe`，无需 VSCode。

## 系统要求

- **Windows x64**：当前唯一正式构建、测试和维护的平台；4.x 安装包标记为 `win32-x64`
- Visual Studio Code 1.106.0+（内置 Yosys 的 WASM 需要新版扩展宿主）
- 无需 Python；语法检查/仿真需要 [Icarus Verilog](http://iverilog.icarus.com/)（可选），Vivado 功能需要本机 Vivado 安装

## 安装

| 渠道 | 安装方式 |
|---|---|
| [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=JayceVane.svtools) | 在 VS Code 扩展市场搜索 **SystemVerilog Tools**，确认发布者为 **JayceVane** |
| [Open VSX](https://open-vsx.org/extension/JayceVane/svtools) | 在使用 Open VSX 的兼容 IDE 中安装，先确认扩展宿主版本满足要求 |
| [GitHub Releases](https://github.com/JayceVane/SV-Tools/releases) | 下载 `svtools-v4.1.1-win32-x64.vsix`，执行“扩展：从 VSIX 安装…”；同页提供 CLI 和 SHA256 |

扩展 ID 为 **`JayceVane.svtools`**。安装或更新后重载窗口；市场版本以对应页面为准。完整操作见 [安装指南](https://github.com/JayceVane/SV-Tools/wiki/Getting-Started)。

**源码**：

```bash
git clone https://github.com/JayceVane/SV-Tools.git
cd SV-Tools
npm ci
npm ci --prefix src/native
npm run build:native   # 需要 Rust 工具链；产物 .node 与 CLI 自动复制到 bin/
npm test               # golden、幂等、词法保真、工具运行与 VCD 合同
npm run package -- --target win32-x64 # 生成 Windows x64 VSIX
```

没有 Rust 工具链时，从 GitHub Releases 下载对应 tag 的 `svtools.win32-x64-msvc.node` 放到仓库 bin/ 目录。

## 快速上手

打开任意 `.sv` / `.v` 文件即激活；`Shift+Alt+F` 或命令面板“格式化文档”格式化。扩展不会在保存时自动格式化；如需保存即格式化，请在 VS Code 中自行启用 `editor.formatOnSave`（保存事件仅用于可选的保存时 lint 与工程视图刷新）。

| 命令 | 快捷键（Windows） |
|------|------|
| 生成模块实例化 | `Ctrl+Shift+C` |
| 生成测试台 | `Ctrl+Shift+T` |
| 重复代码编号 | `Ctrl+F12` |
| 对齐代码 | `Ctrl+Shift+X` |
| 插入文件头 | `Ctrl+Shift+Insert` |
| Icarus lint / 仿真 / Vivado 命令 | 命令面板搜索 "SystemVerilog Tools" |

全部命令与配置见命令面板和设置面板；按格式化、代码生成、工具链、工程、波形和电路等功能分组。

### 核心格式化配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `indentStyle` | `"1tbs"` | `1tbs`：begin 与控制行同行；`gnu`：begin 另起一行 |
| `tabSize` / `useTab` | 4 / false | 缩进宽度与字符 |
| `maxConsecutiveEmptyLines` | 1 | 空行上限；`0`=允许处也不留；`-1`=不处理 |
| `inlineCompact` | true | 单行语句内主动删除多余空格；关闭则保持原样 |
| `blankCompact` | true | 块内删空行、块间保证分隔；关闭为保持模式（不增不删） |
| `portNameGap` | 2 | 端口/参数表名称列与最宽前缀的空格数（1-8） |
| `alignComma` / `instAlignPort` | true | 逗号列 / 例化端口按列对齐 |

格式化行为的完整定义见 [`docs/FORMAT_SPEC.md`](docs/FORMAT_SPEC.md)。

### 文件头模板

在设置中搜索 `svtools.headerTemplate`，可在多行输入框直接粘贴文本；在 `settings.json` 中仍使用 JSON 的 `\n` 表示换行。例如：

```jsonc
"svtools.headerTemplate": "// Module: {FILE}\n// Date: {DATE} {TIME}\n// Author: Your Name\n"
```

也可把模板保存为独立 UTF-8 文本文件，并设置：

```jsonc
"svtools.headerTemplateFile": "${workspaceFolder}/templates/header.txt"
```

相对路径以当前源码所属的工作区文件夹为准；也支持绝对路径。源码在工作区外时，相对路径以源码目录为准。优先顺序为**外部文件 → 内联模板 → 内置模板**；每次插入都会重新读取文件，文件不存在、为空或不是 UTF-8 时明确报错并保持源码不变。模板支持 `{FILE}`、`{DATE}`、`{TIME}`、`{YEAR}`，兼容 `{RDATE}`、`{RTIME}`；保留内部空行并补齐末尾换行。两项设置均可按工作区文件夹配置。

### CLI

```bash
svtools.exe file.sv                # 格式化到 stdout
svtools.exe -i file1.sv file2.sv   # 原地格式化
svtools.exe -c *.sv                # 检查是否需要格式化（CI 可用）
svtools.exe --port-name-gap 1 f.sv # 常用格式化选项均有对应旗标
cat file.sv | svtools.exe -        # stdin
```

CLI 旗标覆盖常用格式化选项；`svtools.oneBindPerLine`、`svtools.paramOneLine`、`svtools.stripEmptyLine`、`svtools.ignoreTick`、`svtools.importSameLine` 等选项仅在 VS Code 扩展配置中生效。

可执行文件从 [GitHub Releases](https://github.com/JayceVane/SV-Tools/releases) 下载（随版本附 `.node` 与 `svtools.exe`）。

### 效果示例

```systemverilog
// 格式化后：端口/位宽/名称/逗号各列对齐，名称列与最宽前缀固定间距
module alu #(
    parameter  W  = 8  ,
    localparam DW = W*2
) (
    input      [ W-1:0]  opcode   ,
    input      [DW-1:0]  operand_a, operand_b,
    output reg [DW-1:0]  result   ,
    output               zero, overflow
);
```

## 常见问题

- **格式化没有生效**：确认文件语言模式为 Verilog/SystemVerilog；查看输出面板错误。
- **中文注释乱码**：插件强制 UTF-8；请确认文件本身以 UTF-8 保存。
- **找不到原生模块**：VSIX 安装不会遇到；源码运行需 `bin/svtools.<平台>.node`（`npm run build:native` 或从 Releases 下载），放入后重载窗口。

## 文档

- [GitHub Wiki](https://github.com/JayceVane/SV-Tools/wiki) — 按操作流程组织的使用指南和界面图解
- [CHANGELOG](CHANGELOG.md) — 版本历史
- [docs/FORMAT_SPEC.md](docs/FORMAT_SPEC.md) — 格式化规范（唯一权威）
- [CONTRIBUTING](CONTRIBUTING.md) / [INSTALL](INSTALL.md) / [PUBLISH](PUBLISH.md) — 参与开发、安装与发布
- [example/](example/) — golden 格式化用例（输入 + 期望输出 + 幂等断言）

## 致谢

- [TheClams/SystemVerilog](https://github.com/TheClams/SystemVerilog) — 格式化核心逻辑
- [poucotm/Verilog-Gadget](https://github.com/poucotm/Verilog-Gadget) — 生产力工具
- [tree-sitter](https://github.com/tree-sitter/tree-sitter) / [tree-sitter-systemverilog](https://github.com/gmlarumbe/tree-sitter-systemverilog)（MIT）— 符号解析

项目维护与 VS Code 集成：[JayceVane](https://github.com/JayceVane)。项目起源于上述 Sublime Text 插件的移植，并在此基础上持续重构与扩展。

开发过程也有 AI 工具与模型的参与：

- **Codex**：参与 4.x 的功能开发、重构、缺陷排查、测试及文档整理。
- **DeepSeek（Dsh）**：参与 4.x 部分子功能的开发与测试。
- **OpenCode、GLM**：辅助代码实现、调试和迭代。

## 许可证

Copyright (c) 2025 JayceVane — [Apache License, Version 2.0](LICENSE)。第三方代码许可信息见 [NOTICE](NOTICE)。
