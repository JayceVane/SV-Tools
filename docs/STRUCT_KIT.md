# SV Tools Windows x64 基础工具包

将 ZIP 解压到任意可写目录。`svtools-struct.exe` 内含结构前端、Node 运行时、原生解析器和 SVG 布局。第一次运行会在当前用户的临时目录缓存并校验内置的原生解析器。`svtools-format.exe` 用于 Verilog/SystemVerilog 格式化。两个命令均可从 PowerShell 或其他终端运行。

```powershell
.\svtools-struct.exe --version
.\svtools-struct.exe --help
.\svtools-format.exe --help
```

| 命令 | 作用 |
| --- | --- |
| `parse` | 列出模块、参数、接口、modport、typedef 和实例。 |
| `arch` | 建立顶层结构，含端口、连接和空模块状态。可保存快照。 |
| `check` | 定位可解析的结构问题，如悬空输入、接口类型和 modport 不匹配。 |
| `render` | 导出 SVG。 |
| `lower` | 将 `...` 转为 TODO 注释，在工程内另存实现桩。 |
| `diff` | 对比快照，区分端口、实例和补实现的变化。 |

可以先跑 [四路采集与报文汇聚样例](../example/struct-packet-hub/README.md)。架构图表达的是源级连接。功能正确性、时序、复杂宏和条件展开仍需对应的验证工具。

`BUILD.json` 记录了包内两个 EXE 的 SHA-256 和运行时版本。仓库本地构建入口为 `npm run package:basic`，构建前需有 `bin/` 中的原生产物和 ELK 资源。包内附许可证与第三方声明。
