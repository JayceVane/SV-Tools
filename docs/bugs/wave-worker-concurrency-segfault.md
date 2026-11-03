# 波形 worker 并发段错误：两层独立成因

## 现象

`npm test` 在默认并发（14 路）下，`waveform_memory_test.js` / `waveform_stream_test.js`
的测试进程以 `exitCode 3221225477`（`0xC0000005`，Windows 访问违例）退出；
`--test-concurrency=1` 与 `=4`、`=6` 全绿，`=14` 稳定失败。单独跑这两个文件也全绿。

## 第一层：wellen 的 rayon 全局线程池（真 bug，已修）

`simple::read` 内部是 `read_with_options(..., &LoadOptions::default())`，
而 default 是 `multi_thread: true`，VCD 体解析会用 **rayon 全局线程池**并行装载信号。
本模块跑在 napi 里，既会被 Node `worker_threads` 调用，也会被多个测试进程同时加载；
rayon 全局池与 napi 的线程模型叠加后触发访问违例。

修复：`parse_once` 显式传 `LoadOptions { multi_thread: false, .. }`。
代价可接受——单线程解析 500 MiB 语料仍是 353 ms 量级，瓶颈本就在 I/O。

## 第二层：`worker.terminate()` 撕裂在途的异步 napi 任务（真 bug，已修）

`session.dispose()` 原来直接 `worker.terminate()`。而此时 worker 里可能正在跑
`waveOpenAsync` / `waveValuesAsync` 等 `AsyncTask`：`compute` 在 libuv 线程池里执行
Rust 代码，isolate 被拆掉后 Rust 侧收尾会踩到已销毁的 V8 上下文。

修复（协议层）：
1. 所有波形查询都提供 `*_async` 版本（`bindings.rs` 里用 `wave_async!` 宏批量生成），
   worker 一律走异步入口，不再长时间持有 worker 线程；
2. `session.closeWorker()` 发 `{ method: 'close' }` 而不是 terminate，等 worker 回执
   `{ type: 'closed' }`；worker 侧用「在途请求计数」保证只有 `pendingRequests === 0`
   时才 `process.exit(0)`；
3. 5 秒宽限期只作兜底（真卡死才强杀）。

## 第三层：并发测试的内存压力（环境问题，不是代码缺陷）

修完前两层后，`=14` 仍有 2 个文件失败。测得机器 `FreePhysicalMemory` 只剩 1.9 GB / 32 GB。
每个 Node 测试进程都加载 25 MB 的 `.node` 并持有波形数据，14 路并发叠加项目里的
Vivado/iverilog 重负载测试后会把可用内存吃穿，进程被 OS 杀掉——同样报 `0xC0000005`。

验证：`--test-concurrency=6` 全量 875/875 全绿；`=4` 也全绿。

## 复发预防

- **不要**在 napi 模块里让第三方库默认开多线程解析（rayon / std::thread 池）；
- **不要**用 `worker.terminate()` 关闭可能持有在途 napi 任务的 worker，改用计数握手；
- 判断「并发才失败」的测试时，先区分**代码竞态**与**内存耗尽**：
  前者在低并发也偶发，后者只在接近满负载时出现，且 `FreePhysicalMemory` 可佐证。
