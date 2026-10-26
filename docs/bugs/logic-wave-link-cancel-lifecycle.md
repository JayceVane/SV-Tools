# logic-wave-link-cancel-lifecycle

> **发现方式**：M4协议接入时，既有真实Worker生命周期回归失败。
> **修复位置**：`src/waveform/host.js` / `handleMessage`。

## 症状

```text
真实 worker 打开过程中取消后再关闭：加载完成 promise 结束且不遗留线程
AssertionError: 1 !== 0
```

取消后仍向页面发送了一条加载消息。新关联模块本身的纯测试通过，问题由原波形生命周期合同发现。

## 排查和根因

新增协议层曾对所有消息先执行 `await circuitLink.receive(message)`，再判断原有 cancel/close/query。
即使普通消息不属于关联协议，async函数仍返回Promise，导致控制权先交还消息队列。
原本在当前轮立即设置的 cancelled 标记延后，使Worker的进度消息可能先于取消生效。

## 修复

先按明确消息类型分派，仅对 `link-revealed`、`circuit-link`、`circuit-trace` 等关联动作等待。
既有取消路径保持原来的立即置位和释放顺序。原Worker取消、关闭及加载完成Promise回归恢复通过。

## 教训

协议层插入一个看似空操作的await也会改变生命周期时序。取消、关闭和版本置位的先后关系应由原有
数据服务拥有；新增业务只处理自己的消息，避免在通用路径前引入异步让出点。
