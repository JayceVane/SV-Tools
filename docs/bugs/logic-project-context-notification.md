# logic-project-context-notification

> **发现方式**：隔离 VS Code 工程管理端到端验收
> **定位耗时**：约10分钟
> **修复位置**：`src/project/flow-controller.js` / `projectChanged`，`src/project/index.js` / 工程变更监听
> **修复提交**：`148d9f0`

## 症状

新建工程、添加文件、设置顶层后立即追踪信号，没有结果却没有工具报错。验收日志：

```text
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  assert.ok(snapshot.flow)
at Object.run (test/vscode_project_host.js:25:12)
```

## 排查过程

纯模型和真实 Yosys 的多层位映射测试通过，因此先排除端口别名、模块解析和Worker查询。
真实宿主中的追踪返回了空结果，而非工具失败；查到任务已被取消，生成前后的文件事件仍在延迟队列中。
原实现将每次工程变化通知都视为上下文变化。自身创建配置引发的重复事件在分析启动后送达，清空了同一工程的Worker。

## 根因

通知只说明可能需要重新读取事实，不能证明事实发生改变。配置原子写入及目录监听会产生多次、延迟的通知，通知时序与分析启动时序不同。按通知次数无条件清空会误伤刚捕获的同一份上下文。

## 修复

追踪启动时记录工程ID与成员／配置指纹。变更通知重新读取工程快照，只有ID或指纹不同才取消：

```js
if (activeContext && (current?.id !== activeContext.id || current.key !== activeContext.key)) {
    clear('工程上下文已变化，重新追踪后显示标记');
}
```

正文变化继续由独立的源码快照观察器处理。配置损坏、删除或工程切换仍清空结果和旧节点。
VS Code 与 Qoder 宿主均覆盖“同指纹通知保留结果”和“正文修改撤销结果”。

## 教训

- 将事实身份与通知频率分开；把通知当成复核入口。
- 单元测试不足以重现文件系统和编辑器事件的交错，需要真实宿主回归。
- 相关旧陷阱见 `logic-circuit-refresh-source-stale.md`，但本例是同上下文重复通知，不是旧源码观察器交接。
