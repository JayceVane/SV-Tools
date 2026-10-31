# Icarus 快照中的 include 路径

状态：已修复，并以真实 Icarus 回归验证。

Windows 上使用 Cygwin 构建的 Icarus 时，命令行中的 Windows 源文件路径可以被工具读取，但将同类 `C:/...` 路径写入源码的 `` `include "..." `` 后，预处理器可能报告 `Include file ... not found`。本次在含空格和中文的隔离工程中复现：文件实际存在，主文件已成功编译，依赖文件在 include 阶段失败。

命令行参数和源码中字符串路径经过不同的读取入口，不能假定 Windows 参数路径兼容性也适用于 include。M1 将已收录的字面量 include 指向本轮源码快照，并写成相对于快照根目录的路径；编译进程以该根目录为 cwd。未收录的字面量指向快照内的缺失位置，由编译器判断当前条件分支是否需要它；宏 include 暂明确拒绝。工具仍在快照内读取源码，诊断路径映射回原文件。

回归见 `test/agent_service_test.js` 的真实 Icarus 依赖/头文件场景：中文和空格路径中，依赖补入与 include 编译成功；依赖语法错误指向原文件正确行号。`node --test test/agent_service_test.js` 在有 Icarus 的环境运行这些集成检查，未安装时明确跳过。
