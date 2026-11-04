'use strict';
/**
 * VCD 查询的 Rust 适配层（Path A / CLI 与 Agent 共用）。
 *
 * 历史：这里曾自己流式解析 VCD 并落盘索引缓存（`VcdStore` + `index.bin`）。
 * 实测 Rust（wellen）冷解析比 JS 缓存命中还快（500 MiB：353 ms vs 5663 ms），
 * 缓存带来的收益为负，因此整体删除，改为直接用 Rust 会话。
 *
 * 这一层只做三件事：
 * 1. 把 `waveOpen` 的元数据整形成 CLI 输出需要的形状；
 * 2. 把路径/短名解析成信号 id，再调对应的 napi 查询；
 * 3. 把 Rust 的 `bits`/字符串时间统一转成 CLI 协定（整数 tick + 原始位串）。
 */

/** 惰性加载原生模块：波形命令之外的路径不会被 .node 加载失败拖累。 */
let nativeCache = null;
function nativeApi() {
    if (nativeCache) return nativeCache;
    const { createNativeLoader } = require('../native-loader');
    nativeCache = createNativeLoader().load();
    return nativeCache;
}

/** 解析错误里的 `[CODE]` 前缀（napi 的 Error::from_reason 只填 message）。 */
function codeOf(error) {
    const match = /^\[([A-Z0-9_]+)\]\s*(.*)$/s.exec(error?.message || '');
    return match ? { code: match[1], message: match[2] } : { code: error?.code, message: error?.message || String(error) };
}

/** 调用 napi 并把 Rust 的 `[CODE] msg` 错误还原成带 code 的 JS 异常。 */
function call(fn) {
    try {
        return JSON.parse(fn());
    } catch (error) {
        const { code, message } = codeOf(error);
        throw Object.assign(new Error(message), { code: code || 'VCD_PARSE' });
    }
}

module.exports = { nativeApi, call, codeOf };
