'use strict';
// M3 交付3验收：接口束聚合与纯 Node SVG 架构图渲染（证据绑定、确定性、PNG 拒绝）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { run } = require('../src/cli/main');
const { buildArchitecture } = require('../src/design/arch');
const { buildRenderProjection, DEFAULT_RENDER_BUDGET, layoutArchitecture, renderArchitectureSvg } = require('../src/design/svg');

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
    assert.equal(data.style, 'document');
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
    assert.equal(evidence.export.style, 'document');
    assert.equal(evidence.export.title, 'FIFO 架构');
    assert.equal(evidence.export.width, artifact.width);
    assert.match(evidence.designId, /^design:[0-9a-f]{16}$/);
    assert.match(evidence.modelSha256, /^[0-9a-f]{64}$/);
    assert.equal(evidence.modelSha256, evidence.archSha256);
    const expectedSources = (await fsp.readdir(directory)).filter(name => name.endsWith('.sv')).sort().map(name => ({
        path: name, sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, name)), 'utf8').digest('hex')
    }));
    assert.deepEqual(evidence.sourceFiles, expectedSources);
    assert.deepEqual(data.evidence, evidence);
    assert.equal(svg.includes('fill="#ffffff"'), true, 'document 风格纯白背景');
    assert.equal(svg.includes('arch-grid'), false, 'document 风格无网格/渐变');
    assert.equal(svg.includes('stroke="#111111"'), true, 'document 风格黑色描边');
    assert.equal(svg.includes('stroke-dasharray="6 4"'), true, 'blackbox 虚线 6 4');
    assert.equal(svg.includes('font-family="-apple-system'), true, 'document 无衬线字体');
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

test('document/presentation 共用布局坐标，各自两次渲染确定', async t => {
    const directory = await workspace(t, 'skeleton');
    const arch = (await run(['design', 'arch', '--workspace', directory, '--top', 'fifo_top'])).output.data;
    const layout = await layoutArchitecture(arch);
    const documentA = renderArchitectureSvg(arch, layout, { style: 'document' });
    const documentB = renderArchitectureSvg(arch, layout, { style: 'document' });
    const presentationA = renderArchitectureSvg(arch, layout, { style: 'presentation' });
    const presentationB = renderArchitectureSvg(arch, layout, { style: 'presentation' });
    const alias = renderArchitectureSvg(arch, layout, { style: 'ui' });
    assert.equal(documentA.sha256, documentB.sha256);
    assert.equal(presentationA.sha256, presentationB.sha256);
    assert.equal(alias.sha256, presentationA.sha256, 'ui 是 presentation 的别名');
    assert.notEqual(documentA.sha256, presentationA.sha256);
    assert.equal(documentA.width, presentationA.width);
    assert.equal(documentA.height, presentationA.height);
    assert.equal(documentA.evidence.export.style, 'document');
    assert.equal(presentationA.evidence.export.style, 'presentation');
    const rectOf = (svg, id) => {
        const match = new RegExp('data-model-id="' + id + '"[\\s\\S]*?<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"').exec(svg);
        assert(match, id);
        return match.slice(1);
    };
    for (const id of ['instance:u_buf', 'instance:u_sink', 'boundary:clk']) {
        assert.deepEqual(rectOf(documentA.svg, id), rectOf(presentationA.svg, id), id);
    }
    assert.equal(presentationA.svg.includes('fill="#111923"'), true);
    assert.equal(presentationA.svg.includes('arch-grid'), true);
    assert.equal(presentationA.svg.includes('stroke-dasharray="4 3"'), true);
    assert.equal(documentA.svg.includes('stroke-dasharray="6 4"'), true);
    assert.throws(() => renderArchitectureSvg(arch, layout, { style: 'neon' }), { code: 'INVALID_ARGUMENT' });
    const unresolvedDirectory = await workspace(t, 'unresolved');
    const unresolvedArch = (await run(['design', 'arch', '--workspace', unresolvedDirectory, '--top', 'ghost_top'])).output.data;
    const unresolvedImage = renderArchitectureSvg(unresolvedArch, await layoutArchitecture(unresolvedArch));
    assert.equal(unresolvedImage.svg.includes('stroke-dasharray="2 3"'), true, 'unresolved 点线 2 3');
    assert.equal(unresolvedImage.svg.includes('>unresolved<'), true);
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
    assert.equal(output.data.style, 'document');
    assert.match(path.basename(output.artifacts[0].path), /-document\.svg$/);
    assert.equal(output.artifacts[0].format, 'svg');
    assert.equal(fs.existsSync(output.artifacts[0].path), true);
});

test('扇出接口合并与无公共前缀标签回退', async t => {
    const directory = await workspace(t, 'fanout');
    const arch = (await run(['design', 'arch', '--workspace', directory, '--top', 'fanout_top'])).output.data;
    assert.equal(arch.interfaces.length, 4);
    const fanout = arch.interfaces.find(item => item.from.name === 'u_clk' && item.to.kind === 'instance' && item.to.name.includes('+'));
    assert.deepEqual(fanout.to, { kind: 'instance', name: 'u_a+u_b+u_c' });
    assert.equal(fanout.direction, 'forward');
    assert.equal(fanout.bits, 2);
    assert.equal(fanout.label, 'clk/rst');
    assert.deepEqual(fanout.signals.map(signal => signal.name), ['clk_sys', 'rst_sys_n']);
    const fallback = arch.interfaces.find(item => item.from.name === 'u_a' && item.to.name === 'u_sink');
    assert.equal(fallback.label, 'alpha, beta');
    assert.equal(fallback.bits, 2);
    const image = await run(['design', 'render', '--workspace', directory, '--top', 'fanout_top', '--out', 'out']);
    assert.equal(image.exitCode, 0);
    assert.equal(image.output.data.style, 'document');
    assert.equal(image.output.data.stats.junctions, 1);
    assert.equal(image.output.data.evidence.export.junctionCount, 1);
    const svg = await fsp.readFile(image.output.data.path, 'utf8');
    assert.equal(svg.includes('clk/rst (2 bits)'), true);
    assert.equal(svg.includes('alpha, beta (2 bits)'), true);
});

test('演示项目接口束远少于信号级边，且规模可渲染', { skip: fs.existsSync(DEMO) ? false : '演示项目不存在' }, async () => {
    const files = readDirectory(path.join(DEMO, 'rtl'));
    const arch = await buildArchitecture({ workspace: DEMO, files, top: 'soc_top' });
    assert.equal(arch.graph.nodes.filter(node => node.kind === 'instance').length, 15);
    assert.equal(arch.graph.edges.length, 191);
    assert.equal(arch.interfaces.length, 30);
    assert.equal(arch.interfaces.length < 60, true, '接口束应明显少于191条信号边');
    assert.equal(arch.interfaces.length < arch.graph.edges.length / 3, true);
    const fanouts = arch.interfaces.filter(item => item.from.name === 'u_clkrst' && item.to.name.includes('+'));
    assert.deepEqual(fanouts.map(item => item.label), ['clk/rst', 'clk/rst']);
    assert.equal(fanouts.reduce((total, item) => total + item.to.name.split('+').length, 0), 14);
    const first = await layoutArchitecture(arch);
    const second = await layoutArchitecture(arch);
    assert.equal(first.projection.stats.junctions, 8);
    assert.equal(first.layout.width / first.layout.height > 1.4, true, '布局宽高比应大于1.4');
    assert.equal(first.layout.width / first.layout.height < 1.6, true, '布局宽高比应小于1.6');
    const boxes = first.layout.nodes.map(node => ({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height }));
    for (let left = 0; left < boxes.length; left++) {
        for (let right = left + 1; right < boxes.length; right++) {
            const a = boxes[left], b = boxes[right];
            const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
            assert.equal(overlap, false, a.id + ' 与 ' + b.id + ' 重叠');
        }
    }
    const imageA = renderArchitectureSvg(arch, first, { title: 'SoC 顶层架构', style: 'document' });
    const imageB = renderArchitectureSvg(arch, second, { title: 'SoC 顶层架构', style: 'document' });
    const presentationA = renderArchitectureSvg(arch, first, { title: 'SoC 顶层架构', style: 'presentation' });
    const presentationB = renderArchitectureSvg(arch, second, { title: 'SoC 顶层架构', style: 'presentation' });
    assert.equal(imageA.sha256, imageB.sha256);
    assert.equal(presentationA.sha256, presentationB.sha256);
    assert.equal(imageA.width, presentationA.width);
    assert.equal(imageA.height, presentationA.height);
    assert.equal(imageA.width / imageA.height > 1.4, true);
    assert.equal(imageA.evidence.export.junctionCount, 8);
    assert.equal(imageA.evidence.export.style, 'document');
    assert.equal(presentationA.evidence.export.style, 'presentation');
});
