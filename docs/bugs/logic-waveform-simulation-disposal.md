# logic-waveform-simulation-disposal

> **发现方式**：用户要求VCD默认进入波形页，且仿真写入前关闭对应旧波形。
> **定位耗时**：约半小时。
> **修复位置**：waveform/index、host、session、registry，以及iverilog-runner的写入边界。

## 症状与根因

清单的customEditors.priority原为option，正常点击VCD仍由默认文本编辑器打开。
原关闭路径只调用session.dispose而不返回退出Promise；重复dispose又直接返回undefined。
因此调用方即使关了面板，也不能等待旧读线程真正退出。正在加载大文件时，vvp可能在旧读取结束前写入。
完成流式加载后通常已无VCD读句柄，不能把所有文件锁错误都归因于常驻worker。

## 排查过程

1. 先添加默认关联和异步释放屏障回归，旧实现两项均失败。
2. worker的terminate本身返回Promise，问题在host丢弃返回值和重复关闭不返回原Promise。
3. 仿真由runner启动vvp，之前只有事后发现并打开文件，没有事前关闭边界。
4. 单纯关闭Map中的面板仍会漏掉用户刚关闭但worker尚未退出的会话，注册表需要追踪closing集合。
5. 真实Qoder验证确认CustomEditor标签可关闭；补齐文本标签路径，保留原生关闭取消语义。

## 修复

默认关联使用default。host/session缓存释放Promise，registry保留活动/退出中的绑定与写入租约。
runner编译成功后发现输出路径，关闭目标视图并等待资源释放；租约阻止写入期间新建波形读会话。
取消、超时、失败均在finally撤销租约；编译失败不关闭旧波形，关闭失败不启动vvp。
磁盘源码路径发现复用词法扫描、支持字面include和cwd相对路径；无法静态确定时明确采用目录回退。

## 验证与边界

合同覆盖释放等待、用户先关闭、重开保护、相邻工程保留、取消、失败和超时。
真实Qoder使用普通vscode.open，检查CustomEditor类型；真实Icarus在子目录重写VCD并自动载入。
还覆盖文本方式打开和约100MiB旧文件加载期间的重新仿真，旧文件被262字节的新数据取代。
外部查看器进程不由插件关闭；用户显式编辑器关联保持原设置。

## 教训

- UI关闭是事件，文件资源释放是异步完成条件，二者不能混用。
- 运行前检查和运行后打开应共享同一文件身份，并通过finally保证取消路径也恢复状态。
