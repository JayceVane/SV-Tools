---
name: svtools-design
description: 用独立的分层伪 SystemVerilog 建立新设计或提炼已有工程的架构，检查接口契约，导出可逐层核验的 HTML／PDF，并将设计笔记绑定到 HDL 注释、选区或具名块。
---

# 架构设计与报告

架构设计和事后架构报告均先建立独立的伪 SystemVerilog 工作区。用模块层级和 `interface/modport` 表达功能分块、接口方向与关键数据路径，叶子模块可保留实现桩。事后报告以原工程为取证来源，将关键虚拟模块及接口映射到实际 RTL 实例、BD 或 IP。

1. 读取[建模与核验约定](references/architecture.md)，建立顶层、子系统和接口层。各层模块边界上的标准协议，以及成员、方向和角色有明确约定的项目接口，必须封装为可复用的 `interface`，端点通过 `modport` 声明。原 RTL 使用散线时也按此要求建立伪 SV 模型。
2. 在模型根目录用 `svtools.architecture.json` 设置标题、同层功能分组和数据路径讲解。已有模块 `design.md` 时，可用 `designDocs` 按模块类型名绑定。字段和验收规则见[报告展示配置](references/architecture.md#报告展示配置)。
3. 导出前逐层核对接口封装。用 `design check --engine struct` 检查模型，再用 `design export --format html` 导出并抽查接口束、成员方向、功能分组及已绑定的设计说明。查看 `chapterCount`、`diagnostics` 和 `artifacts`。需要定版时导出 PDF。
4. 交付伪 SV、章节化文档、绑定的设计说明源文件，以及事后报告的原工程映射。约束、仲裁、位宽或连接仍待核实时，在交付中明确状态。

[架构 CLI](references/cli.md) 给出命令、输出字段和诊断边界。`design arch`、`design render` 和 `design report` 提供结构投影、单图及机器证据。`design plan` 和模块任务交接按 `svtools-delivery` 执行。

为源码局部逻辑补充设计说明时，读取[富文本 Note 与源码锚点](references/note-anchors.md)。用 `//: 标题 [note:ID]` 或成对的 `//< 标题 [note:ID]`、`//>` 绑定注释。需要保持 HDL 原文时，用侧车锚点绑定选区或现有 `begin : name`。架构报告的模块章正文通过 `designDocs` 单独指定。
