---
name: svtools-design
description: 用独立的分层伪 SystemVerilog 建立新设计或提炼已有工程的架构，检查接口契约，导出可逐层核验的 HTML／PDF。
---

# 架构设计与报告

架构设计和事后架构报告均先建立独立的伪 SystemVerilog 工作区。用模块层级和 `interface/modport` 表达功能分块、接口方向与关键数据路径，叶子模块可保留实现桩。事后报告以原工程为取证来源，将关键虚拟模块及接口映射到实际 RTL 实例、BD 或 IP。

1. 读取[建模与核验约定](references/architecture.md)，建立顶层、子系统和接口层。各层模块边界上的标准协议，以及成员、方向和角色有明确约定的项目接口，必须封装为可复用的 `interface`，端点通过 `modport` 声明。原 RTL 使用散线时也按此要求建立伪 SV 模型。
2. 导出前逐层核对接口封装，补齐仍以散线表达的成组接口。用 `design check --engine struct` 检查模型，再用 `design export --format html` 导出，抽查接口以单束出现在图中，并能展开成员和方向。查看 `chapterCount`、`diagnostics` 和 `artifacts`。需要定版时导出 PDF。
3. 交付伪 SV、章节化文档，以及事后报告的原工程映射。约束、仲裁、位宽或连接仍待核实时，在交付中明确状态。

[架构 CLI](references/cli.md) 给出命令、输出字段和诊断边界。`design arch`、`design render` 和 `design report` 提供结构投影、单图及机器证据。`design plan` 和模块任务交接按 `svtools-delivery` 执行。
