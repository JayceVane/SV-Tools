# 四路采集与报文汇聚

`packet_hub` 采集四路 16 位样本。每路完成使能控制和报文封装，通过仲裁器进入同一个 FIFO。路由器根据控制字把报文送往遥测或采集出口。丢包与高水位汇总到 `alert`，第一路还接有一个读侧观察模块。

| 路径 | 需要核对的约定 |
| --- | --- |
| 采集 → 封包 | `sample_link` 含 16 位样本、valid 和反向 ready。`tap` 只观察。 |
| 仲裁 → FIFO → 路由 | `packet_link` 含 32 位荷载、2 位通道号、last、valid 和反向 ready，共 37 位。 |
| 控制 → 封包、路由 | 四路独立使能，另有一位出口选择。 |
| FIFO、封包 → 告警 | 高水位与各路丢包标记并入 `alert`。 |

顶层有 10 个实例。其中 9 个以 `...` 表示待实现，`u_status` 已给出组合逻辑。`status_merge` 的空告警行为可直接看源码。FIFO 深度参数为 32，仲裁公平性、FIFO 满时回压和路由切换的帧边界语义仍属于后续实现与仿真验收。

`adc0` 在顶层保留完整接口。封包实例使用 `sink` 视图，监测实例使用 `tap` 视图。若在顶层先将 `adc0` 限定为 `sink`，再把它接给需要 `tap` 的实例，Questa 展开和 `svtools-struct check` 都会指出 modport 不匹配。

## 复跑

在工具包根目录运行以下命令。

```powershell
$demo = '.\example\struct-packet-hub'
.\svtools-struct.exe parse --workspace $demo
.\svtools-struct.exe arch --workspace $demo --top packet_hub --save baseline
.\svtools-struct.exe check --workspace $demo --top packet_hub
.\svtools-struct.exe render --workspace $demo --top packet_hub --out diagrams
.\svtools-struct.exe lower --workspace $demo
```

基准检查应为 `clean`。在副本里将 `u_fifo` 的 `.clk(clk)` 改为 `.clk()`，应得到 `UNDRIVEN_INPUT`。将 `u_monitor` 的 `.watched(adc0)` 改为 `.watched(telemetry)`，应得到 `ARCH_INTERFACE_TYPE`。把 `adc0` 改为 `sample_link.sink`，应得到 `ARCH_MODPORT_MISMATCH`。还原后给 `packet_fifo` 加入实际 RTL 语句，再用 `diff --workspace $demo --top packet_hub --baseline baseline` 查看 `u_fifo` 的骨架状态变化。

图上接口束按共享连接呈现。成员方向可在 `parse` 的 `modports` 数据里核对。
