'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createDesign } = require('../src/circuit/model');
const { createTopologyIndex } = require('../src/circuit/topology');
const { createCircuitTracer, DEFAULT_LIMITS } = require('../src/circuit/trace');
const { projectModule } = require('../src/circuit/projection');

/** @param {number} count 独立反相器数量。 @returns {object} 明确标记为合成数据的领域模型，不冒充工具输出。 */
function syntheticDesign(count) {
    const input = Array.from({ length: count }, (_, i) => 'n:' + i), output = input.map((_, i) => 'n:' + (i + count));
    return createDesign({ schemaVersion: 1, title: 'Synthetic parallel inverter benchmark', top: 'top',
        provenance: { engine: 'synthetic', version: '1', stage: 'topology-benchmark' }, modules: [{ id: 'top', name: 'top', signals: [],
            ports: [{ id: 'in', name: 'in', direction: 'input', bits: input }, { id: 'out', name: 'out', direction: 'output', bits: output }],
            cells: input.map((bit, i) => ({ id: 'not:' + i, name: 'not_' + i, type: '$not', kind: 'logic', ports: [
                { id: 'not:' + i + '/A', name: 'A', direction: 'input', bits: [bit] },
                { id: 'not:' + i + '/Y', name: 'Y', direction: 'output', bits: [output[i]] }
            ] })) }] });
}
const collect = () => { if (typeof global.gc === 'function') global.gc(); };
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];

/**
 * 固定5次冷查询、10次预热与100次热查询，模型生成与GC不计入查询耗时。
 * @param {{cells?:number}} options 合成规模，默认20,000个独立单元。
 * @returns {object} 测量条件、预先声明目标与真实观测；不测量尚未接入的布局/界面。
 */
function runBenchmark({ cells = 20000 } = {}) {
    if (!Number.isSafeInteger(cells) || cells < 1000 || cells > 30000) throw new RangeError('benchmark cells应在1000–30000之间');
    const model = syntheticDesign(cells), targets = { indexMs: 1000, coldP95Ms: 1000, hotP95Ms: 10, indexHeapMiB: 128 };
    collect(); const baseline = process.memoryUsage();
    let started = performance.now(), index = createTopologyIndex(model.modules[0]);
    const indexMs = performance.now() - started;
    collect(); const indexed = process.memoryUsage();
    const shape = { cells, endpointReferences: index.referenceCount, objects: index.objectCount, wireBits: index.wireCount };
    index = null; collect();
    const request = position => ({ moduleId: 'top', direction: 'drivers', origin: { objectId: 'out', positions: [position] } });
    const cold = [], hot = []; let tracer, last;
    for (let run = 0; run < 5; run++) {
        tracer?.dispose(); collect(); tracer = createCircuitTracer(model);
        started = performance.now(); last = tracer.trace(request(run)); cold.push(performance.now() - started);
    }
    for (let run = 0; run < 10; run++) tracer.trace(request((run * 7919) % cells));
    for (let run = 0; run < 100; run++) {
        started = performance.now(); last = tracer.trace(request((run * 7919) % cells)); hot.push(performance.now() - started);
    }
    let fullProjectionFailure;
    try { projectModule(model, model.top); } catch (error) { fullProjectionFailure = error.message; }
    const measurements = { indexMs, indexHeapMiB: (indexed.heapUsed - baseline.heapUsed) / 1024 ** 2,
        indexRssMiB: (indexed.rss - baseline.rss) / 1024 ** 2, coldP95Ms: percentile(cold, 0.95),
        hotP50Ms: percentile(hot, 0.5), hotP95Ms: percentile(hot, 0.95), hotMaxMs: Math.max(...hot) };
    const passed = Object.fromEntries(Object.entries(targets).map(([key, target]) => [key, measurements[key] <= target]));
    const cache = tracer.stats(); tracer.dispose();
    return { schemaVersion: 1, fixture: 'synthetic-parallel-inverters', shape, limits: DEFAULT_LIMITS,
        environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, gc: typeof global.gc === 'function' },
        repetitions: { cold: 5, warmup: 10, hot: 100 }, targets, measurements, passed,
        fullProjectionFailure, local: { cells: last.cells.length, truncated: last.truncated, stats: last.stats, cache },
        samples: { coldMs: cold, hotMs: hot }, layoutAndInteraction: 'not measured; M2 not implemented' };
}

if (require.main === module) {
    const report = runBenchmark();
    const target = path.resolve(__dirname, '../bin/circuit-trace-benchmark/report.json');
    fs.mkdir(path.dirname(target), { recursive: true }).then(() => fs.writeFile(target, JSON.stringify(report, null, 2))).then(() => {
        console.log(JSON.stringify({ report: target, shape: report.shape, targets: report.targets, measurements: report.measurements,
            passed: report.passed, local: report.local, fullProjectionFailure: report.fullProjectionFailure }, null, 2));
        if (Object.values(report.passed).includes(false)) process.exitCode = 1;
    }).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { syntheticDesign, runBenchmark };
