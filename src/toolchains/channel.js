'use strict';
const MAX_QUEUED_CHARS = 65536, MAX_VISIBLE_CHARS = 1048576, FLUSH_INTERVAL_MS = 50;

/**
 * 高频工具输出批量刷新；输出通道只保留有限内容，完整日志由 process 写盘。
 * @param {{append:Function,appendLine:Function,clear:Function}} channel
 * @param {{maxQueuedChars?:number,maxVisibleChars?:number,flushIntervalMs?:number}} [options]
 * @returns {{append:Function,flush:Function,dispose:Function}}
 */
function createBufferedOutput(channel, { maxQueuedChars = MAX_QUEUED_CHARS, maxVisibleChars = MAX_VISIBLE_CHARS, flushIntervalMs = FLUSH_INTERVAL_MS } = {}) {
    if (![maxQueuedChars, maxVisibleChars, flushIntervalMs].every(Number.isSafeInteger)
        || maxQueuedChars < 1 || maxVisibleChars < 1 || flushIntervalMs < 0) throw new RangeError('输出预算必须是有效整数');
    const chunkSize = Math.min(maxQueuedChars, maxVisibleChars);
    let chunks = [], queued = 0, visible = 0, timer = null, disposed = false;
    function flush() {
        if (timer) clearTimeout(timer); timer = null;
        if (!queued) return;
        channel.append(chunks.join('')); visible += queued; chunks = []; queued = 0;
    }
    function append(text) {
        if (disposed) return;
        for (let offset = 0; offset < text.length; offset += chunkSize) {
            const chunk = text.slice(offset, offset + chunkSize);
            if (queued + chunk.length > maxQueuedChars) flush();
            if (visible + queued + chunk.length > maxVisibleChars) {
                flush(); channel.clear(); visible = 0;
                channel.appendLine('[工具输出较长，早期内容请查看本次任务的完整日志]');
            }
            chunks.push(chunk); queued += chunk.length;
        }
        if (!timer) timer = setTimeout(flush, flushIntervalMs);
    }
    return { append, flush, dispose() { flush(); disposed = true; } };
}
module.exports = { createBufferedOutput };
