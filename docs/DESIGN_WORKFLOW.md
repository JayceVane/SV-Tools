# 架构交付与设计进展

4.2 开发分支增加架构任务计划、CLI 交接和插件只读进展。完整规格、命令与证据格式见 [Agent 工作流](../skills/svtools-delivery/references/workflow.md)。

1. 在 RTL 工程建立规格，执行 `design plan --spec spec.json`，生成 `svtools.design.json` 和架构报告。
2. Agent 通过 `design claim/submit/return/review` 推进模块；写入必须携带当前 revision 和领取令牌。
3. 打开原有 **SV Tools 工程** 侧栏，选择目标工程，切换 **设计进展**。查看需求、职责、负责人、依赖、候选当前性、验证阶段，点击源码与证据跳转文件。仍然只有一个工程侧栏。

默认读取所选工程根目录的 `svtools.design.json`，可通过 `svtools.design.planFile` 改为工程内的相对路径。页面没有计划时显示创建提示，不调用综合、仿真或架构工具，也不创建任务状态目录。原文件/实例视图及 Vivado 流程保持原入口。

“核验通过”仅统计当前候选且证据仍有效的模块。修改源码、接口、设计说明、TB 或产物后显示待复验；阶段历史不等于当前通过。视图只读，任务变更从 CLI 执行；文件变化自动刷新，也可手动刷新。模块展开位置在刷新后保留。

本批完成协作基础，尚不包含跨工作树状态聚合、自动 Agent 调度和完整 M5 工程/客户端联合验收。文件身份检查不能替代功能验证。

本批实际验证与剩余范围见 [验证记录](V4_2_M5_WORKFLOW_VALIDATION.md)。
