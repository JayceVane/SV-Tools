# M5 批 3 验证记录：真实 Vivado 闭环与发行门禁

2026-11-05，Windows x64，Node.js 22.22.2，AMD Vivado 2022.1（`D:\DevKit\Xilinx\Vivado\2022.1\bin`），器件默认 `xc7z100ffg900-2`（可用 `SVTOOLS_TEST_VIVADO_PART` 覆盖）。基线 `c05457f`。记录只覆盖批 3 本轮实际执行的门禁，**不宣称 M5 或 4.2 发行验收完成**。

## 隔离工程

真实运行全部复用 `test/vivado_real_test.js` 的门控用例：每个用例自建 `os.tmpdir()/svtools-vivado-{smoke,lifecycle,e2e}-*` 临时工程，用例结束由 `t.after` 清理；不读取、不修改用户 RTL 工程，也不写入已有 Vivado 工程。工程写操作为 `project create/add/set-top`，运行与报告走 `vivado run/report` 的隔离构建（`.svtools/agent/vivado/builds/`，输入副本、检查点哈希与四轴证据由该模块自行管理）。

可重跑：

```powershell
SVTOOLS_TEST_VIVADO_LIFECYCLE=1 SVTOOLS_TEST_VIVADO_E2E=1 node --test test/vivado_real_test.js
node scripts/check-public-package.js
node --test test/public_package_test.js
gh pr checks 23
```

## 真实 Vivado 结果

| 用例 | 耗时 | 判定 |
| --- | ---: | --- |
| 状态查询：版本、器件、runs、工程上下文 | 16.6 s | 通过，`context.project.kind=vivado` |
| 生命周期：创建 → 加 `.sv` 与 `.xdc` → 设置综合/仿真两种 top → 状态复核 | 53.9 s | 通过，`created=true`、`added` 各 1、`applied=2` |
| 端到端：综合 → utilization / DRC 报告 → 改源 → 报告过期 → 复跑 → 资源对比 | 212.3 s | 通过 |
| 后台运行取消 | — | 跳过（需 `SVTOOLS_TEST_VIVADO_CANCEL=1`，本轮未开） |

合计 3 通过 / 0 失败 / 1 跳过，283.0 s。端到端的具体断言：两轮 `synth_1` 状态均为 `Complete`；首轮 `utilization.stale=false` 且能解析 LUT/FF 分层摘要，`drc.checked=1` 且违规数组可用；**修改 `top.sv` 后未重跑时 `stale=true`**，重跑后回到 `false`，且 LUT/FF 计数与改源前不同。这同时覆盖了"源变更后的证据失效"这一门禁，旧报告不会被升级为当前证据。

原始 TAP 结果（本轮）：

```text
ok 1 - 真实Vivado状态查询绑定工程并返回器件与runs            duration_ms: 16618.0358
ok 2 - 真实Vivado工程生命周期：创建/加源与XDC/设置两种top     duration_ms: 53948.2576
ok 3 - 真实后台运行取消                                  # SKIP
ok 4 - 真实Vivado端到端：创建→加源→综合→报告→改源→复跑→对比    duration_ms: 212307.9218
# tests 4 / pass 3 / fail 0 / skipped 1 / duration_ms 283024.8741
```

临时工程与 Vivado run 目录由用例清理，本记录以 TAP 结果和断言为证据，不保存可重放的完整 Vivado 工程。综合/资源/DRC 是工具事实，`verification.acceptance=false`，不构成功能验证通过。

## 兼容矩阵与发行检查

- **Node 22 / 24**：草稿 PR #23 的「完整回归（Node 22）」5m44s、「完整回归（Node 24）」5m35s 均为 `pass`（`gh pr checks 23`，推送 `c05457f` 后触发）。本机只有 Node 22.22.2，Node 24 由 CI 覆盖。
- **发行文件与许可**：`scripts/check-public-package.js` 通过，539 文件 / 113,947,293 bytes；`test/public_package_test.js` 5 项通过。
- **本轮发现并修复的发行回归**：新建工作区日志 `.workbuddy/memory/2026-11-05.md` 后，公开包守卫报「公开包文件不在发行范围内」。项目对 `.arts/`、`.opencode/`、`.sisyphus/`、`.zcode/` 等工具目录同时在 `.gitignore` 与 `.vscodeignore` 做了排除，`.workbuddy/` 缺规则；按同一惯例补齐两处后守卫恢复通过。该目录是项目数据，不删除、不进入 VSIX。
- **CLI 与插件打开同一产物**：批 2 提交的 `wave export --format layout` 闭环测试（CLI 生成 v1 `.svwave.json` → 查看器 `S.restore` 按声明身份命中、宿主同名自动读取、0 命中静默跳过）9 项通过，已接入 `npm test` 显式列表。本轮未再启动真实 IDE 宿主验证。

## 结论与剩余

批 3 的「真实 Vivado 创建/运行/报告闭环 + 源变更证据失效 + Node 矩阵 + 发行/许可检查」在本机通过。以下仍是未完成的发行门禁，不得据此宣称 4.2 可发行：

1. `SVTOOLS_TEST_VIVADO_CANCEL=1` 的后台取消路径未跑；
2. 目标 IDE 真机宿主验收：本机确认安装了 VS Code 与 Qoder CN IDE，但 `scripts/verify-*-host.ps1` 类宿主脚本未执行，客户端兼容矩阵未形成结论；
3. 四个端到端场景（架构→工程、失败→修复、报告→优化、工程→文档）尚未完整串联，仍是最终发行门禁；
4. M5 全流程仍为单 Agent 分阶段执行，多 Agent 独立性未验证；
5. 发行机械（版本统一、`package.json` 仍为 4.1.1、CHANGELOG、VSIX/CLI 产物与许可复核）未启动。

本轮真机命令末尾附带沙箱安全提示，为避免重复触发未重跑真机命令，结论取自已完整返回的 TAP 输出。
