# logic-circuit-source-context

> **发现方式**：用户先报通用Slang详细化失败，随后补充half_adder未定义日志。
> **定位范围**：2026-10-16，完整日志、当前工程只读验证与公开枚举夹具。
> **修复位置**：`src/circuit/source-context.js`、`source-dependencies.js`、`source-request.js`、`yosys-diagnostics.js`、`source-paths.js`。

## 症状

```text
ERROR: Design elaboration failed; see full log for details
source0/full_adder.sv:1:31: error: use of undeclared identifier 'impl_t'
```

后续用户把参数改为字符串，错误变成：

```text
source0/full_adder.sv:16:13: error: unknown module 'half_adder'
source0/full_adder.sv:22:13: error: unknown module 'half_adder'
```

## 排查过程

任务sources.sv仅include当前full_adder。impl_t实际在corelib_pkg中，导入只写在testbench；编译上下文缺package，模块本身也没有限定类型名。该声明若按枚举保留，即使补包仍不能将字符串直接赋给枚举。真实Slang进一步确认：

```text
error: no implicit conversion from 'bit[79:0]' to 'impl_t'; explicit conversion exists, are you missing a cast?
```

用户当前磁盘版本改成无显式类型的字符串参数后，类型问题消失，half_adder的源文件依旧没有传入。它在工作区里存在，与顶层类型语法无关。单纯改成string或切换前端不能补上设计上下文。

旧摘要只保留第一条ERROR；Slang的通用收尾和具体错误可能来自不同流，先后不稳定。失败回归复现通用文本遮住真实行列。

## 根因与修复

当前文件入口只追加当前文件，缺少默认依赖收集。现在显式sources继续遵守用户顺序；空列表通过VS Code发现候选，由Worker复用语义解析构建模块/接口/包闭包，只提交相关文件。限定名包和子模块先于使用方，名称不依赖文件名。重复定义报错，literal include避免重复单独读入。选中脏依赖按文件序号隔离快照，保留源位置映射。

源路径映射集中供模型和错误摘要共用。错误收集保留第一条具体源码诊断，通用ERROR只作备选；启动和日志写入失败仍优先。没有自动注入import、改变枚举值或降级前端。

## 验证与边界

公开夹具检查不可见类型、字符串枚举、缺子模块三类失败，以及自动收集包/半加器/全加器/顶层的顺序。两个枚举实现保留独立模块，结构分支包含两个半加器；flatten后以真实Yosys eval验证全部8组输入。用户当前字符串版本直接只读生成成功，自动sources为half_adder、full_adder，保留两个半加器实例，原文件哈希相同。

自动扫描不展开宏、条件编译或generate，不替代编译器。限定当前根、4096文件、单文件2 MiB及总量32 MiB；有外部库、超限或复杂预处理上下文时使用显式文件表。浏览器和布局预算没有改变。

复验：`node scripts/verify-circuit-enum.js`；回归覆盖取消、同名文件脏快照、include、重复定义和源位置边界。完整清单见`docs/V4_1_ALPHA6.md`。
