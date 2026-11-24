# Vivado IP 与 Block Design CLI

通过 `--project <xpr>` 选择工程，通过 `--vivado` 或 CLI 配置选择匹配的工具。运行和报告查询见[工程与运行 CLI](runs.md)。

这组命令的 `data.source` 为 `project`。路径可相对 `--workspace`，修改类命令作用于选中的原工程。已知 XPR 创建版本与 Vivado 安装不一致时，资产命令在打开工程前退出。

| 命令 | 输入与结果 |
| --- | --- |
| `vivado ip catalog [--query <text>]` | 查询当前器件可用的 IP 定义，返回完整 VLNV、名称、描述和分类，可用 `--offset/--limit` 分页。 |
| `vivado ip list [--query <text>]` / `vivado ip repositories` | 分别列出项目的 IP 文件和 IP 仓库。 |
| `vivado ip inspect --file <xci/xcix>` | 查询运行时参数、候选值、锁定状态和目标。IP 包提供的参数标签与说明会一并返回。 |
| `vivado ip create --name <name> --vlnv <vlnv>` / `vivado ip import --file <xci/xcix> [--copy]` | 分别实例化 IP 和加入现有 IP。导入默认引用原文件，`--copy` 复制到工程。 |
| `vivado ip configure --file <xci/xcix> --spec <json/文件>` | JSON 数组形如 `[{"key":"CONFIG.CONST_WIDTH","before":"1","value":"4"}]`。Vivado 在写入前核对每项旧值，返回重读的真实参数。 |
| `vivado ip generate/template/upgrade/synthesize --file <xci/xcix>` | 生成产物、例化模板、升级 IP 或执行 OOC 综合。`generate --target` 接受 `all/synthesis/simulation/instantiation_template/example_design/changelog`。`template --language` 接受 `verilog/vhdl`，文件路径由 `artifacts` 返回。 |
| `vivado bd list` / `vivado bd inspect --file <bd>` | 列出工程里的 BD 文件，或读取指定 BD 的层级实例、端点、网络、地址空间与 `stamp`。 |
| `vivado bd create --name <name>` / `vivado bd import --file <bd>` | 新建 BD 或引用现有 BD。 |
| `vivado bd edit --file <bd> --expect <stamp> --spec <json/文件>` | 应用一次编辑，返回最新结构和 `stamp`。 |
| `vivado bd validate/generate/wrapper/export --file <bd>` | 验证设计、生成输出、导入 HDL wrapper 或导出重建 Tcl。`validate` 需要 Vivado 可写会话来推导接口参数，验证命令不保存设计。 |

`bd edit` 规格示例

```json
{"action":"add-cell","type":"ip","reference":"xilinx.com:ip:xlconstant:1.1","name":"fixed_value"}
```

其他动作使用 `bd inspect` 返回的实际 ID。

- `add-cell` 的 `type` 可为 `ip/module/hier`，可用 `parent` 指定层级实例。普通端口用 `add-port`，字段为 `name/direction/width/type`，方向可为 `I/O/IO`，类型可为 `data/clk/rst`。接口端口用 `add-interface-port`，字段为 `name/mode/vlnv`。
- `connect` 使用 `from/to` 端点对象，可用 `level` 指定层级。端点包含 `kind/id`，`kind` 为 `pin/port/interface_pin/interface_port`。`disconnect` 使用 `net/endpoint`，网络对象包含 `kind/id`。用 `externalize` 引出 `endpoint`。
- `configure-cell` 使用 `id/changes`，`configure-port` 使用 `endpoint/changes`。配置项字段与 `ip configure` 一致。
- `assign-addresses` 自动分配。用 `map-address` 指定 `space/segment/offset/range`，用 `set-address` 指定 `id/offset/range`。地址和范围采用 `0x` 前缀。

命令报告退出失败时，先读诊断和最新资产状态。IP 的旧值变化或 BD 的 `stamp` 不匹配后，重新读取并按实际状态重新决策。

工程写操作：

- `project create --name <n> [--dir <d>] [--part <p>] [--top <t>] [--sim-top <t>]`：同名工程已存在时打开而非重建，返回 `created` 布尔与工程身份；
- `project add --source <file> [--source <file>...] [--target-fileset sources_1|constrs_1|sim_1]`：按扩展名推断目标文件集（`.xdc` → `constrs_1`，其余 `sources_1`），返回 `added`/`already` 绝对路径列表；文件不存在报 `SOURCE_NOT_FOUND`；
- `project set-top [--top <t>] [--sim-top <t>]`：分别写入 `sources_1`/`sim_1` 顶层，返回 `applied`。

三者返回的 `context` 是写操作完成后的重新解析结果，可直接作为后续命令的版本依据。
