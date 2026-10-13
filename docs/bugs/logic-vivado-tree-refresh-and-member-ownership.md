# logic-vivado-tree-refresh-and-member-ownership

> **发现方式**：用户报告工程管理面板无内容，随后合同与独立代码复核。
> **修复位置**：`src/vivado/projectTree.js`、`projects.js`、`tree-model.js`、`index.js`。

## 症状

面板首次读到空 roots 后，即使异步构建完成仍无内容，点刷新也不能可靠更新。旧版真实
生产代码的回归失败为：

```text
Expected values to be strictly equal:
+ actual - expected
+ 'undefined'
- 'function'
```

对应 `provider.onDidChangeTreeData` 缺失。另有右键未加入文件再次要求选文件、并发命令
写同一个 Tcl、仿真引用被当作成员，以及 GUI 改集后旧节点回退到另一文件集的风险。

## 排查与根因

先读取视图注册与 provider，发现刷新仅赋值 roots 和 tree.message；后者不通知 VS Code
重新读取子节点。锁定首次空读取的失败合同，补事件和 getParent 后再验证节点稳定身份。
刷新必须通过 [VS Code Tree View 数据事件](https://code.visualstudio.com/api/extension-guides/tree-view)
通知；当前要求的 VS Code 1.74+ 自动激活视图，缺少 onView 声明不是此次根因。

继续沿命令参数与数据归属检查：右键携带 nodeData.file，旧代码却读 nodeArg.file；工程
发现总取列表第一项，层级使用全工作区单元，文件集按目录推断。generation 只能防一部分
迟到 UI 更新，无法保证脚本或工程成员的所有权。真实 GUI 可在 QuickPick 期间改变文件集，
因此旧节点的 fileset 缺失后必须拒绝，不能回退到 fileSetOf 的另一集。

## 修复与验证

工程选择共用一个服务；模型只读取 XPR 成员并按单元原文区间建立有界引用预览。视图
提交最新快照、发送树事件，节点有稳定 ID/父节点，关闭后不发布迟到结果。源码只读
预览与实际集成员区分，引用节点不承担成员删除/移动。

面板与编辑器入口共用忙碌状态，动作脚本/报告使用独立目录；执行前核对工程及成员，
写后按 XPR 事实验收。xelab 保留真实 top 与选中集范围，停止按阶段路由；浏览对话框
迟到返回也检查取消。普通相对路径、实体和完整 XML 校验统一到 XPR 读取入口。

回归覆盖旧节点成员迁移、选集期间删除目标集、多仿真集范围、引用身份、节点硬预算、
选择竞态和停止。真实 VS Code 宿主验证首次加载/刷新/展开/切换/错误与恢复；真实 Vivado
验证成员管理、指定非首模块的 xelab 和 sim_custom 的 xsim 运行。报告见 `../V4_ALPHA5.md`。

## 取舍

源码层级是引用预览，宏/generate/IP 的真实层级由 Vivado 详细化决定。预览预算不删去
实际文件清单；大型或冲突源码保留提示，避免把不完整预览当作完整工程事实。工作区外
工程可显式选择，外部 GUI 改动可手动刷新，不依赖全工作区索引来补齐其成员。
