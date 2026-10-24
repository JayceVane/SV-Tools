# 代码生成与文件头

## 模块例化

1. 打开目标模块定义文件，保持 Verilog/SystemVerilog 语言模式。
2. 执行 **生成模块实例化**，快捷键 `Ctrl+Shift+C`（macOS 为 `Cmd+Shift+C`）。
3. 结果写入剪贴板，回到调用位置粘贴并按工程需要修改连接。

端口逐一按原名连接；时钟、复位配置是测试台控制信号识别规则，不是将不同端口折成同一名称的别名表。`svtools.includePortDeclarations` 可附带连接信号声明，`svtools.instPrefix` 控制实例名前缀。

```json
{
  "svtools.instPrefix": "u_",
  "svtools.includePortDeclarations": false
}
```

## 测试台骨架

执行 **生成测试台** / `Ctrl+Shift+T`。结果打开在独立未命名文档，检查后保存为 `tb_*.sv` 再运行仿真。默认波形类型是 VCD；按需修改激励和结束条件。

```json
{
  "svtools.clock": ["clk", "clock", "i_clk"],
  "svtools.reset": ["rst_n", "reset_n", "i_rst_n"],
  "svtools.waveType": "vcd",
  "svtools.taskInit": true,
  "svtools.taskDrive": true
}
```

多时钟域保持独立信号；无时钟模块也能生成延时骨架。生成器不推断总线协议、CDC 时序约束或合法业务事务，需自行补充驱动与检查。不能忠实表达的数组、interface、用户类型或类型参数会报错，保留原文，不静默省略接口。

## 文件头：直接编辑多行

在设置中搜索 `svtools.headerTemplate`，直接粘贴带实际换行的文本。该设置使用多行输入框。若编辑 `settings.json`，使用 JSON 的 `\n` 表示换行：

```json
{
  "svtools.headerTemplate": "// Module: {FILE}\n// Date: {DATE} {TIME}\n// Author: Your Name\n"
}
```

## 文件头：独立文本文件

在项目中保存 UTF-8 文件 `templates/header.txt`，例如：

```text
// Module: {FILE}
// Date: {DATE} {TIME}
// Copyright (C) {YEAR} Your Company
```

配置：

```json
{
  "svtools.headerTemplateFile": "${workspaceFolder}/templates/header.txt"
}
```

执行 **插入文件头** / `Ctrl+Shift+Insert`。模板按 **外部文件 → 内联字符串 → 内置模板** 选择，支持 `{FILE}`、`{DATE}`、`{TIME}`、`{YEAR}`，兼容 `{RDATE}`、`{RTIME}`。

相对路径按当前文档所属工作区解析，工作区外按源码目录解析；也支持绝对路径。每次插入重新读取，修改模板后无需重载。允许 UTF-8 BOM、保留内部空行并补齐末尾换行；文件缺失、空白或编码无效时明确报错，不插入默认头。

模板文件和多行设置中直接使用真实换行，不把所有字面 `\n` 自动解码，以免破坏 Windows 路径或代码示例。以前被单行设置压平的模板需重新粘贴。

## 按数字重复

选中带 `{:d}` 或 `{0:03x}` 等占位符的文本，执行 **按数字重复代码** / `Ctrl+F12`，按输入框提示填写 `起点~终点[,行步进[,列步进]]`。先在小范围检查生成结果，再用于批量连接。
