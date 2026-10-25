'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { CircuitSession } = require('../src/circuit/session');
const { syntheticDesign } = require('./benchmark-circuit-trace');
const CELLS = 20000, COLD_RUNS = 5, WARMUP_RUNS = 5, WARM_RUNS = 20;
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];

function asSyntheticJson(design) {
    const module = design.modules[0], bits = values => values.map(value => Number(value.slice(2)) + 2);
    const ports = values => Object.fromEntries(values.map(port => [port.name, { direction: port.direction, bits: bits(port.bits) }]));
    return { creator: 'Synthetic parallel inverter fixture; not Yosys tool output', modules: { top: {
        ports: ports(module.ports), cells: Object.fromEntries(module.cells.map(cell => [cell.name, {
            type: cell.type, port_directions: Object.fromEntries(cell.ports.map(port => [port.name, port.direction])),
            connections: Object.fromEntries(cell.ports.map(port => [port.name, bits(port.bits)]))
        }])), netnames: {} } } };
}

/** 固定合成规模测量真实Worker往返、查询、投影和ELK；不包含Yosys生成或SVG页面。 */
async function run() {
    const directory = path.resolve('bin/circuit-trace-view-benchmark'); await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, 'synthetic.json');
    await fs.writeFile(filePath, JSON.stringify(asSyntheticJson(syntheticDesign(CELLS))));
    const target = { coldLayoutP95Ms: 2000, warmLayoutP95Ms: 1000 }, cold = [], warm = [], loads = [];
    let graph, fullLayoutError;
    for (let iteration = 0; iteration < COLD_RUNS; iteration++) {
        const session = new CircuitSession();
        try {
            const loadStart = performance.now(), descriptor = await session.request('load', { filePath }); loads.push(performance.now() - loadStart);
            const identity = { designId: descriptor.id, revision: descriptor.revision, moduleId: descriptor.top };
            const signals = await session.request('traceSignals', { ...identity, query: 'out' });
            const request = { ...identity, direction: 'drivers', origin: { objectId: signals.items.find(item => item.name === 'out').objectId, positions: [1234] }, branches: [] };
            const start = performance.now(); graph = await session.request('traceLayout', request); cold.push(performance.now() - start);
            if (iteration) continue;
            try { await session.request('layout', { moduleId: descriptor.top }); throw new Error('合成全图应当超过原有布局预算'); }
            catch (error) { if (!/display nodes|展示预算/.test(error.message)) throw error; fullLayoutError = error.message; }
            for (let i = 0; i < WARMUP_RUNS + WARM_RUNS; i++) {
                const queryStart = performance.now(); graph = await session.request('traceLayout', request);
                if (i >= WARMUP_RUNS) warm.push(performance.now() - queryStart);
            }
        } finally { session.dispose(); }
    }
    const observed = { loadP95Ms: p95(loads), coldLayoutP95Ms: p95(cold), warmLayoutP95Ms: p95(warm) };
    const report = { date: new Date().toISOString(), runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
        scope: '真实Worker往返、索引、局部查询、投影和ELK；不含工具生成、源码解析或SVG交互', synthetic: true,
        cells: CELLS, coldRuns: COLD_RUNS, warmupRuns: WARMUP_RUNS, warmRuns: WARM_RUNS, target, observed,
        result: { cells: graph.stats.cellCount, nodes: graph.nodes.length, edges: graph.edges.length, selectedIndices: graph.trace.origin.bits.map(bit => bit.index), truncated: graph.trace.truncated },
        fullLayoutError, samples: { loads, cold, warm }, passed: Object.fromEntries(Object.entries(target).map(([name, value]) => [name, observed[name] <= value])) };
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
    if (Object.values(report.passed).includes(false)) process.exitCode = 1;
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
