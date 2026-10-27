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

## 2026-10-27：工程追踪的多文件编译单元冲突

> **发现方式**：用户在工程中追踪信号，顶层为adder，无关sfifo文件报错。
> **修复位置**：`project/flow-controller.js`、`project/rtl-worker.js`、`rtl-model.js`、`rtl-expression.js`。
> **修复提交**：`be6fdb2`。

```text
1. Executing SLANG frontend.
Top level design units:
    adder
in file included from task/sources.sv:5:
source2/sfifo.sv:17:10: error: time scale declaration must come before all other items in scope
```

检查原文件发现timeunit/timeprecision就在文件开头，不能要求用户移动或删除合法声明。此时已使用Slang，旧前端不支持语法不是根因。
原工程追踪强制把全部DesignSrcs交给Yosys；`buildSourceWrapper`将其统一include进`/task/sources.sv`。前面的文件已有模块，后续文件的编译单元时间声明就不再位于作用域开头。无关且不可综合的源码也会阻断整个追踪。

根因是将源码导航依赖于综合与单编译单元包装，不能靠继续换前端解决。当前修复只改变工程追踪边界：独立Worker逐文件读取RTL，静态适配声明、已知参数、连续别名与明确实例端口到共同连接模型；不调用Yosys、ELK或工具任务，不产生临时网表，不改变用户源码。电路图生成仍使用原有工具链，包装器没有在本次改写。

受支持的静态连接保留实际位位置和实例隔离。宏、生成块、未知类型/范围等不展开，明确提示边界；未解析位宽不能降级成单比特，顺序端口也不能因此错位。静态结果不是完整elaboration的替代证明。

新增回归覆盖独立时间声明、无关不可综合模块、参数覆盖、非ANSI顺序/隐式端口、三层透传、条件include与旧世代拒绝。真实Qoder验收将Yosys路径设为不存在，确认追踪正常且不创建工具目录；用户工程另外只读验证包含sfifo的输入仍可追踪adder。

[Slang编译单元说明](https://www.sv-lang.com/user-manual.html#compilation-units)明确默认逐文件编译单元与合并输入的区别。今后凡是源码索引/连接导航，应先明确是否真的需要执行完整工具详细化。
