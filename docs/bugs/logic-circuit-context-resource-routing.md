# logic-circuit-context-resource-routing

> **发现方式**：用户在 RTL 编辑器右键查看电路，先报 JSON 解析错误，换生成入口后报缺工具。
> **修复位置**：`src/circuit/index.js`、`worker.js`、`yosys-runner.js` 与菜单配置。

## 症状

```text
Unexpected token '/', "// -------"... is not valid JSON
Yosys 电路生成失败：spawn yosys ENOENT
```

## 排查过程

1. 用户确认错误来自 RTL 右键。检查发现网表导入命令与 RTL 生成命令同时出现在 RTL 子菜单；VS Code 将当前资源 URI 传给命令，导入器把 `.sv` 直接交给 JSON.parse。
2. 用带 `// -------` 文件头的公开模块重现完全相同的错误，确认与注释编码、JSONC 或工具输出无关。
3. 改走 RTL 生成后出现 ENOENT，说明第一阶段路由已正确，第二阶段是系统没有名为 `yosys` 的命令。仅修改错误提示不能让默认功能运行。
4. 本机已有 YoWASP 的 Python 入口能用，exe 启动器失败；先复用现有安装验证完整流程，随后按用户要求改为内置 WASM，移除用户配置工具的前提。

## 根因

导入命令把“有资源 URI”等同于“选中了 JSON”，菜单又没有按资源类型分开。CLI 验证只覆盖生成链路，没有覆盖真实命令注册和当前资源参数，因此漏掉了用户最先遇到的路由错误。生成器同时假设 PATH 中已有 Yosys。

## 修复

JSON 导入入口移出 RTL 子菜单，JSON 编辑器有明确入口。兼容命令收到 RTL URI 时转入生成；导入非法正文时提示正确入口，不剥离注释来伪装成功。默认使用锁定、随 VSIX 离线分发的 Yosys WASM；显式外部路径仍受支持，ENOENT 给出设置项与日志。

编辑器标题栏的 Vivado 当前文件策略和工程面板的工程 top 策略另行注册，避免用同一个含混命令推断意图。

## 验收与教训

- 命令回归只模拟外部工具边界，实际执行注册函数、Webview ready、Worker 和 ELK；带文件头的 RTL 不再进入 JSON 解析。
- 内置工具回归清空子进程 PATH，真实验证 builtin/slang、宏、include、readmem 和未保存正文。
- 入口验收必须从用户点击时的资源参数开始；后端 CLI 成功不能证明编辑器接线正确。
