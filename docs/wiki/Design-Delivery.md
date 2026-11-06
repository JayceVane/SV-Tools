# 架构计划与验证交接（4.2）

从需求、模块、接口和依赖建立一份计划，团队在同一工作区交付 RTL、测试台和复验记录。开始前可参考 [规格和证据示例](https://github.com/JayceVane/SV-Tools/blob/v4.2.0/skills/svtools-delivery/references/workflow.md)。

```powershell
svtools-agent.cmd design plan --workspace D:\rtl\demo --spec spec.json
svtools-agent.cmd design tasks --workspace D:\rtl\demo
```

默认生成 `svtools.design.json` 和 Markdown 架构报告。若希望查看模块接口和连接，可另外执行 `design report --top <top> --out reports/design`。

1. 设计侧用 `design claim --role design` 领取指定模块。记录返回的 revision 和 token，再用 `design submit --evidence <设计说明路径>` 提交当前候选。
2. 验证侧用 `design claim --role verification` 领取，按候选运行编译与仿真。将原始日志、用例结果和 `wave glitches` 结果写入证据清单，并用 `design evidence` 预检。
3. 验证侧执行 `design submit --evidence <证据清单路径>`。协调者结合原始产物执行 `design review --reason <结论>` 或 `design return --reason <返工理由>`。

写操作通过 `--module`、`--actor` 和 `--revision` 指定任务和当前状态，提交再提供领取令牌。遇到 revision 冲突时重新读取 `design tasks`，核对其他人提交的变化。证据和报告采用工作区相对路径，源码、TB、接口、依赖或产物变化时，进展会显示待复验。

在 IDE 中打开 **SV Tools 工程 → 设计进展**。该页读取同一工作区的计划和任务状态，可查看负责人、依赖、验收阶段并打开证据文件。若计划文件名不同，设置 `svtools.design.planFile` 为所选工程内的相对路径。

核验确认候选、需求用例和本地产物一致。角色名称是协作标签，功能结论由实际仿真、复验和审阅支持。[完整工作流与边界](https://github.com/JayceVane/SV-Tools/blob/v4.2.0/docs/DESIGN_WORKFLOW.md)
