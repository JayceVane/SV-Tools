# M5 协作基础验证记录

2026-11-05，Windows x64，Node.js 24.17.0；核心基线 `1ae668a` 加本次工作流变更。记录仅覆盖本批架构任务、交接与只读进展功能，不宣称全部 M5 或 4.2 发行验收完成。

## 自动回归

- `npm test`：JS 语法检查 356 文件；Agent 54 通过 / 3 环境跳过；golden 44 项通过；主套件 942 通过 / 14 跳过；电路 254 通过。无失败。
- `node --test test/design_workflow_test.js test/project_view_test.js test/project_client_test.js`：24 项通过。覆盖跨进程领取竞争、revision 冲突、令牌失效、共享源文件、依赖失效、失败验证、报告哈希、窗口/信号遗漏、路径链接及只读 UI 跳转。
- 五份 Skill 经 `quick_validate.py` 验证通过。实际公开打包清单检查通过。

## 真实 RTL 试点

可重跑：

```powershell
node scripts/verify-design-workflow.cjs --iverilog <icarus-bin>
```

脚本复用现有工具路径及 Cygwin 环境发现，生成独立 `bin/workflow-e2e-<timestamp>/`，保存 JSON、原始日志、VCD 和最终 summary。不修改用户 RTL 工程。此次实际工具为 Icarus Verilog 13.0 stable。

| 场景 | 编译退出 | 仿真退出 | 交接结果 |
| --- | ---: | ---: | --- |
| 正常寄存取反设计 | 0 | 0 | 当前证据核验通过 |
| 注入错误透传实现，保持原独立 XOR 期望 | 0 | 1 | 验证失败，拒绝核验 |
| 退回、修复后按原条件重跑 | 0 | 0 | 复验通过 |
| 修改 TB | — | — | 证据标过期，核验通过计数归零 |

复位检查和 16 次独立期望比较均由真实仿真执行；ΔCycle 检查覆盖计划信号的全部已记录窗口，文件无同刻瞬态命中。这只说明该文件记录内未发现，不证明实际电路没有毛刺。本次采用单 Agent 分阶段角色，未验证多 Agent 独立性。

## 页面验证与剩余范围

使用真实 `src/project` HTML/CSS/客户端脚本和上述试点的进展快照，在本机浏览器宿主预览中检查了 340px 侧栏渲染：三个投影共用侧栏，过期计数清晰，模块详情和报告按钮可读。宿主消息、工程身份和过期链接通过自动测试。该预览不等同于真实 VS Code/Qoder 扩展宿主验收。

仍需按 M5 计划完成 FIFO/多时钟试点、真实 Vivado 与目标客户端联合验收。当前工作流不聚合跨 worktree 状态，不自动调度 Agent；输入清单和运行收据由调用方提供，校验本地产物一致性，不认证实际执行或替代功能证明。
