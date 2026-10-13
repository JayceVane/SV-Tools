# logic-toolchain-false-success-and-shared-artifacts

> **发现方式**：工具链代码审查与真实 Vivado/Icarus 验证。
> **定位范围**：本轮 alpha4 工具链改造。
> **修复位置**：`src/toolchains/result.js`、`job.js`、`xvlog-runner.js`、`src/vivado/batch.js`。

## 症状

旧 xvlog 的成功判断只计主文件错误，工具准备失败也返回成功对象。真实验收的依赖错误
结果为 `errorCount: 0`、`totalErrorCount: 3`；主文件没有错误不能说明整个编译通过。
真实 Vivado 脚本产生下列日志后退出 0：

```text
ERROR: intentional validation failure
INFO: [Common 17-206] Exiting Vivado at Tue Oct 13 16:55:19 2026...
```

并发检查还会写入固定 `.svtools/xvlog/svtools.prj`、共享 xsim.dir 和同名临时源码；
旧任务的清理和迟到诊断会干扰新任务。

## 排查过程

从旧 `summarize` 与准备失败返回值直接定位，随后分别构造依赖错误、未识别的非零
退出、工具无法启动、超时和代码 0 含 ERROR 的合同，避免把解析成功当成工具成功。
协议进程验证取消与覆盖边界，真实 Icarus、xvlog/xelab 与 Vivado 补充厂商行为证据。
给内存摘要加上限后，进一步验证早期错误和项目标记在大量输出后仍然存在；仅在结束
时解析尾部会丢失这些信息，因此解析改为逐行捕获，日志持续写盘。

## 根因

诊断视角、进程退出和任务成败被混成一个布尔值；任务缺少独立身份和产物所有权。
只记录 generation 能挡住一部分迟到更新，不能阻止旧进程写共享目录或删除新临时文件。

## 修复

旧判断的实际代码：

```js
return { ok: errorCount === 0, errorCount, warningCount: main.length - errorCount };
```

新的成功合同同时要求进程正常退出、全任务零错误和完整诊断；取消与跳过单独表达。
任务拥有 AbortSignal、阶段进程和 mkdtemp 目录，替换前等待旧任务结束；清理保留日志
并校验路径只属于本次目录。Problems 按触发文档归属合并，避免修复一个文档抹掉其它
检查仍持有的依赖错误。Vivado 保留原退出码并为旧调用者提供失败兼容 code。

取舍是 xvlog 跨任务增量缓存暂不共享，日志和仿真产物保留后占用磁盘。未来缓存需要
源码/配置键和只读复用合同；不能为启动速度恢复共享可写目录。

## 教训

1. “当前文件零错误”与“工程检查通过”是不同事实，应分别表示。
2. 取消必须覆盖准备和编译，产物与清理必须归属于单次任务。
3. 有界摘要用于展示；错误、依赖和项目标记需流式提取，完整日志用于复查。
