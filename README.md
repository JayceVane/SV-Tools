# SystemVerilog Align Formatter for VSCode

一款适用于 Visual Studio Code 的 Verilog/SystemVerilog 代码格式化插件，改编自 Sublime Text SystemVerilog 插件。

## 功能特性

- 自动格式化 Verilog 和 SystemVerilog 文件
- **完整 Unicode 支持** - 完美支持中文、日文、韩文等 UTF-8 编码的注释
- 对齐功能：
  - 模块端口声明
  - 信号/变量声明
  - 模块实例化端口
  - 参数定义
  - 赋值语句
  - case 语句
  - always 块
- 可配置的缩进风格（空格或制表符）
- 删除空行选项
- 每行单声明/单绑定选项
- **高性能**：使用持久化守护进程，格式化速度提升 87-93%

## 系统要求

- 已安装 [Python 3.6+](https://www.python.org/downloads/) 并添加到 PATH 环境变量
- Visual Studio Code 1.74.0 或更高版本

## 安装方法

### 从源码安装

1. 克隆或下载本仓库
2. 打开 VSCode
3. 按 `F5` 打开新的扩展开发宿主窗口，插件会自动加载
4. 或者打包插件：
   ```bash
   cd vscode-extension
   npm install
   vsce package
   ```
   然后在 VSCode 中安装生成的 `.vsix` 文件

### 手动安装

1. 将 `vscode-extension` 文件夹复制到 VSCode 扩展目录：
   - Windows: `%USERPROFILE%\.vscode\extensions`
   - Linux: `~/.vscode/extensions`
   - macOS: `~/.vscode/extensions`

2. 将文件夹重命名为 `sv-align`

## 使用方法

### 保存时自动格式化

在 VSCode 的 `settings.json` 中添加以下配置：

```json
{
  "[verilog]": {
    "editor.formatOnSave": true
  },
  "[systemverilog]": {
    "editor.formatOnSave": true
  },
  "svAlign.pythonPath": "python"  // Linux/Mac 上使用 "python3"
}
```

### 手动格式化

- Windows/Linux: `Shift+Alt+F`
- macOS: `Shift+Option+F`
- 或在编辑器中右键选择"格式化文档"

### 格式化选中区域

选中一段代码后使用格式化命令，仅格式化选中的代码块。

## 配置选项

所有配置都在 `svAlign` 配置项下，可在 VSCode 设置中搜索 `svAlign` 进行配置：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `tabSize` | number | 4 | 缩进使用的空格数量 |
| `useTab` | boolean | false | 使用 Tab 字符进行缩进 |
| `oneBindPerLine` | boolean | true | 模块实例化时每个端口绑定单独一行 |
| `oneDeclPerLine` | boolean | false | 每个信号声明单独一行 |
| `paramOneLine` | boolean | true | 尽可能将参数保持在一行 |
| `indentStyle` | string | "1tbs" | 缩进风格（"1tbs" 或 "gnu"） |
| `stripEmptyLine` | boolean | true | 删除多余的空行 |
| `instAlignPort` | boolean | true | 对齐模块实例化端口 |
| `ignoreTick` | boolean | true | 缩进时忽略预处理器指令 |
| `importSameLine` | boolean | false | 将 import 语句与模块声明保持在同一行 |
| `alignComma` | boolean | true | 对齐逗号/分号 |

### 配置项详细说明

#### `tabSize`（缩进空格数）
- **类型**: 数字
- **默认值**: 4
- **说明**: 控制代码缩进使用的空格数量。推荐设置为 4 个空格以符合常见代码风格。

#### `useTab`（使用 Tab）
- **类型**: 布尔值
- **默认值**: false
- **说明**: 设为 true 时使用 Tab 字符缩进，false 使用空格缩进。建议使用空格缩进以保持跨平台一致性。

#### `oneBindPerLine`（每行单端口）
- **类型**: 布尔值
- **默认值**: true
- **说明**: 模块实例化时，是否将每个端口连接放在单独一行。
  - true: 每个端口单独一行，便于查看和注释
  - false: 端口可以紧凑排列在同一行

#### `oneDeclPerLine`（每行单声明）
- **类型**: 布尔值
- **默认值**: false
- **说明**: 是否强制每个信号声明单独一行。
  - true: `logic a; logic b;` 会被拆分为两行
  - false: 允许 `logic a, b;` 这种声明方式

#### `paramOneLine`（参数单行）
- **类型**: 布尔值
- **默认值**: true
- **说明**: 尽可能将参数定义保持在同一行。
  - true: 短参数定义会保持在一行
  - false: 每个参数单独一行

#### `indentStyle`（缩进风格）
- **类型**: 字符串
- **默认值**: "1tbs"
- **可选值**: "1tbs" 或 "gnu"
- **说明**:
  - "1tbs": 传统的 One True Brace Style，左括号在同一行
  - "gnu": GNU 风格，左括号单独一行

#### `stripEmptyLine`（删除空行）
- **类型**: 布尔值
- **默认值**: true
- **说明**: 删除代码中多余的空行，保持代码紧凑。

#### `instAlignPort`（对齐实例端口）
- **类型**: 布尔值
- **默认值**: true
- **说明**: 模块实例化时是否对齐端口连接，提高代码可读性。

#### `ignoreTick`（忽略预处理器指令）
- **类型**: 布尔值
- **默认值**: true
- **说明**: 缩进计算时是否忽略 `` `ifdef`、`` `define` 等预处理器指令。

#### `importSameLine`（import 同行）
- **类型**: 布尔值
- **默认值**: false
- **说明**: 将 import 语句与模块声明保持在同一行。

#### `alignComma`（对齐逗号分号）
- **类型**: 布尔值
- **默认值**: true
- **说明**: 对齐声明中的逗号和分号，提高代码对齐美观度。

### 配置示例

在 VSCode 的 `settings.json` 中添加：

```json
{
  "svAlign.tabSize": 4,
  "svAlign.useTab": false,
  "svAlign.oneBindPerLine": true,
  "svAlign.oneDeclPerLine": false,
  "svAlign.paramOneLine": false,
  "svAlign.indentStyle": "1tbs",
  "svAlign.stripEmptyLine": true,
  "svAlign.instAlignPort": true
}
```

## 自定义 Python 路径

如果 Python 不在系统 PATH 中，可以指定完整路径：

### Windows
```json
{
  "svAlign.pythonPath": "C:\\Python39\\python.exe"
}
```

### Linux/macOS
```json
{
  "svAlign.pythonPath": "/usr/bin/python3"
}
```

## 格式化示例

### 格式化前
```systemverilog
module test(
input clk, // 时钟信号
input rst_n, // 复位信号
output [7:0] data // 数据输出
);
logic [7:0] buffer;
assign data = buffer;
endmodule
```

### 格式化后
```systemverilog
module test (
   input        clk    , // 时钟信号
   input        rst_n  , // 复位信号
   output logic [7:0] data     // 数据输出
);
   logic [7:0] buffer;

   assign data = buffer;

endmodule
```

## 项目结构

```
vscode-extension/
├── extension.js           # VSCode 扩展入口
├── processManager.js      # Python 守护进程管理器
├── package.json           # 扩展清单文件
├── python/               # Python 格式化脚本
│   ├── daemon.py         # 守护进程（高性能）
│   ├── formatter.py      # 主格式化包装器（备用）
│   └── verilogutil/      # 核心格式化逻辑
│       ├── verilog_beautifier.py
│       └── verilogutil.py
```

## 调试

1. 在 VSCode 中打开插件源码
2. 在 `extension.js` 或 `python/daemon.py` 中设置断点
3. 按 `F5` 启动调试
4. 查看"输出"面板中的错误信息

## 常见问题

### 格式化没有生效
1. 确认 Python 已正确安装并在 PATH 中
2. 检查 `svAlign.pythonPath` 配置是否正确
3. 查看 VSCode 输出面板的错误信息

### 中文注释乱码
本插件已修复 Windows 平台中文乱码问题，强制使用 UTF-8 编码。如仍有问题，请检查文件保存编码是否为 UTF-8。

### 格式化速度慢
v2.0.0 版本已优化性能，使用持久化守护进程，格式化速度提升 87-93%。

## 致谢

本 VSCode 插件改编自 [Nicolas Belmonte 的 Sublime Text SystemVerilog 插件](https://github.com/nicolas3d/SystemVerilog)的核心格式化逻辑。所有核心格式化算法均保留自原始实现。

### 原作者
- **Nicolas Belmonte** - [Sublime Text SystemVerilog Plugin](https://github.com/nicolas3d/SystemVerilog)

### VSCode 扩展开发
- **JayceVane** - [VSCode 集成封装](https://github.com/JayceVane)
  - 邮箱: [JayceVane@163.com](mailto:JayceVane@163.com)

## 许可证

Copyright (c) 2025 JayceVane

本软件采用 [Apache License, Version 2.0](LICENSE) 许可。关于第三方代码的信息，请参阅 [NOTICE](NOTICE) 文件。

本插件包含 Sublime Text SystemVerilog 插件的核心格式化逻辑，同样采用 Apache License, Version 2.0 许可。

### 许可证摘要

您可以：
- ✅ 在个人和商业项目中使用本插件
- ✅ 修改和分发代码
- ✅ 对代码进行子许可

您必须：
- ⚠️ 包含原始版权和许可声明
- ⚠️ 说明对文件所做的重大更改

完整条款请参阅 [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0)。
