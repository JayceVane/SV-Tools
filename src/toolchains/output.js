'use strict';

const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const DEFAULT_OUTPUT_CHARS = 262144;
const DEFAULT_LINE_CHARS = 65536;
const MAX_CAPTURE_CHARS = 16 * 1024 * 1024;
const LOG_FLUSH_GRACE_MS = 5000;
const LINE_MARKER = '…[输出行截断]…';

function captureLimit(value, fallback, name) {
    const limit = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CAPTURE_CHARS) throw new RangeError(name + ' 必须为 1–' + MAX_CAPTURE_CHARS + ' 的整数');
    return limit;
}
function tailText(text, limit) {
    let start = Math.max(0, text.length - limit);
    if (start && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff
        && text.charCodeAt(start - 1) >= 0xd800 && text.charCodeAt(start - 1) <= 0xdbff) start++;
    return text.slice(start);
}
function headText(text, limit) {
    let end = Math.min(text.length, limit);
    if (end && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
        && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
    return text.slice(0, end);
}
class TailBuffer {
    constructor(limit) { this.limit = limit; this.text = ''; this.truncated = false; }
    append(text) {
        if (this.text.length + text.length > this.limit) this.truncated = true;
        this.text = text.length >= this.limit ? tailText(text, this.limit) : tailText(this.text + text, this.limit);
    }
}

/** 保留完整短行；超长行保留头尾和显式标记，绝不称为完整诊断。 */
class LineBuffer {
    constructor(limit) {
        this.limit = limit;
        this.marker = headText(LINE_MARKER, limit);
        this.headLimit = Math.floor((limit - this.marker.length) / 2);
        this.tailLimit = limit - this.marker.length - this.headLimit;
        this.reset();
    }
    reset() { this.text = ''; this.head = ''; this.tail = ''; this.length = 0; this.truncated = false; }
    append(part) {
        this.length += part.length;
        if (!this.truncated && this.text.length + part.length <= this.limit) {
            this.text += part;
            return;
        }
        if (!this.truncated) {
            this.head = headText(this.text + headText(part, this.headLimit), this.headLimit);
            this.tail = part.length >= this.tailLimit ? tailText(part, this.tailLimit) : tailText(this.text + part, this.tailLimit);
            this.text = '';
            this.truncated = true;
        } else this.tail = part.length >= this.tailLimit ? tailText(part, this.tailLimit) : tailText(this.tail + part, this.tailLimit);
    }
    take(final) {
        const text = this.truncated ? this.head + this.marker + this.tail : this.text;
        const meta = { truncated: this.truncated, droppedChars: this.truncated ? this.length - this.head.length - this.tail.length : 0, final };
        this.reset();
        return { text, meta };
    }
}

class LineFramer {
    constructor(limit, emit, markTruncated) {
        this.line = new LineBuffer(limit);
        this.emit = emit;
        this.markTruncated = markTruncated;
        this.afterCarriageReturn = false;
    }
    write(text, isActive) {
        let offset = 0;
        while (offset < text.length && isActive()) {
            const lf = text.indexOf('\n', offset);
            const cr = text.indexOf('\r', offset);
            const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
            if (this.afterCarriageReturn && text[offset] === '\n') {
                this.afterCarriageReturn = false;
                offset++;
                continue;
            }
            this.afterCarriageReturn = false;
            this.line.append(text.slice(offset, end < 0 ? text.length : end));
            if (this.line.truncated) this.markTruncated();
            if (end < 0) break;
            const { text: complete, meta } = this.line.take(false);
            this.emit(complete, meta);
            this.afterCarriageReturn = text[end] === '\r';
            offset = end + 1;
        }
    }
    finish() {
        if (this.line.length) {
            const { text, meta } = this.line.take(true);
            this.emit(text, meta);
        }
    }
}

/**
 * 收集有界摘要、逐行解析及完整文件日志。日志顺序是两路 decoded UTF-8 回调的接收顺序。
 * @param {{maxOutputChars?: number, maxLineChars?: number, logPath?: string, onStdout?: Function, onStderr?: Function, onLine?: Function}} options
 * @param {{onFailure?: (error: Error) => void, createLogStream?: typeof fs.createWriteStream}} [hooks] writer 注入仅用于验证背压/故障。
 */
class ProcessOutput {
    constructor(options = {}, hooks = {}) {
        const maxOutputChars = captureLimit(options.maxOutputChars, DEFAULT_OUTPUT_CHARS, 'maxOutputChars');
        const maxLineChars = captureLimit(options.maxLineChars, DEFAULT_LINE_CHARS, 'maxLineChars');
        this.options = options;
        this.hooks = hooks;
        this.accepting = true;
        this.finished = false;
        this.streams = [];
        this.backpressured = false;
        this.errorMessage = null;
        this.logError = null;
        this.logPath = options.logPath || null;
        this.lineTruncated = false;
        this.stdout = new TailBuffer(maxOutputChars);
        this.stderr = new TailBuffer(maxOutputChars);
        this.output = new TailBuffer(maxOutputChars);
        this.decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
        this.lines = [false, true].map(isStderr => new LineFramer(maxLineChars,
            (text, meta) => this.invoke('onLine', text, isStderr, meta), () => { this.lineTruncated = true; }));
        this.writer = null;
        this.logFinished = false;
        this.logSettled = false;
        this.logCompletion = Promise.resolve();
        if (this.logPath) this.createLog(hooks.createLogStream || fs.createWriteStream);
    }
    bindStreams(streams) { this.streams = streams.filter(Boolean); }
    pauseStreams() {
        if (this.backpressured) return;
        this.backpressured = true;
        for (const stream of this.streams) stream.pause();
    }
    resumeStreams() {
        if (!this.backpressured) return;
        this.backpressured = false;
        for (const stream of this.streams) stream.resume();
    }
    stopInput() { this.accepting = false; this.resumeStreams(); }
    report(error) {
        if (!this.errorMessage) this.errorMessage = error.message || String(error);
        this.stopInput();
        if (this.hooks.onFailure) this.hooks.onFailure(error);
        else console.error('工具输出处理失败：', error);
    }
    settleLog() {
        if (this.logSettled) return;
        this.logSettled = true;
        if (this.logTimer) clearTimeout(this.logTimer);
        this.resolveLog();
    }
    failLog(error) {
        if (this.logError) return;
        this.logError = error.message || String(error);
        this.report(new Error('工具日志写入失败（' + this.logPath + '）：' + this.logError));
        this.settleLog();
    }
    createLog(createLogStream) {
        this.logCompletion = new Promise(resolve => { this.resolveLog = resolve; });
        try {
            this.writer = createLogStream(this.logPath, { flags: 'wx', encoding: 'utf8', highWaterMark: 65536, autoDestroy: true, emitClose: true });
            this.writer.on('drain', () => this.resumeStreams());
            this.writer.on('error', error => this.failLog(error));
            this.writer.once('finish', () => { this.logFinished = true; });
            this.writer.once('close', () => {
                if (!this.logFinished && !this.logError) this.failLog(new Error('工具日志在 flush 前关闭'));
                this.settleLog();
            });
        } catch (error) { this.failLog(error); }
    }
    invoke(name, ...args) {
        if (!this.accepting || !this.options[name]) return;
        try { this.options[name](...args); }
        catch (error) { this.report(new Error(name + ' 回调失败：' + (error.message || String(error)))); }
    }
    feed(isStderr, text) {
        if (!this.accepting || !text) return;
        this.output.append(text);
        (isStderr ? this.stderr : this.stdout).append(text);
        if (this.writer && !this.logError) {
            try { if (!this.writer.write(text)) this.pauseStreams(); }
            catch (error) { this.failLog(error); }
        }
        this.invoke(isStderr ? 'onStderr' : 'onStdout', text);
        this.lines[isStderr ? 1 : 0].write(text, () => this.accepting);
    }
    write(isStderr, chunk) {
        if (!this.accepting) return;
        try { this.feed(isStderr, typeof chunk === 'string' ? chunk : this.decoders[isStderr ? 1 : 0].write(chunk)); }
        catch (error) { this.report(error); }
    }
    snapshot() {
        return { stdout: this.stdout.text, stderr: this.stderr.text, output: this.output.text,
            outputTruncated: this.stdout.truncated || this.stderr.truncated || this.output.truncated || this.lineTruncated,
            lineTruncated: this.lineTruncated, logPath: this.logPath, logError: this.logError, errorMessage: this.errorMessage };
    }
    async finish() {
        if (!this.finished) {
            this.finished = true;
            if (this.accepting) {
                this.feed(false, this.decoders[0].end());
                this.feed(true, this.decoders[1].end());
                for (const line of this.lines) { if (this.accepting) line.finish(); }
            }
            this.stopInput();
            if (this.writer && !this.logSettled) {
                this.logTimer = setTimeout(() => {
                    const error = new Error('工具日志 flush 超过 ' + LOG_FLUSH_GRACE_MS + 'ms');
                    this.failLog(error);
                    this.writer.destroy(error);
                }, LOG_FLUSH_GRACE_MS);
                try { this.writer.end(); }
                catch (error) { this.failLog(error); }
            }
        }
        await this.logCompletion;
        return this.snapshot();
    }
}

module.exports = { ProcessOutput, DEFAULT_OUTPUT_CHARS, DEFAULT_LINE_CHARS, MAX_CAPTURE_CHARS };
