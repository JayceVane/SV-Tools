# SystemVerilog Tools for VSCode

一款适用于 Visual Studio Code 的 Verilog/SystemVerilog 代码格式化和生产力工具插件，改编自 Sublime Text SystemVerilog 插件和 Verilog-Gadget 插件。

**版本**: v3.2.21

> **v3.0 重大更新**: 核心引擎使用 Rust 重构，无需 Python 依赖，性能大幅提升！

## 功能特性

### 格式化功能
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
- **Rust Native 后端**：使用 Rust 编译的原生模块，无需 Python，启动快、性能高

### Verilog-Gadget 生产力工具

#### 1. 模块实例化生成 (Generate Module Instantiation)
- 自动解析模块定义
- 生成模块实例化代码
- 自动识别时钟和复位信号
- **自动生成端口声明**：
  - input 端口自动生成 `reg` 声明
  - output 端口自动生成 `wire` 声明
  - inout 端口自动生成 `wire` 声明
  - 每个声明单独一行
- 复制到剪贴板，方便粘贴

**快捷键**: `Ctrl+Shift+C` (Windows/Linux) / `Cmd+Shift+C` (macOS)

**使用方法**:
1. 打开包含模块定义的文件
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Generate Module Instantiation"
3. 实例化代码会自动复制到剪贴板

#### 2. 测试台生成 (Generate Testbench)
- 自动生成完整的测试台代码
- 自动生成时钟和复位逻辑
- 可配置的波形dump类型 (fsdb/vpd/shm/vcd)
- 自动生成 init 和 drive 任务

**快捷键**: `Ctrl+Shift+T` (Windows/Linux) / `Cmd+Shift+T` (macOS)

**使用方法**:
1. 打开包含模块定义的文件
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Generate Testbench"
3. 新的测试台文件会自动创建

#### 3. 代码重复编号 (Repeat Code with Numbers)
- 使用格式化占位符重复代码
- 支持多种格式化选项（十进制、十六进制等）
- 支持行列步进控制
- 支持剪贴板内容插入

**快捷键**: `Ctrl+F12` (Windows/Linux) / `Cmd+F12` (macOS)

**占位符格式**:
- `{:d}` - 十进制整数
- `{0:03x}` - 十六进制，3位，前导零
- `{cb}` - 剪贴板内容（每行）

**使用方法**:
1. 选中包含占位符的代码
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Repeat Code with Numbers"
3. 输入范围和步进（格式：`start~end,row_step,col_step`）
4. 代码会自动生成

**示例**:
```
选中: assign signal_{:d} = {:d};
输入: 0~8
结果:
assign signal_0 = 0;
assign signal_1 = 1;
...
assign signal_8 = 8;
```

#### 4. 代码对齐 (Align Selected Code)
- 使用 verilog-beautifier 格式化引擎
- 智能识别代码类型并自动对齐
- 支持端口声明对齐
- 支持信号声明对齐
- 支持实例化端口对齐
- 支持赋值语句对齐

**快捷键**: `Ctrl+Shift+X` (Windows/Linux) / `Cmd+Shift+X` (macOS)

**使用方法**:
1. 选中需要对齐的代码块
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Align Selected Code"
3. 代码会自动对齐

#### 5. 文件头插入 (Insert File Header)
- 插入标准化的文件头注释
- 支持自定义模板
- 自动填充文件名、日期、时间等信息

**快捷键**: `Ctrl+Shift+Insert` (Windows/Linux) / `Cmd+Shift+Insert` (macOS)

**模板占位符**:
- `{FILE}` - 文件名
- `{DATE}` - 创建日期 (YYYY-MM-DD)
- `{TIME}` - 创建时间 (HH:MM:SS)
- `{YEAR}` - 年份
- `{TABS}` - 制表符大小

**使用方法**:
1. 打开文件或新建文件
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Insert File Header"
3. 文件头会自动插入到文件开头

## 系统要求

- Visual Studio Code 1.74.0 或更高版本
- **无需安装 Python**（v3.0+ 使用 Rust 原生模块）

## 安装方法

### 从 VSCode Marketplace 安装（推荐）

在 VSCode 扩展市场搜索 "SystemVerilog Tools" 并安装。

### 从源码安装

1. 克隆或下载本仓库
2. 打开 VSCode
3. 按 `F5` 打开新的扩展开发宿主窗口，插件会自动加载
4. 或者打包插件：
   ```bash
   cd vscode-extension
   npm install
   # 构建 Rust 原生模块（需要 Rust 工具链）
   cd src-rust && cargo build --release
   cp target/release/svtools.dll ../  # Windows
   # 或 cp target/release/libsvtools.so ../  # Linux
   # 或 cp target/release/libsvtools.dylib ../  # macOS
   
   vsce package
   ```
   然后在 VSCode 中安装生成的 `.vsix` 文件

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
  }
}
```

### 手动格式化

- Windows/Linux: `Shift+Alt+F`
- macOS: `Shift+Option+F`
- 或在编辑器中右键选择"格式化文档"

### 格式化选中区域

选中一段代码后使用格式化命令，仅格式化选中的代码块。

## 配置选项

所有配置都在 `svtools` 配置项下，可在 VSCode 设置中搜索 `svtools` 进行配置：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `tabSize` | number | 4 | 缩进使用的空格数量 |
| `useTab` | boolean | false | 使用 Tab 字符进行缩进 |
| `oneBindPerLine` | boolean | true | 模块实例化时每个端口绑定单独一行 |
| `oneDeclPerLine` | boolean | false | 每个信号声明单独一行 |
| `paramOneLine` | boolean | true | 尽可能将参数保持在一行 |
| `indentStyle` | string | "1tbs" | 缩进风格（"1tbs" 或 "gnu"） |
| `stripEmptyLine` | boolean | true | 删除多余的空行 |
| `maxConsecutiveEmptyLines` | number | 1 | 允许的最大连续空行数（0 = 移除所有空行） |
| `instAlignPort` | boolean | true | 对齐模块实例化端口 |
| `ignoreTick` | boolean | true | 缩进时忽略预处理器指令 |
| `importSameLine` | boolean | false | 将 import 语句与模块声明保持在同一行 |
| `alignComma` | boolean | true | 对齐逗号/分号 |
| `instPrefix` | string | "u_" | 模块实例名称默认前缀 |
| `includePortDeclarations` | boolean | true | 生成模块实例化时是否包含端口声明 |
| `reset` | array | ["rst_n", "reset_n"] | 异步复位信号名称列表 |
| `sreset` | array | ["sreset", "srst"] | 同步复位信号名称列表 |
| `clock` | array | ["clk", "uclk", "cclk"] | 时钟信号名称列表 |
| `waveType` | string | "fsdb" | 波形dump类型 (fsdb/vpd/shm/vcd) |
| `taskInit` | boolean | true | 在测试台中生成 init 任务 |
| `taskDrive` | boolean | true | 在测试台中生成 drive 任务 |
| `headerTemplate` | string | "" | 文件头模板（使用占位符） |

> **注意**: v3.0+ 已移除 `pythonPath` 配置项，因为不再需要 Python 依赖。

### 配置示例

在 VSCode 的 `settings.json` 中添加：

```json
{
  "svtools.tabSize": 4,
  "svtools.useTab": false,
  "svtools.oneBindPerLine": true,
  "svtools.oneDeclPerLine": false,
  "svtools.paramOneLine": false,
  "svtools.indentStyle": "1tbs",
  "svtools.stripEmptyLine": true,
  "svtools.instAlignPort": true,
  "svtools.instPrefix": "u_",
  "svtools.clock": ["clk", "sys_clk"],
  "svtools.reset": ["rst_n", "arst_n"],
  "svtools.waveType": "fsdb"
}
```

### 格式化命令
- `svtools.formatDocument` - 格式化当前文档

### 生产力工具命令
- `svtools.moduleInstantiation` - 生成模块实例化代码
- `svtools.generateTestbench` - 生成测试台
- `svtools.repeatCode` - 重复代码并编号
- `svtools.alignCode` - 对齐选中的代码
- `svtools.insertHeader` - 插入文件头

## 快捷键

| 命令 | Windows/Linux | macOS |
|------|---------------|-------|
| 生成模块实例化 | `Ctrl+Shift+C` | `Cmd+Shift+C` |
| 生成测试台 | `Ctrl+Shift+T` | `Cmd+Shift+T` |
| 重复代码编号 | `Ctrl+F12` | `Cmd+F12` |
| 对齐代码 | `Ctrl+Shift+X` | `Cmd+Shift+X` |
| 插入文件头 | `Ctrl+Shift+Insert` | `Cmd+Shift+Insert` |

## 架构

本项目使用 **Rust Native Backend**：

- 核心格式化和代码生成逻辑使用 Rust 编写
- 通过 napi-rs 编译为原生 Node.js 模块
- 无需外部运行时依赖（Python 等）
- 启动速度快，内存占用低

## 格式化示例

### 格式化前
```systemverilog
module alu (
input clk,rst_n,
input [3:0] opcode,
input [31:0] operand_a,operand_b,
output reg [31:0] result,
output zero,overflow
);
reg zero_flag,overflow_flag;
always @(posedge clk or negedge rst_n) begin
if(!rst_n) begin
result<=32'd0;
zero_flag<=1'b0;
overflow_flag<=1'b0;
end else begin
case(opcode)
4'd0:result<=operand_a+operand_b;
4'd1:result<=operand_a-operand_b;
4'd2:result<=operand_a&operand_b;
4'd3:result<=operand_a|operand_b;
default:result<=32'd0;
endcase
zero_flag<=(result==32'd0);
end
end
assign zero=zero_flag;
assign overflow=overflow_flag;
endmodule
```

### 格式化后
```systemverilog
module alu (
    input                clk, rst_n,
    input      [ 3:0]    opcode   ,
    input      [31:0]    operand_a, operand_b,
    output reg [31:0]    result   ,
    output               zero, overflow
);

    reg zero_flag,overflow_flag;

    always @(posedge clk or negedge rst_n) begin
        if(!rst_n) begin
            result        <= 32'd0;
            zero_flag     <= 1'b0 ;
            overflow_flag <= 1'b0 ;
        end else begin
            case(opcode)
                4'd0:result<=operand_a+operand_b;
                4'd1:result<=operand_a-operand_b;
                4'd2:result<=operand_a&operand_b;
                4'd3:result<=operand_a|operand_b;
                default:result<=32'd0           ;
            endcase
            zero_flag <= (result==32'd0);
        end
    end

    assign zero     = zero_flag;
    assign overflow = overflow_flag;

endmodule
```

**格式化特性**：
- ✅ 端口声明对齐
- ✅ 信号声明对齐
- ✅ always 块自动缩进
- ✅ case 语句格式化
- ✅ 赋值语句对齐
- ✅ 自动插入空行分隔逻辑块

## 项目结构

```
vscode-extension/
├── extension.js           # VSCode 扩展入口
├── package.json           # 扩展清单文件
├── svtools.win32-x64-msvc.node  # Rust 编译的原生模块
├── templates/             # 模板文件
│   └── header_template.txt
└── src-rust/              # Rust 源码
    ├── Cargo.toml
    ├── src/
    │   ├── lib.rs         # napi-rs 入口
    │   ├── beautifier.rs  # 格式化核心
    │   ├── tokenizer.rs   # 词法分析
    │   ├── parser/        # 语法解析
    │   ├── align/         # 对齐算法
    │   └── codegen/       # 代码生成
    └── build.rs
```

## 调试

1. 在 VSCode 中打开插件源码
2. 在 `extension.js` 或 `src-rust/src/` 中设置断点
3. 按 `F5` 启动调试
4. 查看"输出"面板中的错误信息

## 常见问题

### 格式化没有生效
1. 确认扩展已正确安装并激活
2. 检查文件语言模式是否为 Verilog 或 SystemVerilog
3. 查看 VSCode 输出面板的错误信息

### 中文注释乱码
本插件已修复 Windows 平台中文乱码问题，强制使用 UTF-8 编码。如仍有问题，请检查文件保存编码是否为 UTF-8。

### 找不到原生模块
确保 `svtools.win32-x64-msvc.node`（Windows）或对应的 `.node` 文件存在于扩展目录中。

## 致谢

本 VSCode 插件改编自以下 Sublime Text 插件的核心逻辑：

1. [Nicolas Belmonte 的 Sublime Text SystemVerilog 插件](https://github.com/nicolas3d/SystemVerilog) - 格式化功能
2. [yongchan jeon (Kris) 的 Verilog-Gadget 插件](https://github.com/poucotm/Verilog-Gadget) - 生产力工具

### 原作者
- **Nicolas Belmonte** - [Sublime Text SystemVerilog Plugin](https://github.com/nicolas3d/SystemVerilog)
- **yongchan jeon (Kris)** - [Verilog-Gadget Plugin](https://github.com/poucotm/Verilog-Gadget)

### VSCode 扩展开发
- **JayceVane** - [VSCode 集成封装](https://github.com/JayceVane)
  - 邮箱: [JayceVane@163.com](mailto:JayceVane@163.com)

### AI 辅助开发
本项目的开发过程中使用了以下 AI 工具辅助编码、调试和文档编写：
- [OpenCode](https://github.com/opencode-ai/opencode) - AI 编程助手
- [GLM (智谱 AI)](https://zhipuai.cn) - 大语言模型

## 许可证

Copyright (c) 2025 JayceVane

本软件采用 [Apache License, Version 2.0](LICENSE) 许可。关于第三方代码的信息，请参阅 [NOTICE](NOTICE) 文件。

本插件包含 Sublime Text SystemVerilog 插件和 Verilog-Gadget 插件的核心逻辑，同样采用 Apache License, Version 2.0 许可。

### 许可证摘要

您可以：
- ✅ 在个人和商业项目中使用本插件
- ✅ 修改和分发代码
- ✅ 对代码进行子许可

您必须：
- ⚠️ 包含原始版权和许可声明
- ⚠️ 说明对文件所做的重大更改

完整条款请参阅 [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0)。
