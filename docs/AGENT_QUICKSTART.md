# SV Tools Agent 4.2.0

适用 Windows x64 和 Node.js 22 或 24。解压 ZIP 后在 PowerShell 中进入解压目录，也可把该目录加到 PATH。Icarus 和 Vivado 用到时再安装，Vivado 需要相应的器件支持和许可。

```powershell
.\svtools-agent.cmd doctor --workspace D:\rtl\my_project
.\svtools-agent.cmd project inspect --workspace D:\rtl\my_project
.\svtools-agent.cmd design report --workspace D:\rtl\my_project --top top --out reports\architecture
```

`doctor` 报告 API 版本、支持的操作和本机工具可用性。命令输出 JSON，自动化应同时检查退出码和结果状态；长任务的启动成功表示已排队，随后用 `task status` 查看终态。

将 `skills/` 中所需的完整目录导入支持 Agent Skills 的客户端，包括各自的 `references/` 和 `assets/`。从 `svtools-agent` 开始，再按任务使用 `svtools-design`、`svtools-delivery`、`svtools-vivado` 或 `svtools-waveform`。把解压位置和目标 RTL 工作区告诉客户端。

- [命令与 JSON 合同](https://github.com/JayceVane/SV-Tools/blob/v4.2.0/docs/CLI.md)
- [架构计划、模块交接与设计进展](https://github.com/JayceVane/SV-Tools/blob/v4.2.0/docs/DESIGN_WORKFLOW.md)
- [波形和布局](https://github.com/JayceVane/SV-Tools/blob/v4.2.0/docs/WAVEFORM.md)
- [项目与反馈](https://github.com/JayceVane/SV-Tools)

`RELEASE.json` 记录版本、源码提交和对应 VSIX 的 SHA256。下载后可用同一 Release 的 `SHA256SUMS.txt` 核对 ZIP。许可见 `LICENSE.txt`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 和 `bin/vendor/`。
