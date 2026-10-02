# SystemVerilog Tools for VSCode

一款适用于 Visual Studio Code 的 Verilog/SystemVerilog 格式化与生产力工具插件。
核心引擎使用 **Rust 原生模块**（napi-rs），无需 Python 依赖；设置界面与命令支持**中英文自动切换**。

改编自 Sublime Text [SystemVerilog](https://github.com/TheClams/SystemVerilog)（格式化）与 [Verilog-Gadget](https://github.com/poucotm/Verilog-Gadget)（生产力工具）插件。

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

**CLI 格式化器**：独立 `svtools.exe`，无需 VSCode。

## 系统要求

- Visual Studio Code 1.74.0+
- 无需 Python；语法检查/仿真需要 [Icarus Verilog](http://iverilog.icarus.com/)（可选），Vivado 功能需要本机 Vivado 安装

## 安装

**市场**：VSCode 扩展市场搜索 "SystemVerilog Tools"。Open VSX 同名发布。

**源码**：

```bash
git clone <本仓库> && cd 02_svtools
npm install
npm run build:native   # 需要 Rust 工具链；产物 .node 自动复制到根目录
npm test               # golden 用例 + 幂等断言
npm run package        # 生成 svtools-<版本>.vsix
```

没有 Rust 工具链时，从 GitHub Releases 下载对应 tag 的 `svtools.win32-x64-msvc.node` 放到仓库根目录。

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

全部 20 个命令与 45 项配置见命令面板与设置面板（已按 缩进与空行 → 换行与对齐 → 代码生成 → Icarus Verilog → Vivado 分组）。

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
cat file.sv | svtools.exe          # stdin
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
- **找不到原生模块**：市场/vsix 安装不会遇到；源码运行需根目录 `svtools.win32-x64-msvc.node`（`npm run build:native` 或从 Releases 下载），放入后重载窗口。

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
