# 4.0 后续计划

更新日期：2026-10-14。

## 当前优先级

用户已确认：先完善当前版本，再增加新功能。当前以 `4.0.0-alpha6` 为基线，优先处理实际使用反馈、缺陷、交互和性能问题，保持格式化、补全、工具链、工程面板及波形查看器的回归验收。

Vivado IP 管理列为后续功能，尚未开发、不纳入当前版本的完善范围。待用户认为当前版本已基本完善并决定启动新功能时，再安排实现；不预设版本号或日期。

## 后续功能：Vivado IP 管理

目标：在 Xilinx 工程管理面板增加 IP 分组，插件提供操作界面，本机 Vivado 执行目录查询、创建、配置和产物生成。

计划范围：

1. **新建 IP**：搜索本机 IP Catalog，选择版本、模块名、保存位置和参数，加入当前选定工程。
2. **添加已有 IP**：选择 `.xci`，区分引用原文件与复制进工程。
3. **自定义仓库**：维护 IP 仓库目录，刷新 Catalog。
4. **已有 IP 管理**：查看配置和状态、重新生成仿真/综合产物、执行 OOC 综合、插入例化模板；升级作为独立操作。
5. **配置界面**：FIFO、BRAM、Clock Wizard、ILA 等常用 IP 优先采用专用表单；其他 IP 提供通用参数编辑，并保留在 Vivado 中配置的入口。复杂 IP 的专有图形配置不承诺在插件中完整复刻。

实现约束：

- 复用现有工程选择、Vivado 任务生命周期、取消、日志和面板刷新，保持操作所属工程一致。
- 从真实 Vivado 获取目录与属性，按工具版本、器件和仓库缓存，不维护固定 IP 名单或假参数校验。
- 添加独立 IP 业务模块，避免将目录、参数配置和生成逻辑堆入工程树或通用 Tcl 模块。
- 功能完成后使用隔离的真实 Vivado 工程验收创建、导入、配置、生成、取消和刷新，再检查例化及仿真/综合产物。

官方技术依据：

- [create_ip：从 IP Catalog 创建 IP](https://docs.amd.com/r/2022.1-English/ug835-vivado-tcl-commands/create_ip)
- [已有 IP 的引用与导入](https://docs.amd.com/r/2022.2-English/ug895-vivado-system-level-design-entry/Tcl-Commands-for-Adding-Existing-IP-Sources)
- [IP 参数配置](https://docs.amd.com/r/2021.2-English/ug896-vivado-ip/Creating-an-IP-Customization)
- [generate_target：生成 IP 产物](https://docs.amd.com/r/2022.1-English/ug835-vivado-tcl-commands/generate_target)

各条目是待实现计划，不表示当前插件已提供这些入口。FSDB 保持此前取消的决定。
