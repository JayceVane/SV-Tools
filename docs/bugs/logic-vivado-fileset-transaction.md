# logic-vivado-fileset-transaction

> **发现方式**：4.0发布审查，磁盘文件被外部移走后的跨文件集移动。
> **定位耗时**：本轮集中排查。
> **修复位置**：vivado/tclgen与projectTree。

## 症状与根因

旧XPR仍引用sample.sv，磁盘文件已不在。移动先remove_files，再add_files；后一步失败。
错误收尾调用close_project，反而把已删除的源引用写回，两个文件集都没有该文件。
不能通过Tcl非零退出码推断工程没有发生部分修改。

## 排查与修复

先用真实Vivado创建最小工程并移走磁盘文件，证明失败后的XPR确实丢引用。
面板入口现在先验证普通文件。Tcl也验证源引用、两个文件集及目标，先加入并校验目标，再移除源。
保存FILE_TYPE/LIBRARY/USED_IN/IS_GLOBAL_INCLUDE实际存在的属性；后续失败恢复源引用和属性，并移除本次新增目标。
回滚自身也失败时明确报告部分恢复结果，不误报成功，也不删除仍可保留的引用。
生成的错误协议用ASCII，避免Windows默认代码页把中文字串的Tcl闭括号吞掉。

## 验证与教训

真实Vivado验证缺失文件保留源引用、正常移动成功；在remove后注入 `AUDIT_FAILURE_AFTER_REMOVE`，结果为：
`SVTOOLS_TCL_ERROR Move failed; original membership restored: AUDIT_FAILURE_AFTER_REMOVE`。
重新打开XPR确认源在、目标不在，`LIBRARY audit_lib` 与 `USED_IN synthesis simulation` 已恢复。
工程写操作必须验证失败后的持久状态，而不只是进程退出码；不承诺对进程崩溃或断电提供完整事务恢复。
