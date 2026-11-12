# 架构计划、模块任务与证据交接

适用已决定采用任务化交付的 RTL 工程。CLI 写入协作状态；插件“SV Tools 工程 → 设计进展”只读展示同一份状态，不执行仿真或发起领取。无需 MCP，不自动启动子 Agent。Agent 身份是协作标签，没有认证或代码写权限隔离。

## 0. 交付闭环链路总览（编排索引）

本节只给顺序与交接关系；各段的命令、字段与硬约束仍以第 1–4 节为准。链路覆盖单个模块从架构契约到证据回流，不是自动流水线：领取、复核与返工都由人或 Agent 显式执行。

| # | 阶段 | 命令 | 输入 | 产物 → 下一环 | 失效条件 |
| --- | --- | --- | --- | --- | --- |
| ① | 架构契约 | `design plan` / `design report` | `spec.json`：需求、模块 ID、源文件清单、依赖门禁、三项必需检查 | `svtools.design.json` 与架构报告包 → ② | 源码 / 接口契约 / 设计说明变更 → 设计候选过期 |
| ② | 按模块分发 | `design tasks` / `design claim` | 当前 `revision`、角色、actor | 领取令牌与依赖门禁状态 → ③ | 并发写入冲突、依赖门禁未满足 |
| ③ | 设计提交 | `design submit`（设计侧） | 领取令牌、revision、设计说明 | `candidateId` + `candidateInputs` → ④ | 源码或设计说明变更 → 候选过期 |
| ④ | 验证复核 | `design claim`（验证侧）/ `design evidence` / `design submit` / `design review` | 同一候选输入，编译 / 仿真 / ΔCycle 收据 | 验证收据、独立期望、哈希与复核结论 → ⑤ | TB / 日志 / 报告 / 波形变更 → 验证过期 |
| ⑤ | 报告包交付 | `design report` / 波形导出 / 归档验证收据 | 当前 RTL、已复核的波形和验证收据 | 架构报告包（JSON / MD / SVG / PNG 及其哈希清单），另附波形导出产物和验证收据 → ⑥ | 依赖候选变更连带撤销下游当前性 |
| ⑥ | 回流 | `design return` / 重新领取 | 失效原因与返工条件 | 过期项不计入「核验通过」，复验后恢复当前 → ① | — |

**闭环的定义**：输入或产物一变，工具只做「标记过期 + 不计入核验通过」，**不自动重跑、不自动重新领取、不自动裁决**。由人或 Agent 重新走 ②→④ 并复核，链路才回到当前状态。工具校验的是本地产物一致性（第 4 节），不认证执行主体，也不证明功能完整。

交付物口径见 `../SKILL.md`；架构建模与报告包细则见 `svtools-design`，波形与 Vivado 证据来源见对应 Skill。

## 1. 先固定架构契约

创建 `spec.json`，为需求、模块分配稳定 ID。将下例职责、参数、源文件和信号改成实际工程内容。`sources` 包含所有影响模块结果的 RTL、头文件、初始化数据、约束等；这里只核对显式清单，不推断完整依赖。

```json
{
  "schemaVersion": 1,
  "id": "demo-v1",
  "title": "数据变换架构",
  "top": "transform",
  "overview": "输入数据经明确变换后输出；接口与行为以需求表为准。",
  "clocks": ["clk：上升沿"],
  "resets": ["rst_n：低有效异步复位，输出归零"],
  "interfaces": [{"name":"data_t", "encoding":"packed struct", "fields":["data[7:0]", "valid"]}],
  "requirements": [{"id":"R1", "text":"退出复位后，输出为前一周期输入按位取反"}],
  "modules": [{
    "id":"transform", "name":"transform", "responsibility":"按规格执行寄存输出的数据变换",
    "sources":["rtl/transform.sv"], "requirements":["R1"],
    "parameters":{"WIDTH":8}, "interfaceVersion":"1",
    "dependencies":[], "checks":["compile","simulation","delta-cycle"],
    "deltaSignals":["tb.clk","tb.rst_n","tb.dut.q"],
    "deltaWindow":{"from":"0","to":"end"}
  }]
}
```

`dependencies` 用 `{"module":"upstream-id","gate":"submitted"}` 或 `accepted`。前者等当前设计候选提交，后者等当前证据复核；循环依赖拒绝。`deltaWindow` 为波形整数 tick 字符串，默认全记录；部分窗口须事先在计划与验证报告解释。必需的三项检查不能删除。`deltaSignals` 用完整层级路径，不用模糊匹配。

```text
svtools-agent design plan --workspace <rtl-root> --spec spec.json
svtools-agent design tasks --workspace <rtl-root>
```

生成 `svtools.design.json` 和同名 Markdown 架构报告，默认拒绝覆盖。两份纳入 RTL 工程版本管理。计划变更后运行 `design plan-report --workspace <rtl-root> --force` 更新同名报告；运行状态独立放 `.svtools/agent/design-workflow/`。非默认计划用 `--plan <relative.json>`；插件用 `svtools.design.planFile` 相对所选工程根目录查找。

已有 `design scaffold` 规格可附加 `workflow` 对象（id/title/overview/clocks/resets/requirements/modules）。`workflow.modules` 按 `name` 关联骨架模块，补职责、需求、检查、deltaSignals 等。骨架默认共享 `rtl/<top>.sv`，并发编辑会串行；按模块分开源码后更新清单，不能假装共享文件属于不同写入者。虚拟通道继续使用 packed struct，成员与方向写在架构报告。

## 2. 领取、提交、退回、复验

每次写入前读取 `design tasks` 的最新 `data.revision`，传 `--revision`。并发写入只有一份成功；冲突后重读，不重放旧版本。

```text
svtools-agent design claim --module transform --role design --actor designer --revision 0
svtools-agent design submit --module transform --actor designer --token <claim-token> --revision 1 --evidence reports/design.md
svtools-agent design claim --module transform --role verification --actor verifier --revision 2
svtools-agent design evidence --module transform --evidence reports/verification-evidence.json
svtools-agent design submit --module transform --actor verifier --token <claim-token> --revision 3 --evidence reports/verification-evidence.json
svtools-agent design review --module transform --actor coordinator --revision 4 --reason "已核对需求、原始日志、独立期望和瞬态处置"
```

以上省略的 `--workspace <rtl-root>` 每条均须传入（除非 cwd 就是目标根目录）；非默认计划也每次传入 `--plan`。设计提交返回 `candidateId` 和 `candidateInputs`；验证侧照此绑定当前候选，不从另一次运行抄输入摘要。设计说明也绑定候选；修改说明后需重新提交。

`design evidence` 是只读预检，校验未通过退出 1，协议/路径/哈希错误退出 2。验证提交允许记录真实失败结果，显示“验证失败”，不会进入核验通过；缺失/篡改的文件身份则拒绝提交，保留领取。主 Agent 看原始证据后执行 `design review`；这不是自动功能裁决。需要返工时执行：

```text
svtools-agent design return --module transform --actor coordinator --revision <current> --reason "说明失败用例及返工条件"
```

退回撤销领取和验收，旧令牌失效；随后重新领取、提交、验证、核验。异常终止遗留领取也可由此回收。若进程在持有写锁时崩溃，出现 `STATE_BUSY`，须先确认其他写入进程已停止，再清理诊断中那一个 `.lock` 文件，保留 `.json`。

## 3. 验证证据格式

工具不提供通用仿真启动器。用实际仿真器编译/运行并保留原始 stdout/stderr，将退出状态、输入清单、用例判断封装为下述 JSON 收据。不得用手写 passed 代替实际运行。命令、工具版本、top、参数、种子与包含文件应能在报告中复现。

`verification-evidence.json` 的路径均相对工作区，SHA-256 是实际文件内容哈希（下例占位不能提交）：

```json
{
  "schemaVersion":1, "planId":"demo-v1", "moduleId":"transform", "candidateId":"candidate:<returned-id>",
  "inputs":[{"path":"rtl/transform.sv","sha256":"<actual-sha256>"}],
  "verificationInputs":[{"path":"sim/tb.sv","sha256":"<actual-sha256>"}],
  "checks":[
    {"id":"compile","status":"passed","command":["iverilog","-g2012","..."],"toolVersion":"actual version","report":{"path":"reports/compile.json","sha256":"<actual-sha256>"},"log":{"path":"reports/compile.log","sha256":"<actual-sha256>"}},
    {"id":"simulation","status":"passed","command":["vvp","..."],"toolVersion":"actual version","report":{"path":"reports/simulation.json","sha256":"<actual-sha256>"},"log":{"path":"reports/simulation.log","sha256":"<actual-sha256>"}},
    {"id":"delta-cycle","status":"passed","command":["svtools-agent","wave","glitches","..."],"toolVersion":"actual version","report":{"path":"reports/delta.json","sha256":"<actual-sha256>"},"waveform":{"path":".svtools/vcd/tb.vcd","sha256":"<actual-sha256>"},"dispositions":[]}
  ]
}
```

编译与仿真收据共同字段：`schemaVersion:1`、`kind:compile|simulation`、`candidateId`、`inputs`（完整设计输入和 verificationInputs）、`status:passed|failed`、`exitCode`、`completed`。仿真收据还包含：

```json
{
  "cases":[{"id":"TC1","requirements":["R1"],"status":"passed","oracle":"独立规则：前一周期采样值逐位取反，与 DUT 输出比较"}],
  "waveforms":[{"path":".svtools/vcd/tb.vcd","sha256":"<actual-sha256>"}]
}
```

每个模块需求都须有实际通过的功能用例及独立期望。TB/参考模型与设计输入分开，不能重复引用 RTL 当作验证输入。源码、TB、约束、include、初始化、断言、参考模型等所有结果输入均须列入相应清单；环境/外部依赖由验证报告补充，此处不保证捕获完整。

ΔCycle 报告使用 `wave glitches` 原始 JSON 输出，必须 `status=success`、完整、未截断，涵盖计划的信号与窗口；被查波形必须绑定同一仿真收据。每项 finding 提供 `{"signal":"完整路径","t":"整数tick","status":"resolved","reason":"实际分析及复验证据"}`。预期组合收敛可处置为已解释，无法判断的命中不能填 resolved。FST/VCD 只能检查文件实际记录的信息，无法恢复未录入的 delta；零命中不证明无物理毛刺、CDC 或时序安全。

## 4. 当前性与信任范围

源码/接口契约/设计说明改变 → 设计候选过期；验证输入/日志/报告/波形变化 → 验证过期。依赖候选改变会连带撤销下游当前性。保留历史阶段，但过期项不计入“核验通过”。触碰产物元数据也可能保守地要求复验。

这是 **local-artifact-validation**：检查本地声明、哈希、需求用例索引与当前文件的一致性，不认证谁实际执行过工具，不验证参考模型正确性，不证明功能完整。`functionalProof=false`，波形 `recordingCompleteness=unknown`。主 Agent 仍须审查原始日志与实际行为；actor 名不同也不证明独立执行。当前记录限定同一工作区路径，尚不汇总不同 worktree 的任务；跨树结果先集成到该工作区再生成候选和证据。
