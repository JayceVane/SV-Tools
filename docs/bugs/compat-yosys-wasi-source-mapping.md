# compat-yosys-wasi-source-mapping

> **发现方式**：内置 builtin 通过，Slang 对同一未保存正文生成成功但源码定位回归失败。
> **修复位置**：`src/circuit/yosys-runner.js`、`worker.js`、`yosys-bundled.js`。

## 症状

编译、存储器初始化和 JSON 输出均成功，但定位指向工作区下不存在的 `source0/top.sv`。真实 Slang JSON 的 src 为：

```text
source0/top.sv:2.8
```

builtin 则保留 `/source0/top.sv`。同一个文件在两个前端中使用了不同形式的 guest 路径。

## 排查过程

1. 先核对编译日志，确认 CHECK 与 JSON backend 已完成，排除 WASM 没有运行或 readmem 文件丢失。
2. 新回归的失败清理曾等待未 finish 的任务，掩盖了原始断言；改为无论成败都结束本测试拥有的 task，立即暴露路径断言。
3. 直接查看原始 JSON 属性发现相对 guest 路径。适配器先把它锚定到 Windows 工作区，后续根目录映射又把这个宿主路径当 guest 路径，造成重复前缀。

## 根因

guest 文件系统路径和宿主路径不能在适配器前混用。未保存正文又多一层任务快照：目录回映射成功后还要再次应用快照→原文件映射，不能二者只取其一。

## 修复

内置生成结果声明 sourceRoot 为 guest 根 `/`，原生外部工具仍用真实工作区根。Worker 先按具体 guest 目录还原宿主路径，再应用精确快照映射；具体目录优先于 guest 根。领域模型只接收最终真实位置，不承担 WASI 方言。

## 验收与教训

- 两个真实前端都在 PATH 为空、源/输出目录含空格与中文、源文件位于工作区外的场景下验证；模块位置必须回到原文件，磁盘正文保持不变。
- 使用相对 readmem 文件验证工作目录语义，不能只以编译退出码为成功标准。
- 测试夹具也必须遵守工具任务生命周期，否则清理等待会把普通断言失败误呈现为编译器挂起。
