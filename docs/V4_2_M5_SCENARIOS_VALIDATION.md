# M5 批 3 收尾：IDE 宿主矩阵与四端到端场景验证记录

2026-11-06，Windows x64，Node.js 24.17.0，pwsh 7.6.9。基线 `b640cbd` 加本批收尾工作树（含用户 2026-11-05 晚间完成的场景脚本与四处修复）。本记录补齐批 3 最后两项门禁的可重跑证据：目标 IDE 真机宿主矩阵、四个端到端场景串联。

## IDE 宿主矩阵（可重跑）

```powershell
node scripts/verify-m5-host-matrix.cjs --ide "Visual Studio Code=D:\Tools\Microsoft VS Code\Code.exe" `
  --ide "Qoder CN IDE=D:\Tools\Qoder CN IDE\Qoder CN IDE.exe" --cygwin <cygwin64\bin>
```

`verify-m5-host-matrix.cjs` 为本次入库的矩阵生成器：聚合 5 个 `verify-*-host.ps1` × N 个目标 IDE，逐宿主隐藏启动真实 IDE 扩展宿主，读取各 run 目录的 `host-report.json` 汇总成 `bin/m5-host-matrix.json`（此前该矩阵为手工拼装，生成器不在库内——本批补上）。两处实现要点：

- **必须 pwsh**：宿主脚本是 UTF-8 无 BOM，Windows PowerShell 5.1 按 ANSI 代码页解析会把中文串读坏成 ParserError（本批实测 10/10 全炸）；pwsh 7 默认 UTF-8，正常。
- **Icarus 透传**：补全宿主的「真实接受参数补全后 Icarus 编译通过」子项由 `-IcarusPath/-CygwinPath` 启用（ps1 写 run 内 `tools.json`）；聚合器自动发现 Icarus 并透传，找不到时降级为 21/22 项并在 stderr 提示。

| IDE | 内核 | circuit | completion | project | vivado | waveform |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Visual Studio Code | 1.144.0 | 6/0 | 22/0 | 11/0 | 8/0 | 5/0 |
| Qoder CN IDE | 1.106.3 | 6/0 | 22/0 | 11/0 | 8/0 | 5/0 |

（格式：checks 通过数/失败数；两 IDE 合计 10 行全部 0 失败，`failed=0`，补全宿主含 Icarus 真实编译子项。行内 `app` 标签来自聚合器入参——Qoder 内核自报 `appName` 为 "Visual Studio Code"，不可作为区分依据。）

## 四个端到端场景（可重跑）

```powershell
node scripts/verify-m5-scenarios.cjs --iverilog <icarus-bin>
```

`verify-m5-scenarios.cjs` 把四个场景串成一条可核验证据链，产物在 `bin/m5-scenarios/run-<ts>/bundle/`（本记录绑定矩阵 `createdUtc=2026-11-06T03:34:49Z`，最近一次 run 10 步 0 失败 0 警告）。现场步骤：

| # | 场景 | 现场步骤 | 结果 |
| --- | --- | --- | --- |
| S1 | 从架构到工程 | `design arch/check/diff/report`（参数化 FIFO 空模块骨架，报告包逐产物 sha256 复核）+ `verify-design-workflow.cjs` 真实 Icarus 工作流四场景 | 全过 |
| S2 | 从失败到修复 | `verify-fifo-workflow.cjs` 三轮仿真（baseline TC_PASS verified=220 / 注错 PHANTOM_READ t=3069000 / 修复复验）+ 同一 VCD 的 `wave export` layout/csv/png | 全过 |
| S3 | 从报告到优化 | Vivado 报告/工程树结构化解析回归（`vivado_commands_test` + `vivado_tree_test`）；真实综合引用批 3 真机记录 | 全过 |
| S4 | 从工程到文档 | 汇总报告包、波形证据、三批验证记录与双 IDE 宿主矩阵，逐文件 sha256 登记，纯 JSON/MD/SVG/PNG 无 IDE 依赖 | 全过 |

场景结论（沿用脚本 `scenarios.json` 声明）：场景 2「从失败到修复」、场景 4「从工程到文档」**verified**；场景 1、3 **partial**——现场部分为 CLI 侧与解析回归，真实 Vivado 工程创建/综合/资源报告引用批 3 真机记录（[M5 批 3 验证记录](V4_2_M5_VIVADO_VALIDATION.md)），未在本脚本内现场重跑分钟级综合。

## 同批收尾修复

- UTF-8 BOM 源码的设计单元识别：`extractDesignUnits` 去 BOM 后按原文区间返回，带回归测试。
- 所选 Vivado 工程文件被删除后 `vivadoSelection.current()` 明确报「已不存在」而非裸 ENOENT，重新选择可恢复，带回归测试。
- `verify-waveform-host.ps1`：`WaitForExit(ms)` 后补无参 `WaitForExit()` 确保 `ExitCode` 已刷新，并解析 `host-report.json` 断言 `status.ready/loaded/error`。
- 补全宿主「超过 30 行实例端口」用例对异步文件事件改用 `eventually` 重试，消除时序抖动。
- `.gitignore`/`.vscodeignore` 补 `tools.json`（本机工具路径，防止误提交/入包）。

## 边界与剩余

矩阵与场景链均为**单机、单 Agent 分阶段**证据；Qoder 行的区分依据是内核版本号而非自报 appName。剩余发行门禁：真实 Vivado「从报告到优化」的现场完整闭环、多 Agent 独立性、四场景单次连续真机串联、发行机械（版本统一、`package.json` 仍为 4.1.1、CHANGELOG、VSIX/许可复核）。M5 未全部通过前不合并、不发行 4.2。
