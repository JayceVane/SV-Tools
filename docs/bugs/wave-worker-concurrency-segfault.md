# 波形 worker 并发段错误：rayon 全局线程池（含一次错误归因的复盘）

## 现象

`npm test` 在默认并发（14 路）下，`waveform_memory_test.js` / `waveform_signal_test.js`
的测试进程以 `exitCode 3221225477`（`0xC0000005`，Windows 访问违例）退出；
`--test-concurrency=1`、`=4`、`=6` 全绿，`=14` 稳定失败。单独跑这两个文件也全绿。

CI（GitHub runner，2 核）同样复现这两处 `0xC0000005`，而本地 `=6` 全绿——
这个«本地绿、CI 红»的分裂是最后定位到根因的线索。

## 根因：wellen 有两条路径都会落到 rayon 全局线程池

本模块跑在 napi 里，既会被 Node `worker_threads` 调用，也会被多个测试进程同时加载。
rayon 的全局线程池与 napi 的线程模型叠加后触发访问违例。

### 路径一：VCD 体解析（已修）

`simple::read` 内部是 `read_with_options(..., &LoadOptions::default())`，
而 default 是 `multi_thread: true`。

修复：`parse_once` 显式传 `LoadOptions { multi_thread: false, .. }`。

### 路径二：信号按需装载（**最初漏掉的那一半**）

`WaveSession::load` 用了 `load_signals_multi_threaded`，其内部是
`ids.par_iter().zip(types.par_iter())`（wellen `wavemem.rs`）。

修复：改为单线程 `load_signals`。

只修路径一时，症状从「必崩」降为「概率崩」——压力脚本 5 轮崩 2 轮，
本机 `=6` 却能跑过。**两条路径都修完后**，`=14` 从必崩变为 875/875 全绿。

## 次生问题：`process.exit(0)` 不给 libuv 收尾留时间

即使两条 rayon 路径都关掉，关闭时序仍不稳。原握手用
「在途请求计数归零 → `process.exit(0)`」，但 `process.exit` 是**即时终止**，
不会等 libuv 线程池里的 Rust 任务走完析构。CI 的慢盘把「任务收尾在 exit 之后」
这个窗口放大到可稳定触发。

修复：不主动 `process.exit`，改为 postMessage 回执后 `parentPort.close()`，
让事件循环在最后一个在途 libuv 任务结束后**自然退出**。

配套的协议层设计（保留）：
1. 所有波形查询提供 `*_async` 版本（`bindings.rs` 的 `wave_async!` 宏批量生成），
   worker 一律走异步入口，不长时间持有 worker 线程；
2. `session.closeWorker()` 发 `{ method: 'close' }` 而非 `terminate()`，
   等 worker 回执 `{ type: 'closed' }`；
3. 关闭等待真实 `exit`；不按超时强杀仍有原生任务的 worker。取消加载时晚到的句柄在请求排空后释放，见 [波形查询与会话所有权](wave-query-ownership-and-contracts.md)。

## 复盘：一次归因错误

中途曾把「`=14` 仍失败」解释为**内存耗尽**，依据是本机 `FreePhysicalMemory`
只剩 1.9 GB / 32 GB，且 `--test-concurrency=6` 全绿。**这个结论是错的**：

- 反证：CI runner 内存充足，同样报 `0xC0000005`；
- 若真是 OOM，进程应被 OS 杀掉且通常不产生可归因的访问违例栈；
- 真正的差别是 **CI 单核慢 + 磁盘慢**，放大了「libuv 任务收尾晚于进程退出」的窗口。

教训：**「降低并发就全绿」不能证明是资源不足**——降低并发同样会缩小竞态窗口。
区分二者的判据是「同样的代码在另一台机器/CI 上是否复现」，而不是单机调并发度。

## 复发预防

- **不要**在 napi 模块里让第三方库的任何路径使用 rayon / 全局线程池。
  wellen 至少有两条（`LoadOptions.multi_thread`、`load_signals_multi_threaded`），
  升级依赖时要一并复查；
- **不要**用 `process.exit()` 结束持有在途 libuv 任务的进程，改为关端口让事件循环自然退出；
- **不要**用 `worker.terminate()` 关闭可能持有在途 napi 任务的 worker，改用计数握手；
- 遇到「并发才失败」的测试，先跨环境对照（本地低并发 vs CI），
  不要靠单机调并发度下结论。
