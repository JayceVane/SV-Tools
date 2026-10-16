# compat-yosys-systemverilog-frontend

> **发现方式**：用户点击默认Yosys入口查看含timeunit/timeprecision的RTL失败。
> **定位耗时**：本轮默认入口验收。
> **修复位置**：`source-request.js`、`yosys-runner.js`、`svtools.circuit.frontend`配置。

## 症状

```text
Executing Verilog-2005 frontend: /task/sources.sv
ERROR: syntax error, unexpected TOK_ID
```

错误位于模块外的`timeunit 1ns;`，模块内时序声明也会被旧前端拒绝。WASI ExperimentalWarning只是启动提示，原先被拼入失败摘要后遮住了具体错误。

## 排查过程

- 默认脚本仍使用`read_verilog -sv`；内置包虽有Slang，默认配置和源请求却固定verilog。
- 对同一原文件显式调用read_slang成功。预处理后的网表使用`$aldff`，AD=0、ALOAD低有效、CLK上升沿、D=1，符合复位行为；不能要求不同前端必须生成同名原语。
- 新增默认路径的两个真实编译用例：编译单元时序声明、模块内声明及未保存快照。修复前均失败，修复后验证寄存器参数、引脚连接、Worker/ELK与原文件源位置。

## 修复

前端默认auto：已固定打包的内置Yosys选Slang，外部工具沿用旧Verilog前端以免假定其安装了Slang。显式配置优先；不按关键字删除声明、不在失败后换前端重试。源码文件及未保存正文保持完整。

onLine捕获普通ERROR及带文件/行号的error，哪怕退出码为0也不能当作成功。摘要优先具体错误；日志、超时和启动错误仍保留。显式旧前端的语法错误给出Slang提示。

[Yosys的语言支持范围](https://yosyshq.readthedocs.io/projects/yosys/en/latest/using_yosys/verilog.html)、[Slang elaborator](https://github.com/povik/sv-elab)。

## 教训

支持某个后端选项不等于默认流程使用了它。验收需从配置缺省值进入，保留标准语法，并检查电路语义与连接；仅验证外部工具或显式Slang不足以覆盖用户实际点击路径。
