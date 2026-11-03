# 波形加载进度：wellen 拿不到字节级进度，只报阶段

## 现象

JS 版 worker 是流式读文件，每 64 KiB 报一次 `progress.loading`（带真实 `bytesRead`），
每 200 ms 节流发一次。改到 Rust/wellen 后 `waveOpen` 是一次同步调用，期间没有任何进度，
`bytesRead` 只能写死 0 或 stat.size。

## 排除了哪些看起来可行的方案

| 方案 | 为什么不行 |
| --- | --- |
| `viewers::read_body(..., Some(progress_count))` | 能拿到真实字节进度，但 `BodyResult` 拼不回可查询句柄——`simple::Waveform::new` 是私有的。要拿到句柄得再调一次 `simple::read`，等于解析两遍。 |
| 用 `stream` 接口逐事件回调估算 | 事件回调的密度与字节位置没有稳定映射；且 stream 是一次性消费，不能同时留下句柄。 |
| 按已用时间线性插值成「字节数」 | **这是伪造数据**。进度条会匀速爬到 100%，遇到大文件末尾卡住时反而比没有进度更误导。已明确否决。 |
| fork wellen 暴露 `ProgressCount` + `Waveform` 构造 | 只为进度条维护一个 fork 不划算；而且 `simple::read` 的上游是好设计（header/body 分离），改它属于自找维护负担。 |

## 结论

只报**阶段**（`loading` / `ready` / `source-roles`），`loading` 期间 `bytesRead` 固定为 0。
代价可接受：Rust 冷解析实测比原 JS 流式实现快 16–26 倍（500 MiB：353 ms vs 5663 ms），
`loading` 阶段通常一瞬间就过，用户看不到进度条空白。

## 取消语义

`waveOpen` 是同步的，解析期间 worker 的事件循环被占满，`cancel` 消息收不到。
但取消仍然有效——它发生在**下一阶段边界**：

1. host 收到 `cancel` → `session.dispose()` → `worker.terminate()`；
2. 同步的 `waveOpen` 随 worker 一起被杀掉，不会留下僵尸解析；
3. `session.request` 的 pending promise 在 dispose 时统一 reject，
   已发出的 `progress` 消息因 `this.disposed` 被丢弃。

因此「取消后不再发 ready」由 session 层保证，worker 不需要自己检查取消标志。

## 复发预防

- 不要为了「让进度条动起来」引入任何基于时间或事件的估算值；
- 若将来真的需要字节级进度，正路是给 wellen 提 PR，让 `simple::read_with_progress`
  接受 `Option<ProgressCount>`（改动量极小，且不影响既有 API），而不是 fork。
