# logic-generated-sources-lint

> **发现方式**：用户提供32条突然出现的Problems诊断。
> **定位耗时**：本轮会话。
> **修复位置**：workspace/source-policy.js、editor/language.js、completion/index.js、iverilog-controller.js、xvlog-runner.js。

## 症状

32条错误均来自26个`.svtools/circuit`临时文件，owner为`svtools-iverilog`，source为`xvlog`，包括：

- `[VRFC 10-3195] cannot open include file '/source0/top.sv'`
- `[VRFC 10-3195] cannot open include file 'width.vh'`
- `[VRFC 10-3805] use of undefined macro 'CIRCUIT_WIDTH'`

其中30条include缺失，2条来自独立验证夹具的宏与语法级联。

## 排查过程

- 先统计资源路径，确认全部指向任务快照，而非用户RTL目录。
- 工作区索引和补全的findFiles已有排除glob，但旧定义检索只排除node_modules，并会openTextDocument；该内部打开事件同样触发自动lint。
- 控制器的启动、保存、编辑及配置变化路径仅判断HDL语言，没有直接路径排除；直接xvlog入口也一样。已打开的生成文件还能通过补全缓存路径绕过glob。
- 补充事件链回归，旧实现失败；统一路径判定后，生成文档不探测工具、不开编译任务，旧误报被清空。
- 用同一真实协议子进程同时发出快照和正常RTL错误，确认只过滤内部资源，正常诊断保留，任务仍为failed且原错误计数不改。

## 根因

文件发现的排除glob并不约束文档事件或内部API。Yosys包装文件中的/source0只在WASM虚拟文件系统有效，验证夹具的宏/include也只属于其任务上下文。外部xvlog直接检查这些文件自然报错，插件又将其发布到了用户Problems集合。

## 修复

同一目录表生成glob与直接路径谓词，按完整目录段、大小写及两种分隔符归一化匹配。定义检索过滤候选，补全过滤发现与已打开缓存；自动/手动控制器及直接xvlog入口跳过生成文档，诊断发布过滤内部路径并清理旧记录。正常源码的跳转、解码、补全与lint行为保留。

工具为真实源创建的内部编译快照仍可使用，跳过的是触发文档与误发布资源，不是在编译器边界粗暴删除所有临时文件。安装后重载窗口重建诊断集合；保留用户工程及任务日志。

## 教训

1. 同一数据可能通过发现、缓存与文档事件进入系统，过滤应覆盖各入口。
2. IDE内部openTextDocument也有事件副作用。
3. 过滤展示噪声不能改写任务失败状态或抹掉真实源码错误。

索引排除范围与工具生成目录分别由同一目录表派生。自动lint和诊断仅跳过.svtools/.Xil；显式node_modules等依赖源码仍可检查，真实错误正常显示。
