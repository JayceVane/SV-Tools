# SystemVerilog Tools for VSCode

一款适用于 Visual Studio Code 的 Verilog/SystemVerilog 格式化与生产力工具插件。
核心引擎使用 **Rust 原生模块**（napi-rs），无需 Python 依赖；设置界面与命令支持**中英文自动切换**。

改编自 Sublime Text [SystemVerilog](https://github.com/TheClams/SystemVerilog)（格式化）与 [Verilog-Gadget](https://github.com/poucotm/Verilog-Gadget)（生产力工具）插件。

当前开发预览版本为 **4.0.0-beta.9**，修复注释后跨行参数例化漏对齐，保留波形与电路SVG/PNG图片导出、布局复用及共享源码上下文；[已发布4.0.0-beta.2](https://github.com/JayceVane/SV-Tools/releases/tag/v4.0.0-beta.2) 提供 Windows x64 VSIX 与 CLI。开发预览可通过本地VSIX安装并重载窗口，正式版目标为 **4.0.0**。源码位于 `src/`，构建产物位于 `bin/`。

格式化只能改变普通空格、Tab、CR、LF；其它字符的内容、次数和顺序必须保持，即使输入
全部乱码或语法不完整。无法安全提交的布局保留原文，详见 [格式化规范](docs/FORMAT_SPEC.md)。

4.0 波形查看器采用后台流式加载与按需时间窗，增加双游标 Δt 和信号检索，已实测
100/500 MiB VCD。操作说明、性能数据与验收范围见 [波形查看器](docs/WAVEFORM.md)。

4.0 补全使用标准目录、容错语义模型和增量工程索引，支持 Verilog/SystemVerilog 版本选择、UVM 1.2/1800.2、类继承与泛型、端口/参数、数组与二维 mem 成员。配置、覆盖范围及限制见 [代码补全](docs/COMPLETION.md)。

预览波形支持批量背景色、总线逐位展开和RTL方向图标；保存/加载 `.svwave.json` 可在重新仿真后恢复显示布局；操作及边界见[波形说明](docs/WAVEFORM.md)。

波形和电路工具栏均有“导出图片”：波形按A/B区间自动调整画幅，也可导出当前时间视口；电路导出当前模块全图。可选黑白线稿/当前主题，以及SVG矢量图/高清PNG。

## 功能总览

**格式化**（保存时自动 / 手动 / 选中区域，`docs/FORMAT_SPEC.md` 为唯一行为规范）
- 端口/信号/参数声明、模块例化端口、赋值、case、always 对齐
- 单行/多行双轨：单行语句紧凑，显式换行走列对齐；空行规则统一裁决
- `` `pragma protect `` 加密区（Xilinx/Synopsys IP）逐字节透传，不破坏解密
- 行内紧凑 / 行间紧凑 / 端口名列间距等可配置，缩进空格或 Tab

**代码智能**
- 语法高亮（TextMate，含例化端口着色）
- 大纲 / 面包屑（tree-sitter：module、port、parameter、instance 等）
- Go to Definition（Ctrl+Click 例化跳转，跨文件）
- Hover 悬浮（模块端口/参数摘要、信号声明详情）
- 上下文感知补全（4 种代码场景 + 例化端口补全 + 31 个片段）

**生产力工具**（源自 Verilog-Gadget）
- 模块实例化生成（自动识别时钟/复位，可附带端口声明）
- 测试台生成（时钟/复位/波形 dump/init/drive 任务）
- 代码重复编号（`{:d}`、`{0:03x}` 占位符，行列步进）
- 代码对齐、文件头插入

**Icarus Verilog 工具链**（可选）
- Lint：输入防抖 / 打开 / 保存自动检查，跨文件模块解析（工作区索引 + `-y`）
- 仿真：状态栏 ▶ 一键编译运行，输出流式，可停止/超时
- 内置 VCD 波形查看器（双击 .vcd 打开，多选分组/边沿导航/格式切换，零外部依赖）

**Vivado 集成**（可选）
- 运行 TCL 脚本（工作区选择 / 右键当前文件）
- ▶ 仿真（Icarus / Vivado xsim 引擎选择）与 ⊕ 工程文件管理按钮
- 工程创建向导（源文件分类、器件选型逐级筛选、顶层识别）+ 工程结构模板

**电路结构查看器**（4.0 beta，可选本地工具）
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

- Visual Studio Code 1.106.0+（内置 Yosys 的 WASM 需要新版扩展宿主）
- 无需 Python；语法检查/仿真需要 [Icarus Verilog](http://iverilog.icarus.com/)（可选），Vivado 功能需要本机 Vivado 安装

## 安装

**市场**：VSCode 扩展市场搜索 "SystemVerilog Tools"。Open VSX 同名发布。

**源码**：

```bash
git clone <本仓库> && cd 02_svtools
npm ci
npm ci --prefix src/native
npm run build:native   # 需要 Rust 工具链；产物 .node 与 CLI 自动复制到 bin/
npm test               # golden、幂等、词法保真、工具运行与 VCD 合同
npm run package        # 生成 svtools-<版本>.vsix
```

没有 Rust 工具链时，从 GitHub Releases 下载对应 tag 的 `svtools.win32-x64-msvc.node` 放到仓库 bin/ 目录。

## 快速上手

打开任意 `.sv` / `.v` 文件即激活；`Shift+Alt+F` 格式化（默认保存时自动格式化，开关见 `editor.formatOnSave` 与扩展设置）。

| 命令 | 快捷键 (Win/Linux / macOS) |
|------|------|
| 生成模块实例化 | `Ctrl+Shift+C` / `Cmd+Shift+C` |
| 生成测试台 | `Ctrl+Shift+T` / `Cmd+Shift+T` |
| 重复代码编号 | `Ctrl+F12` / `Cmd+F12` |
| 对齐代码 | `Ctrl+Shift+X` / `Cmd+Shift+X` |
| 插入文件头 | `Ctrl+Shift+Insert` / `Cmd+Shift+Insert` |
| Icarus lint / 仿真 / Vivado 命令 | 命令面板搜索 "SystemVerilog Tools" |

全部 40 个命令与 48 项配置见命令面板与设置面板（已按 缩进与空行 → 换行与对齐 → 代码生成 → Icarus Verilog → Vivado 分组）。

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

### CLI

```bash
svtools.exe file.sv                # 格式化到 stdout
svtools.exe -i file1.sv file2.sv   # 原地格式化
svtools.exe -c *.sv                # 检查是否需要格式化（CI 可用）
svtools.exe --port-name-gap 1 f.sv # 任意配置项均有对应旗标
cat file.sv | svtools.exe -        # stdin
```

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
- **找不到原生模块**：市场/vsix 安装不会遇到；源码运行需 `bin/svtools.<平台>.node`（`npm run build:native` 或从 Releases 下载），放入后重载窗口。

## 文档

- [CHANGELOG](CHANGELOG.md) — 版本历史
- [docs/FORMAT_SPEC.md](docs/FORMAT_SPEC.md) — 格式化规范（唯一权威）
- [CONTRIBUTING](CONTRIBUTING.md) / [INSTALL](INSTALL.md) / [PUBLISH](PUBLISH.md) — 参与开发、安装与发布
- [example/](example/) — golden 格式化用例（输入 + 期望输出 + 幂等断言）

## 致谢

- [TheClams/SystemVerilog](https://github.com/TheClams/SystemVerilog) — 格式化核心逻辑
- [poucotm/Verilog-Gadget](https://github.com/poucotm/Verilog-Gadget) — 生产力工具
- [tree-sitter](https://github.com/tree-sitter/tree-sitter) / [tree-sitter-systemverilog](https://github.com/gmlarumbe/tree-sitter-systemverilog)（MIT）— 符号解析

VSCode 集成封装：[JayceVane](https://github.com/JayceVane)。开发过程有 AI 工具辅助编码与调试（OpenCode、GLM）。

## 许可证

Copyright (c) 2025 JayceVane — [Apache License, Version 2.0](LICENSE)。第三方代码许可信息见 [NOTICE](NOTICE)。
