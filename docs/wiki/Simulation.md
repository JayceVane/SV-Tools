# Icarus、Lint 与仿真

## 配置工具

```json
{
  "svtools.iverilog.path": "C:/EDA/iverilog/bin",
  "svtools.lint.engine": "iverilog",
  "svtools.iverilog.standard": "auto",
  "svtools.iverilog.includePaths": ["include"],
  "svtools.iverilog.libraryPaths": [],
  "svtools.iverilog.scanWorkspace": true,
  "svtools.iverilog.autoOpenWaveform": true
}
```

`iverilog.path` 可填 bin 目录或可执行文件完整路径；留空尝试自动发现。使用依赖 Cygwin 的构建时，将 `svtools.iverilog.cygwinPath` 指向包含 `cygwin1.dll` 的 bin 目录。

## 语法检查

默认在打开、修改和保存时检查；修改检查采用防抖。Problems 面板显示当前文件和依赖的诊断，输出通道提供任务日志。

```json
{
  "svtools.iverilog.lintOnOpen": true,
  "svtools.iverilog.lintOnChange": true,
  "svtools.iverilog.lintOnSave": true,
  "svtools.iverilog.lintDebounceMs": 800,
  "svtools.iverilog.lintArgs": ["-Wall"]
}
```

可执行 **Lint：选择引擎（iverilog / xvlog）**。选择 xvlog 需要配置 Vivado；**xelab 详细化检查**另行验证设计单元与依赖，不等同于只做语法检查。补全语言版本与编译器标准互相独立。

## 运行仿真

1. 保存测试台及其依赖，保持测试台为当前编辑文件。
2. 执行 **仿真…** 选择引擎，或直接执行 **Icarus Verilog: 运行仿真**。
3. 查看编译/运行输出；需要中断时执行 **Icarus Verilog: 停止仿真**。
4. 成功生成新 VCD 后默认打开内置查看器。

复杂工程可用 `svtools.iverilog.simFiles` 提供仿真源文件、`simTop` 指定 Top、`simArgs` 设置 vvp 运行参数。`includePaths` 是头文件搜索目录，不代表源文件已编译；`libraryPaths` 与工作区扫描用于库单元查找。完整默认值见[配置参考](https://github.com/JayceVane/SV-Tools/wiki/Configuration)。

仿真在当前源码目录运行，相对 `$readmemh` / `$dumpfile` 以该目录为准。未保存内容的 lint 可以检查快照；仿真使用磁盘内容，因此应先保存。运行超时可用 `svtools.iverilog.simTimeoutMs` 设置，默认 `0` 不限时。

开发构建的默认VCD输出集中在 `<工作区>/.svtools/vcd/`，没有工作区时以源码目录为根。文件名区分源文件和Top，重复仿真使用稳定路径；目录自动创建，仿真cwd仍为源码目录。RTL的显式`$dumpfile(...)`优先于默认路径，`simArgs`中的`-dumpfile=...`也保留原值；原有测试台不会被改写。选择FST/LXT等格式时保留其原有输出规则。

## 重新仿真与旧 VCD

编译成功、启动 vvp 前，插件关闭本次可能写入的旧 VCD 波形页和文本标签，并等待读取 worker 退出。写入期间暂时禁止重开相关波形，完成后读取新数据。编译失败保留旧视图；无法关闭标签时不会开始写入。

宏/动态路径无法静态确定时，会提示并保守处理当前仿真目录下的旧视图。外部波形工具的进程不在此关闭机制内。仿真失败留下的部分文件可手动排查，但不作为成功结果自动打开。

## 日志与依赖问题

任务日志通常位于 `<工作区>/.svtools/tasks/`，每个阶段独立保存。优先看第一条具体语法、缺少 module/package、include 或参数错误，保留完整日志供排查。日志与产物会累积，目前没有自动保留期。

[详细任务边界与资源预算](https://github.com/JayceVane/SV-Tools/blob/v4.0.0/docs/TOOLCHAINS.md)
