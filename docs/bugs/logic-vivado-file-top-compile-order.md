# logic-vivado-file-top-compile-order

> **发现方式**：用户查看工程内独立模块时详细化失败。
> **定位耗时**：本轮真实Vivado验收。
> **修复位置**：`src/circuit/vivado-export.tcl`、`vivado-export.js`、`vivado-runner.js`。

## 症状

```text
ERROR: [Synth 8-439] module 'unreferenced' not found
SVTOOLS_CIRCUIT_ERROR ERROR: [Vivado_Tcl 4-5] Elaboration failed - please see the console for details
```

文件已加入工程且`USED_IN_SYNTHESIS`为真，XPR仍可能将它标为`AutoDisabled`。旧测试选择的leaf位于top层级内，没有覆盖独立文件。

## 排查过程

- 文件存在且模块名正确，工程成员校验也通过；这不代表它出现在旧top的有效综合编译列表中。
- 使用公开top/orphan两个文件复现：只读打开工程后直接`-top orphan`失败。
- 另存任务副本、设置副本top并`update_compile_order`后，编译列表包含orphan，真实RTL详细化成功。
- Windows Tcl使用系统代码页解析新增中文字符串时出现`missing close-brace`；显式UTF-8加载解决解析，但中文错误仍经系统编码写到stderr。Vivado自定义puts会绕过通道编码，仅fconfigure不足以修复。错误改用有界ASCII标记承载UTF-8十六进制，由Node严格解码；中文路径也通过ASCII脚本中的UTF-8字面量传递。

## 根因

Vivado按当前工程top生成层级和AutoDisabled状态；`synth_design -rtl -top`不重算该工程编译列表。旧版本的报错展示又优先使用Tcl收尾标记，遮住了前面的具体Synth诊断。

## 修复

当前文件Vivado只读打开原工程并校验成员，在独立任务目录`save_project_as -exclude_run_results`。确认current_project目录已切换到副本，再关闭自动选top、设置所选top并更新编译顺序。工程面板仍直接使用原工程top。来源文件、宏、include、文件类型和IP配置沿用工程上下文。

日志摘要优先取第一条具体ERROR，再回退到Tcl标记；完整日志仍保留。UTF-8协议由生成入口负责，不修改全局Vivado设置。公开验收新增未引用模块、中文/空格路径和工程外文件拒绝，并在每次成功/失败后比较原工程与源文件。

[AMD关于top与编译顺序的说明](https://docs.amd.com/r/2021.2-English/ug895-vivado-system-level-design-entry/Specifying-the-Top-Module-and-Reordering-Source-Files)、[save_project_as参考](https://docs.amd.com/r/2022.1-English/ug835-vivado-tcl-commands/save_project_as)。

## 教训

工程成员、被当前层级使用、作为本次top可详细化是三个不同条件。当前文件验收必须包含旧top未引用的独立源文件；Windows工具链还需分别验证脚本输入与日志输出编码。
