# SystemVerilog / UVM 补全

在代码编辑处输入前缀，或按 `Ctrl+Space` 请求补全。补全包含语言关键词、系统调用、编译指令、上下文符号、命名端口/参数、片段和 UVM 参考库接口。

## 选择语言与 UVM 版本

```json
{
  "svtools.completion.standard": "auto",
  "svtools.completion.uvmVersion": "1.2",
  "svtools.completion.includePaths": ["include", "verification"],
  "svtools.completion.maxFiles": 5000,
  "svtools.completion.maxFileSizeKB": 2048,
  "svtools.completion.maxTotalSourceMB": 32,
  "svtools.completion.maxItems": 1000
}
```

`auto` 默认按语言模式与 `begin_keywords` 区间选择：`.v/.vh` 使用 Verilog 2005，`.sv/.svh` 使用 SystemVerilog 2023。可显式选择历史版本。UVM 可选 `1.2`、`1800.2`、`off`。

这些设置只控制补全目录，不替换编译器语言选项，也不安装 UVM 库。实际仿真仍要配置所用 UVM 的源文件、include 与宏。

## 常用场景

| 输入位置 | 提供的帮助 |
|---|---|
| `pkg::` 或 import 后 | 包成员与可见声明 |
| 对象后的 `.`、`this.`、`super.` | 可见字段、方法及继承成员 |
| 例化的 `#(` 与 `(` 内 | 命名参数/端口，排除已连接项 |
| 数组/queue/string 等对象后的 `.` | 与类型和剩余维度匹配的方法 |
| UVM class、phase 或宏处 | phase、factory、config_db、TLM、RAL 等参考接口和片段 |

接受方法或宏补全后，可通过 Tab 继续编辑参数占位。已有括号时避免重复插入。未保存正文优先于磁盘索引；外部库放入 `completion.includePaths`，相对目录按工作区展开。

## 没有找到预期补全

先确认语言模式、标准版本、UVM 版本及定义是否位于当前作用域/已导入包。达到文件、源码或候选预算时，继续输入更长前缀，或按项目需要调整索引预算。源码容量预算不等于扩展进程内存上限。

补全不执行完整预处理、宏展开、generate 详细化或任意表达式类型推导；条件编译、多文件类外方法和复杂重载仍有边界。不能将固定目录覆盖解释为所有标准语义场景的 100% 实现。

[详细覆盖与边界](https://github.com/JayceVane/SV-Tools/blob/v4.0.0/docs/COMPLETION.md) · [公开参考库来源与许可证](https://github.com/JayceVane/SV-Tools/blob/v4.0.0/docs/COMPLETION_SOURCES.md)
