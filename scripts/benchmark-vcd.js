'use strict';

// node scripts/benchmark-vcd.js --sizes 100,500 --out bin/vcd-benchmark [--keep-files]
// 每个测量在独立进程运行；legacy 限制 JS heap，避免大文件 baseline 影响扩展宿主。
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const { VcdSession } = require('../src/waveform/session');
const ROOT = path.resolve(__dirname, '..');
const RESULT_PREFIX = 'SVTOOLS_VCD_BENCH_RESULT ';
const LEGACY_REVISION = '869e4d1';
const LEGACY_HEAP_MIB = 768;

function peakRssBytes() {
    if (process.platform === 'win32') {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `(Get-Process -Id ${process.pid}).PeakWorkingSet64`], { windowsHide: true, encoding: 'utf8' });
        const value = Number(result.stdout && result.stdout.trim());
        if (result.status === 0 && value > 0) return value;
    }
    return Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
}

async function measure(mode, filePath, legacyPath) {
    let maxHostDelayMs = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
        const now = performance.now();
        maxHostDelayMs = Math.max(maxHostDelayMs, now - lastTick - 10);
        lastTick = now;
    }, 10);
    const startedAt = performance.now();
    let metadata;
    let parsed;
    let session;
    try {
        if (mode === 'legacy') {
            const text = fs.readFileSync(filePath, 'utf8');
            parsed = require(legacyPath).parseVcd(text);
            metadata = { ...parsed, fileBytes: Buffer.byteLength(text), eventCount: [...parsed.changes.values()].reduce((sum, changes) => sum + changes.length, 0) };
        } else {
            session = new VcdSession();
            metadata = await session.open(filePath);
        }
        const loadMs = performance.now() - startedAt;
        // 同步旧解析结束后允许计时器观察阻塞，再停止加载延迟测量。
        await new Promise(resolve => setTimeout(resolve, 20));
        clearInterval(timer);
        const selectedIds = [...new Set(metadata.vars.map(variable => variable.id))].slice(0, 16);
        const queryStartedAt = performance.now();
        let window;
        if (session) window = await session.window({ ids: selectedIds, start: 0, end: metadata.endTime, pixels: 1200 });
        else {
            // 旧 HTML 把全部信号事件序列化；这里测同样的全量传输成本。
            window = { signals: metadata.vars, changes: [...parsed.changes.entries()] };
        }
        const responseBytes = Buffer.byteLength(JSON.stringify(window));
        const queryMs = performance.now() - queryStartedAt;
        const stats = { mode, status: 'completed', fileBytes: metadata.fileBytes, signalCount: metadata.vars.length,
            eventCount: metadata.eventCount, rawEventCount: metadata.rawEventCount || metadata.eventCount,
            loadMs: Math.round(loadMs), hostMaxDelayMs: Number(maxHostDelayMs.toFixed(2)),
            peakRssBytes: peakRssBytes(), rssMethod: process.platform === 'win32' ? 'PeakWorkingSet64' : 'resourceUsage.maxRSS',
            queryMs: Number(queryMs.toFixed(2)), responseBytes, responseScope: session ? '16 visible ids, 1200 pixels, dense explicit' : 'all-events JSON baseline, aliases not duplicated',
            storageBytes: metadata.storageBytes || null, workerHeapBytes: metadata.workerHeapBytes || null,
            workerArrayBufferBytes: metadata.workerArrayBufferBytes || null };
        console.log(RESULT_PREFIX + JSON.stringify(stats));
    } finally {
        clearInterval(timer);
        if (session) await session.dispose();
    }
}

async function generate(filePath, targetBytes) {
    const stream = fs.createWriteStream(filePath, { flags: 'wx' });
    let streamError;
    stream.on('error', error => { streamError = error; });
    const write = chunk => new Promise((resolve, reject) => stream.write(chunk, error => error ? reject(error) : resolve()));
    let source = '$date deterministic benchmark $end\n$version svtools 4.0 bench $end\n$timescale 1ns $end\n$scope module tb $end\n';
    for (let signal = 0; signal < 64; signal++) {
        const width = signal === 2 ? 256 : 1;
        const type = signal === 3 ? 'real' : 'wire';
        source += `$var ${type} ${width} s${signal} ${signal === 0 ? 'clk' : signal === 1 ? 'slow_clk' : signal === 2 ? 'data_bus' : signal === 3 ? 'temperature' : 'control_' + signal} $end\n`;
    }
    source += '$scope module dut $end\n$var wire 1 s0 clk_alias $end\n$upscope $end\n$upscope $end\n$enddefinitions $end\n$dumpvars\n';
    for (let signal = 0; signal < 64; signal++) source += signal === 2 ? 'b0 s2\n' : signal === 3 ? 'r25.000 s3\n' : `0s${signal}\n`;
    source += '$end\n';
    await write(source);
    let bytes = Buffer.byteLength(source);
    let pending = '';
    let tick = 0;
    while (bytes + pending.length < targetBytes) {
        pending += '#' + tick * 5 + '\n' + (tick % 2) + 's0\n';
        if (tick % 2 === 0) pending += (Math.floor(tick / 2) % 2) + 's1\n';
        if (tick % 16 === 0) {
            const word = (Math.floor(tick / 16) >>> 0).toString(2).padStart(32, '0');
            pending += 'b' + word.repeat(8) + ' s2\n';
        }
        if (tick % 64 === 0) pending += (Math.floor(tick / (64 * 60)) % 2) + 's' + (4 + Math.floor(tick / 64) % 60) + '\n';
        if (tick % 1024 === 0) pending += 'r' + (25 + Math.sin(tick / 1024) * 5).toFixed(3) + ' s3\n';
        tick++;
        if (pending.length >= 1024 * 1024) { await write(pending); bytes += pending.length; pending = ''; }
    }
    if (pending) { await write(pending); bytes += pending.length; }
    await new Promise((resolve, reject) => { if (streamError) reject(streamError); else { stream.once('error', reject); stream.end(resolve); } });
    return { bytes, ticks: tick, uniqueSignals: 64, declarations: 65 };
}

async function runChild(mode, filePath, legacyPath) {
    const startedAt = performance.now();
    return new Promise(resolve => {
        const child = spawn(process.execPath, ['--max-old-space-size=' + LEGACY_HEAP_MIB, __filename, '--child', mode, filePath, legacyPath], { cwd: ROOT, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180000);
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
        child.on('error', error => { clearTimeout(timer); resolve({ mode, status: 'spawn-failed', error: error.message }); });
        child.on('close', code => {
            clearTimeout(timer);
            const result = stdout.split(/\r?\n/).find(line => line.startsWith(RESULT_PREFIX));
            if (result) resolve(JSON.parse(result.slice(RESULT_PREFIX.length)));
            else resolve({ mode, status: timedOut ? 'timeout' : 'failed-under-resource-cap', exitCode: code,
                heapLimitMiB: LEGACY_HEAP_MIB, elapsedMs: Math.round(performance.now() - startedAt),
                failureKind: /heap out of memory|Reached heap limit|allocation failed/i.test(stderr) ? 'heap-limit' : 'process-failure',
                error: (stderr.match(/FATAL ERROR:[^\r\n]+/i) || [stderr.slice(-1500)])[0], peakRssBytes: null });
        });
    });
}

async function main() {
    if (process.argv[2] === '--child') return measure(process.argv[3], process.argv[4], process.argv[5]);
    const args = process.argv.slice(2);
    const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
    const sizes = value('--sizes', '100,500').split(',').map(Number);
    if (sizes.some(size => !Number.isInteger(size) || size < 1 || size > 500)) throw new Error('benchmark sizes 必须为 1–500 MiB');
    const outDir = path.resolve(ROOT, value('--out', 'bin/vcd-benchmark'));
    fs.mkdirSync(outDir, { recursive: true });
    const legacy = spawnSync('git', ['show', LEGACY_REVISION + ':src/waveform/parser.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    if (legacy.status !== 0) throw new Error('无法取得明确的 legacy parser baseline：' + legacy.stderr);
    const legacyPath = path.join(outDir, 'legacy-parser.cjs');
    fs.writeFileSync(legacyPath, legacy.stdout);
    const report = { generatedAt: new Date().toISOString(), nodeVersion: process.version, platform: process.platform,
        legacyRevision: LEGACY_REVISION, legacyHeapLimitMiB: LEGACY_HEAP_MIB, corpus: '64 unique signals: clocks + 256-bit bus + sparse controls + real; one alias', runs: [] };
    for (const size of sizes) {
        const filePath = path.join(outDir, 'trace-' + size + 'MiB.vcd');
        const generated = await generate(filePath, size * 1024 * 1024);
        console.log('已生成 ' + size + ' MiB VCD：' + generated.bytes + ' bytes');
        if (args.includes('--generate-only')) continue;
        const current = await runChild('worker', filePath, legacyPath);
        console.log('worker ' + size + ' MiB：' + JSON.stringify(current));
        const baseline = await runChild('legacy', filePath, legacyPath);
        console.log('legacy ' + size + ' MiB：' + JSON.stringify(baseline));
        report.runs.push({ targetMiB: size, generated, worker: current, legacy: baseline });
        fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        if (!args.includes('--keep-files')) await fs.promises.unlink(filePath);
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
