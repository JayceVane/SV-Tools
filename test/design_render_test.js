'use strict';
// M3 交付3验收：接口束聚合与纯 Node SVG 架构图渲染（证据绑定、确定性、PNG 拒绝）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../src/cli/main');
const { buildArchitecture } = require('../src/design/arch');
const { buildRenderProjection, DEFAULT_RENDER_BUDGET } = require('../src/design/svg');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'design');
const DEMO = process.env.SVTOOLS_ARCH_DEMO || 'D:/Workspace/FPGA/svtools-arch-demo';

/** @param {string} directory @returns {{path:string,text:string}[]} 递归读取源码文本。 */
function readDirectory(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return entry.name === '.svtools' ? [] : readDirectory(file);
        }
        return entry.isFile() ? [{ path: file, text: fs.readFileSync(file, 'utf8') }] : [];
    });
}

/** @param {object} t 测试上下文 @param {string} name fixture 名称 @returns {Promise<string>} 隔离工作区。 */
async function workspace(t, name) {
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-render-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    await fsp.cp(path.join(FIXTURES, name), directory, { recursive: true });
    return directory;
}

/** @param {string} svg SVG 文本。 @returns {object} 解析后的证据元数据。 */
function evidenceOf(svg) {
    const match = /<metadata id="svtools-evidence">([\s\S]*?)<\/metadata>/.exec(svg);
    assert(match, '缺少 svtools-evidence 元数据');
    return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'"));
}

test('skeleton 接口束：clk 扇出合并、din/dout/ready 各成束', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'fifo_top']);
    assert.equal(response.exitCode, 0);
    const interfaces = response.output.data.interfaces;
    assert.equal(interfaces.length, 5);
    const clk = interfaces.find(item => item.from.kind === 'boundary' && item.from.name === 'clk');
    assert.deepEqual(clk.to, { kind: 'instance', name: 'u_buf+u_sink' });
    assert.equal(clk.direction, 'forward');
    assert.equal(clk.bits, 1);
    assert.equal(clk.label, 'clk');
    assert.deepEqual(clk.signals, [{ name: 'clk', width: 1, direction: 'input' }]);
    const din = interfaces.find(item => item.label === 'din');
    assert.deepEqual(din.from, { kind: 'boundary', name: 'din' });
    assert.deepEqual(din.to, { kind: 'instance', name: 'u_buf' });
    assert.equal(din.bits, 8);
    const dout = interfaces.find(item => item.label === 'dout');
    assert.deepEqual(dout.from, { kind: 'instance', name: 'u_buf' });
    assert.deepEqual(dout.to, { kind: 'boundary', name: 'dout' });
    const ready = interfaces.find(item => item.label === 'ready');
    assert.deepEqual(ready.to, { kind: 'boundary', name: 'ready' });
    const internal = interfaces.find(item => item.label.startsWith('buf_'));
    assert.deepEqual(internal.from, { kind: 'instance', name: 'u_buf' });
    assert.deepEqual(internal.to, { kind: 'instance', name: 'u_sink' });
    assert.equal(internal.bits, 8);
});

test('render SVG：证据元数据、data-model-id 数量、边界、总线标签与字体/图例', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'render', '--workspace', directory, '--top', 'fifo_top', '--out', 'out', '--title', 'FIFO 架构']);
    assert.equal(response.exitCode, 0);
    assert.equal(response.output.operation, 'design.render');
    const data = response.output.data, artifact = response.output.artifacts[0];
    assert.equal(artifact.kind, 'image');
    assert.equal(artifact.format, 'svg');
    assert.equal(artifact.path, data.path);
    assert.equal(artifact.sha256, data.sha256);
    assert.equal(artifact.bytes, data.bytes);
    assert.equal(artifact.width, data.width);
    assert.equal(artifact.height, data.height);
    const svg = await fsp.readFile(artifact.path, 'utf8');
    assert.match(svg, /^<svg /);
    assert.equal(svg.includes('width="' + artifact.width + '"'), true);
    assert.equal(svg.includes('height="' + artifact.height + '"'), true);
    const evidence = evidenceOf(svg);
    assert.match(evidence.archSha256, /^[0-9a-f]{64}$/);
    assert.match(evidence.contextRevision, /^[0-9a-f]{64}$/);
    assert.equal(evidence.top.name, 'fifo_top');
    assert.equal(evidence.layout.engine, 'elk');
    assert.equal(evidence.export.format, 'svg');
    assert.equal(evidence.export.title, 'FIFO 架构');
    assert.equal(evidence.export.width, artifact.width);
    const arch = (await run(['design', 'arch', '--workspace', directory, '--top', 'fifo_top'])).output.data;
    const projection = buildRenderProjection(arch);
    const expectedIds = projection.nodes.length + projection.nodes.reduce((total, node) => total + node.ports.length, 0);
    assert.equal((svg.match(/data-model-id="/g) || []).length, expectedIds);
    for (const id of ['boundary:clk', 'boundary:din', 'boundary:dout', 'boundary:ready', 'instance:u_buf', 'instance:u_sink']) {
        assert.equal(svg.includes('data-model-id="' + id + '"'), true, id);
    }
    assert.equal(svg.includes('class="badge"') || svg.includes('blackbox'), true);
    assert.equal(svg.includes('collapsed'), true);
    assert.equal(svg.includes('(8 bits)'), true, '总线位宽标签');
    assert.equal(svg.includes('(1 bits)'), true);
    assert.equal(svg.includes('signals:'), true, '边 title 保留完整成员名');
    assert.equal(svg.includes('>bus<') || svg.includes('>bus'), true);
    assert.equal(svg.includes('>boundary<') || svg.includes('>boundary'), true);
    const files = await fsp.readdir(path.join(directory, 'out'));
    assert.equal(files.filter(name => name.endsWith('.svg')).length, 1);
});

test('两次渲染的节点坐标与 SVG sha256 完全一致', async t => {
    const directory = await workspace(t, 'skeleton');
    const first = await run(['design', 'render', '--workspace', directory, '--top', 'fifo_top', '--out', 'out-a']);
    const second = await run(['design', 'render', '--workspace', directory, '--top', 'fifo_top', '--out', 'out-b']);
    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);
    assert.equal(first.output.data.sha256, second.output.data.sha256);
    assert.equal(first.output.data.width, second.output.data.width);
    assert.equal(first.output.data.height, second.output.data.height);
    const firstSvg = await fsp.readFile(first.output.data.path, 'utf8');
    const secondSvg = await fsp.readFile(second.output.data.path, 'utf8');
    assert.equal(firstSvg, secondSvg);
});

test('PNG 无栅格化宿主返回 EXPORT_UNSUPPORTED 且不落盘', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'render', '--workspace', directory, '--top', 'fifo_top', '--format', 'png', '--out', 'png-out']);
    assert.equal(response.exitCode, 2);
    assert.equal(response.output.diagnostics[0].code, 'EXPORT_UNSUPPORTED');
    assert.equal(fs.existsSync(path.join(directory, 'png-out')), false);
    assert.deepEqual((await fsp.readdir(directory)).filter(name => name.endsWith('.svg') || name.endsWith('.png')), []);
});

test('渲染预算超限返回 DESIGN_LIMIT', async t => {
    const directory = await workspace(t, 'skeleton');
    const files = readDirectory(directory);
    const arch = await buildArchitecture({ workspace: directory, files, top: 'fifo_top' });
    assert.deepEqual({ ...DEFAULT_RENDER_BUDGET }, { nodes: 2000, edges: 6000, ports: 16384 });
    assert.throws(() => buildRenderProjection(arch, { budget: { nodes: 1 } }), error => {
        assert.equal(error.code, 'DESIGN_LIMIT');
        assert.equal(error.details.kind, 'nodes');
        return true;
    });
    assert.throws(() => buildRenderProjection(arch, { budget: { edges: 1 } }), error => {
        assert.equal(error.code, 'DESIGN_LIMIT');
        assert.equal(error.details.kind, 'edges');
        return true;
    });
});

test('capabilities 增加 design.render，CLI 子进程输出单份 JSON', async t => {
    const directory = await workspace(t, 'skeleton');
    const doctor = await run(['doctor', '--workspace', directory]);
    assert.equal(doctor.exitCode, 0);
    assert.equal(doctor.output.data.capabilities.includes('design.render'), true);
    const cli = path.join(ROOT, 'src', 'cli', 'main.js');
    const child = spawnSync(process.execPath, [cli, 'design', 'render', '--workspace', directory, '--top', 'fifo_top', '--out', 'out'], { encoding: 'utf8' });
    assert.equal(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.equal(output.operation, 'design.render');
    assert.equal(output.artifacts[0].format, 'svg');
    assert.equal(fs.existsSync(output.artifacts[0].path), true);
});

test('演示项目接口束远少于信号级边，且规模可渲染', { skip: fs.existsSync(DEMO) ? false : '演示项目不存在' }, async () => {
    const files = readDirectory(path.join(DEMO, 'rtl'));
    const arch = await buildArchitecture({ workspace: DEMO, files, top: 'soc_top' });
    assert.equal(arch.graph.nodes.filter(node => node.kind === 'instance').length, 15);
    assert.equal(arch.graph.edges.length, 191);
    assert.equal(arch.interfaces.length < 60, true, '接口束应明显少于191条信号边');
    assert.equal(arch.interfaces.length < arch.graph.edges.length / 3, true);
    const projection = buildRenderProjection(arch);
    assert.equal(projection.stats.ports > 0, true);
});
