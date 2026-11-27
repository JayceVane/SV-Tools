'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { run } = require('../src/cli/main');
const { buildArchitectureBook, resolveContext, assertBookCurrent } = require('../src/design/architecture-model');
const { diagramTopology, layoutDiagram, renderDiagram } = require('../src/design/architecture-diagram');
const { analyzeStructure, interfaceEvidence } = require('../src/design/struct');
const { exportArchitecture, renderArchitectureBook } = require('../src/design/architecture-export');
const { renderGroupDiagrams } = require('../src/design/architecture-group');
const { renderModuleSymbol, connectionPreview, signalKind, isClockLike } = require('../src/design/architecture-details');

test('报文汇聚简图保留独立实例、标签网络和架构握手证据，导出按章节跳转', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-book-'));
    t.after(async () => {
        if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === base) await fs.rm(workspace, { recursive: true, force: true });
    });
    const fixture = path.join(__dirname, '../example/struct-packet-hub');
    for (const name of ['channels.sv', 'blocks.sv', 'packet_hub.sv', 'svtools.architecture.json']) {
        await fs.copyFile(path.join(fixture, name), path.join(workspace, name));
    }
    const configPath = path.join(workspace, 'svtools.architecture.json');
    const presentation = JSON.parse(await fs.readFile(configPath, 'utf8'));
    presentation.walkthroughs = { packet_hub: { steps: [
        { title: '仲裁 <输出>', description: '核对仲裁到 FIFO 的连接。', links: ['arbitrated', 'stale_link'] },
    ], clockResets: { clk: 'rst_n', invalid_clk: 'rst_n' } } };
    presentation.designDocs = { packet_fifo: 'design.md' };
    const designDoc = path.join(workspace, 'design.md');
    const designText = '# FIFO 设计契约\n\n**出队顺序**按仲裁结果。\n\n[附件](https://example.invalid/contract) ![时序](https://example.invalid/wave.png)\n\n<script>globalThis.executed = true</script>\n';
    await fs.writeFile(designDoc, designText);
    await fs.writeFile(configPath, JSON.stringify(presentation));
    const loaded = await buildArchitectureBook(await resolveContext({ workspace, top: 'packet_hub' }));
    const [top] = loaded.book.pages;
    assert.equal(top.auto, 'overview');
    const fifo = top.nodes.find(node => node.name === 'u_fifo');
    assert.equal(top.parent, null);
    assert.equal(top.number, '1');
    const child = loaded.book.pages.find(page => page.id === fifo.chapter);
    assert.equal(child.parent, top.id);
    assert.match(child.number, /^1\.\d+$/u);
    assert.equal(child.depth, 1);
    assert.equal(top.designDoc, undefined);
    assert.equal(child.designDoc.path, 'design.md');
    assert.equal(child.designDoc.sha256, createHash('sha256').update(designText).digest('hex'));
    assert.deepEqual(fifo.parameters, { DEPTH: 32 });
    assert.equal(loaded.book.pages.find(page => page.id === fifo.chapter).auto, 'detailed');
    const link = top.links.find(link => link.name === 'arbitrated');
    assert.deepEqual(top.walkthrough.steps[0].connections, [{ name: 'arbitrated', id: link.id }, { name: 'stale_link', id: null }]);
    assert.deepEqual(top.walkthrough.clockResets, { clk: 'rst_n' });
    assert.equal(link.handshake, true);
    assert.deepEqual(link.endpoints.map(endpoint => endpoint.name), ['u_arbiter.selected', 'u_fifo.enqueue']);
    assert.deepEqual(link.members.map(({ name, width, flow }) => [name, width, flow]),
        [['payload', 32, 'forward'], ['lane', 2, 'forward'], ['last', 1, 'forward'], ['valid', 1, 'forward'], ['ready', 1, 'reverse']]);
    assert.deepEqual(link.members.at(-1).drivers, [1]);
    const preview = connectionPreview(link, { node: fifo.id, port: 'enqueue' });
    assert.match(preview, /<th>u_fifo\.enqueue<small>sink<\/small><\/th>/u);
    assert.match(preview, /<code>payload<\/code><\/td><td>32<\/td><td>input<\/td>/u);
    assert.match(preview, /<code>ready<\/code><\/td><td>1<\/td><td>output<\/td>/u);
    assert.ok(!preview.includes('u_arbiter.selected'), '端口预览只展示所指端口的 modport 方向');
    assert.match(connectionPreview(link), /<th>u_arbiter\.selected<small>source/u);
    const site = loaded.sourceLocations.get(link.endpoints[1].binding.id);
    assert.match((await fs.readFile(site.path, 'utf8')).split(/\r?\n/u)[site.line - 1], /\.enqueue\(arbitrated\)/u);
    const adc = top.links.find(link => link.name === 'adc0');
    assert.equal(adc.endpoints.length, 3);
    assert.equal(adc.handshake, false);
    assert.deepEqual(adc.routes, []);
    const overview = diagramTopology(top, 'overview');
    assert.equal(overview.cards.find(card => card.nodes.some(node => node.name === 'u_lane0')).nodes.length, 4);
    assert.equal(overview.cards.some(card => card.title === 'clk'), false);
    const detailed = diagramTopology(top, 'detailed');
    assert.equal(detailed.cards.find(card => card.nodes.some(node => node.name === 'u_lane0')).nodes.length, 1);
    assert.equal(detailed.cards.some(card => card.nodes.some(node => node.name === 'clk')), true);
    assert.ok(detailed.edges.length > overview.edges.length);
    const idle = { id: 'boundary:idle', kind: 'boundary', name: 'idle', direction: 'input', ports: [{ name: 'idle', direction: 'input' }] };
    const withIdle = { ...top, nodes: [...top.nodes, idle] };
    assert.ok(!diagramTopology(withIdle, 'overview').cards.some(card => card.nodes.includes(idle)));
    assert.ok(diagramTopology(withIdle, 'detailed').cards.some(card => card.nodes.includes(idle)));
    const detailedLayout = await layoutDiagram(top, 'detailed');
    // 详细连接把边界端口合并成端口排：每个端口是排里的一行，连线从行锚点出发。
    const clockPad = detailedLayout.cards.find(card => card.kind === 'pad' && card.rows.some(row => row.node.name === 'clk'));
    assert.ok(clockPad, '详细连线应把边界端口收进端口排');
    assert.equal(clockPad.edgeSide, 'left');
    const clockRow = clockPad.rows.find(row => row.node.name === 'clk');
    const padEdges = detailedLayout.edges.filter(edge => edge.from === clockPad.id);
    assert(padEdges.length > 1);
    const rowStarts = new Set(clockPad.rows.map(row => JSON.stringify({ x: clockPad.x + row.x, y: clockPad.y + row.y })));
    for (const edge of padEdges) {
        assert.ok(rowStarts.has(JSON.stringify(edge.sections[0].startPoint)), '端口排连线必须从行锚点出发');
    }
    assert.ok(padEdges.some(edge => edge.sections[0].startPoint.y === clockPad.y + clockRow.y), 'clk 行必须接线');
    const svg = renderDiagram(await layoutDiagram(top, top.auto), top, true);
    assert.match(svg, /data-node="instance:u_fifo"/u);
    assert.match(svg, /data-edge=.+?arbitrated/u);
    const out = await exportArchitecture(loaded, 'html', { out: 'architecture.html' });
    const html = await fs.readFile(out, 'utf8');
    assert.ok(html.includes(`href="#${fifo.chapter}"`));
    assert.ok(html.includes(`id="${fifo.chapter}"`));
    assert.match(html, /class="chapter-children"><section class="chapter"/u);
    assert.match(html, /<h3 class="chapter-heading">/u);
    assert.ok(html.includes(`<template id="preview-${link.id}:${fifo.id}:enqueue">`));
    assert.match(svg, /data-preview-link="module-\d+-link-\d+"/u);
    assert.ok(html.includes(`href="#${link.id}"`));
    assert.match(html, /<code>u_fifo\.enqueue<\/code> → <code>u_arbiter\.selected<\/code>/u);
    assert.match(html, /<figure class="module-symbol" aria-label="packet_fifo #\(DEPTH=32\) 端口图"/u);
    assert.match(html, /<a class="module-pin module-interface-pin" href="#module-\d+-link-\d+"[^>]*><span class="module-bus-symbol"[^>]*><\/span>\s*<span class="module-interface-label">\s*<strong><code>enqueue<\/code>/u);
    assert.match(html, /id="chapter-filter"/u);
    assert.ok(html.includes(`id="${child.id}-design-doc" data-print-open>`));
    assert.match(html, /<strong>出队顺序<\/strong>/u);
    assert.match(html, /附件 <code>https:\/\/example\.invalid\/contract<\/code>/u);
    assert.doesNotMatch(html, /<(?:img|a)[^>]+https:\/\/example\.invalid/u);
    assert.ok(!html.includes('<script>globalThis.executed'));
    assert.match(html, /仲裁 &lt;输出&gt;/u);
    assert.match(html, /<code>stale_link<\/code> <span[^>]+>未定位<\/span>/u);
    assert.match(html, /<th scope="row">CLK <code>clk<\/code><\/th><td><code>clk（本章边界）<\/code><\/td><td>[^]*?<code>u_fifo\.clk<\/code>/u);
    assert.match(html, /data-interface-filter/u);
    assert.match(html, /class="connection-panel"[^>]* hidden/u);
    assert.doesNotMatch(html, />接口目录</u);
    assert.ok(html.includes(`data-print-open id="${link.id}"><summary>`));
    const printed = await renderArchitectureBook(loaded.book, undefined, { print: true });
    assert.ok(printed.includes(`data-print-open id="${link.id}" open><summary>`));
    assert.match(printed, /class="book-detail book-stubs" data-print-open open/u);
    assert.ok(printed.includes(`id="${child.id}-design-doc" data-print-open open>`));
    assert.doesNotMatch(printed, /<button[^>]+data-walkthrough-step/u);
    assert.ok(!printed.includes('<script>'));
    assert.ok(!printed.includes('<template'), '打印报告不嵌入交互预览副本');
    const pinCount = markup => (markup.match(/schematic-pin/g) || []).length;
    const forced = await exportArchitecture(loaded, 'html', { out: 'architecture-detailed.html', modes: { [top.id]: 'detailed' } });
    const forcedHtml = await fs.readFile(forced, 'utf8');
    assert.ok(pinCount(forcedHtml) > pinCount(html));
    // 图2 式边界端口：不带外框，直接是端口符号 + 名称。
    assert.match(forcedHtml, /<g class="diagram-card pad left"[^>]*><title>[^<]*模块边界[^<]*<\/title><g class="pad-row/u);
    assert.match(forcedHtml, /class="pad-pin-shape"/u);
    assert.match(forcedHtml, /<text class="pad-name"[^>]*>clk<\/text>/u);
    const anchors = new Set([...forcedHtml.matchAll(/\sid="([^"]+)"/gu)].map(([, id]) => id));
    const missing = [...forcedHtml.matchAll(/\shref="#([^"]+)"/gu)].map(([, id]) => id).filter(id => !anchors.has(id));
    assert.deepEqual(missing, [], '完整连线导出的图内跳转必须有目标');
    const invalid = await exportArchitecture(loaded, 'html', { out: 'architecture-invalid.html', modes: { [top.id]: 'bogus' } });
    assert.equal(pinCount(await fs.readFile(invalid, 'utf8')), pinCount(html));
    const args = ['design', 'export', '--workspace', workspace, '--top', 'packet_hub', '--out', 'cli-architecture.html'];
    const cli = await run(args);
    assert.equal(cli.exitCode, 0);
    assert.equal(cli.output.operation, 'design.export');
    assert.equal(cli.output.data.chapterCount, loaded.book.pages.length);
    assert.equal(cli.output.data.revision, loaded.book.revision);
    assert.deepEqual(cli.output.data.designDocs, [{ module: 'packet_fifo', path: 'design.md', sha256: child.designDoc.sha256 }]);
    const artifact = cli.output.artifacts[0];
    assert.equal(await fs.readFile(artifact.path, 'utf8'), html);
    assert.equal(artifact.sha256, createHash('sha256').update(html).digest('hex'));
    assert.equal((await run(args)).output.diagnostics[0].code, 'EEXIST');
    await fs.appendFile(designDoc, '更新了设计约定。\n');
    await assert.rejects(assertBookCurrent(loaded), { code: 'CONTEXT_CHANGED' });
    const updated = await buildArchitectureBook(await resolveContext({ workspace, top: 'packet_hub' }));
    assert.notEqual(updated.book.revision, loaded.book.revision);
    await fs.writeFile(configPath, JSON.stringify({ ...presentation, designDocs: { packet_fifo: '../other.md' } }));
    const outside = await run([...args.slice(0, -1), 'rejected.html']);
    assert.equal(outside.output.diagnostics[0].code, 'INVALID_PATH');
    await fs.writeFile(path.join(workspace, 'svtools.architecture.json'), '{}');
    await assert.rejects(assertBookCurrent(updated), /已修改/u);
});

test('架构文档标出子模块接口的多个输出端，并在读取 XPR 之前拒绝用真实工程导出', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-export-'));
    t.after(async () => {
        if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === base) await fs.rm(workspace, { recursive: true, force: true });
    });
    await fs.writeFile(path.join(workspace, 'top.sv'), `interface events;
    logic irq;
    modport producer(output irq);
endinterface
module owner(events.producer signal_out, output stub_flag); endmodule
module subsystem;
    events shared();
    owner x(.signal_out(shared));
    owner y(.signal_out(shared));
endmodule
module top;
    subsystem child();
endmodule
`);
    const args = ['design', 'export', '--workspace', workspace, '--top', 'top'];
    const exported = await run([...args, '--format', 'html', '--out', 'review.html']);
    assert.equal(exported.exitCode, 0);
    const found = exported.output.diagnostics.find(item => item.code === 'ARCH_INTERFACE_MULTI_DRIVER');
    assert.deepEqual(found?.details, { interface: 'shared', members: [{ name: 'irq', outputs: ['x.signal_out', 'y.signal_out'] }] });
    assert.equal(found.chapter, 'module-2');
    const html = await fs.readFile(exported.output.data.path, 'utf8');
    assert.match(html, /<span class="chapter-index">1\.1\.1<\/span>/u);
    assert.match(html, /<h4 class="chapter-heading">owner<\/h4>/u);
    assert.match(html, /成员 irq 声明了多个输出端/u);
    assert.match(html, /实现桩待实现输出 · 1/u);
    assert.match(html, /href="#module-2-checks">subsystem<\/a> · \d+ 条待复核/u);
    const invalid = await run([...args, '--format', 'pdf', '--out', 'review.html']);
    assert.equal(invalid.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    await fs.writeFile(path.join(workspace, 'hardware.xpr'), 'invalid fixture');
    for (const selection of [[], ['--project', 'hardware.xpr']]) {
        const rejected = await run([...args, ...selection]);
        assert.equal(rejected.output.diagnostics[0].code, 'INVALID_ARGUMENT');
        assert.match(rejected.output.diagnostics[0].message, /伪 SystemVerilog/u);
    }
});

test('小型子模块显示完整连接，接口宽度按实例参数解析，边界保留可确定的位宽', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-hierarchy-'));
    t.after(async () => {
        if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === base) await fs.rm(workspace, { recursive: true, force: true });
    });
    const stages = Array.from({ length: 7 }, (_, i) =>
        `relay u_stage_${i}(.data_in(${i === 0 ? 'data_in' : `steps[${i - 1}]`}), .data_out(steps[${i}]));`).join('\n    ');
    const source = `interface channel #(parameter int W=8);
    logic [W-1:0] payload, metadata;
    logic valid, ready;
    modport tx (output payload, metadata, valid, input ready);
    modport rx (input payload, metadata, valid, output ready);
endinterface
module producer(channel.tx send); ... endmodule
module consumer(channel.rx receive); ... endmodule
module pipeline #(parameter int W=9);
    channel #(W) wire_between();
    producer u_producer(.send(wire_between));
    consumer u_consumer(.receive(wire_between));
endmodule
module relay(input logic data_in, output logic data_out);
    assign data_out = data_in;
endmodule
module dense(input logic data_in, output logic data_out);
    wire [6:0] steps;
    ${stages}
    assign data_out = steps[6];
endmodule
module top;
    pipeline #(.W(16)) u_pipe();
    dense u_dense(.data_in(1'b0), .data_out());
endmodule
`;
    await fs.writeFile(path.join(workspace, 'top.sv'), source);
    const { book } = await buildArchitectureBook(await resolveContext({ workspace, top: 'top' }));
    const [top, child, producer] = book.pages;
    assert.equal(top.nodes[0].chapter, child.id);
    assert.equal(child.hasStructure, true);
    assert.equal(child.auto, 'detailed');
    const dense = book.pages.find(page => page.name === 'dense');
    assert.equal(top.nodes[1].chapter, dense.id);
    assert.equal(dense.hasStructure, true);
    assert.equal(dense.auto, 'overview');
    assert.equal(producer.hasStructure, false);
    assert.equal(book.pages.find(page => page.name === 'relay').hasStructure, false);
    assert.deepEqual(child.parameters, { W: 16 });
    const connected = child.links.find(link => link.name === 'wire_between');
    assert.equal(connected.handshake, true);
    assert.deepEqual(connected.members.map(member => member.width), [16, 16, 1, 1]);
    assert.deepEqual(producer.links[0].members.map(member => member.width), [undefined, undefined, 1, 1]);
    const detailed = await layoutDiagram(child, child.auto);
    assert.equal(detailed.edges.length, 1);
    const [edge] = detailed.edges;
    const [from, to] = [edge.from, edge.to].map(cardId => detailed.cards.find(card => card.id === cardId));
    const [sourcePin, targetPin] = [from.pins.find(pin => pin.port.name === edge.fromPort), to.pins.find(pin => pin.port.name === edge.toPort)];
    assert.deepEqual([sourcePin.port.name, targetPin.port.name], ['send', 'receive']);
    const [section] = edge.sections;
    assert.deepEqual(section.startPoint, { x: from.x + sourcePin.x, y: from.y + sourcePin.y });
    assert.deepEqual(section.endPoint, { x: to.x + targetPin.x, y: to.y + targetPin.y });
    assert.match(renderDiagram(detailed, child, true), /class="schematic-pin"/u);
    assert.equal((await layoutDiagram(producer, producer.auto)).width, 0);
});

test('简图展开分组后按实例绘制真实的组内连线', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-'));
    t.after(async () => {
        if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === base) await fs.rm(workspace, { recursive: true, force: true });
    });
    // ep 实例被折进同一张分组卡片，两者之间的接口必须出现在卡片脚注，而不是消失。
    await fs.writeFile(path.join(workspace, 'grouped.sv'), `
interface link_if;
    logic [7:0] data;
    logic       valid;
    modport src (output data, output valid);
    modport dst (input data, input valid);
endinterface
module leaf(link_if.src out, output logic done); ... endmodule
module sink(link_if.dst in, input logic done); ... endmodule
module top;
    link_if inner();
    logic done;
    leaf u_leaf(.out(inner), .done(done));
    sink u_sink(.in(inner), .done(done));
endmodule
`);
    await fs.writeFile(path.join(workspace, 'svtools.architecture.json'),
        JSON.stringify({ groups: { top: { u_leaf: '成对通路', u_sink: '成对通路' } } }));
    const { book } = await buildArchitectureBook(await resolveContext({ workspace, top: 'top' }));
    const [top] = book.pages;
    const { cards, edges } = diagramTopology(top, 'overview');
    const card = cards.find(item => item.title === '成对通路');
    assert.ok(card, '分组卡片必须存在');
    assert.deepEqual(card.internal.map(item => item.name).sort(), ['done', 'inner'], '组内连接必须记入卡片');
    assert.equal(card.internal.find(item => item.name === 'inner').kind, 'interface');
    assert.equal(card.internal.find(item => item.name === 'done').kind, 'signal');
    assert.ok(card.internal.every(item => item.ends.length === 2), '每条连接记下两个端点实例');
    assert.ok(!edges.some(edge => edge.links.some(id => top.links.find(link => link.id === id)?.name === 'inner')), '组内束不应再画成自环');
    const overview = await layoutDiagram(top, 'overview');
    const svg = renderDiagram(overview, top, false);
    assert.match(svg, /class="card-foot internal" data-expand="[^"]+"[^>]*>[^]*?组内连接 2 条/u);
    const group = (await renderGroupDiagrams(overview, top, false))[card.id];
    assert.equal(group.connections, 2);
    assert.equal((group.html.match(/class="diagram-card instance/g) || []).length, 2);
    assert.match(group.html, /class="diagram-edge bus"[^>]*><title>inner<\/title>/u);
    assert.match(group.html, /class="diagram-edge signal"[^>]*><title>done<\/title>/u);
    const html = await renderArchitectureBook({ ...book, pages: [{ ...top, auto: 'overview' }, ...book.pages.slice(1)] });
    assert.ok(html.includes(`<template id="group-${top.id}-${card.id}" data-title="成对通路" data-instances="2" data-connections="2">`));
});

test('全双工接口按 modport 角色名与驱动位宽判定主流向，多端共享束逐成员连线', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-flow-'));
    t.after(async () => {
        if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === base) await fs.rm(workspace, { recursive: true, force: true });
    });
    // 两端都驱动成员（AXI 式全双工），不能只凭 valid 判方向；多端共享束按成员逐条出通路。
    await fs.writeFile(path.join(workspace, 'flow.sv'), `
interface axi_like_if;
    logic [31:0] addr, wdata, rdata;
    logic        awvalid, awready, arvalid, arready;
    modport master (output addr, wdata, awvalid, arvalid, input rdata, awready, arready);
    modport slave  (input addr, wdata, awvalid, arvalid, output rdata, awready, arready);
endinterface
interface irq_if;
    logic a_irq, b_irq;
    modport src_a (output a_irq);
    modport src_b (output b_irq);
    modport sink  (input a_irq, b_irq);
endinterface
module src_a(irq_if.src_a irq); ... endmodule
module src_b(irq_if.src_b irq); ... endmodule
module host(axi_like_if.master m, irq_if.sink irq); ... endmodule
module device(axi_like_if.slave s); ... endmodule
module top;
    axi_like_if host_bus();     // 单从设备：两端都驱动成员，角色名才能决定主流向
    irq_if irqs();              // 三端共享束：两个源汇入一个 sink
    host   u_host(.m(host_bus), .irq(irqs));
    device u_device(.s(host_bus));
    src_a  u_src_a(.irq(irqs));
    src_b  u_src_b(.irq(irqs));
endmodule
`);
    const snapshot = await resolveContext({ workspace, top: 'top' });
    const { book } = await buildArchitectureBook(snapshot);
    const [top] = book.pages;
    // 结构层（struct）与页面模型必须给出同一份束级方向证据，否则同一接口在两个视图里会互相矛盾。
    const files = [...snapshot.contents].map(([path, item]) => ({ path, text: item.text }));
    const shared = new Map(interfaceEvidence(analyzeStructure({ workspace, files, top: 'top' }).parsed).map(item => [item.key, item]));
    for (const link of top.links.filter(item => item.kind === 'interface')) {
        assert.ok(shared.has(link.name), link.name + ' 缺少结构层证据');
        assert.equal(link.flowEvidence, shared.get(link.name).flowEvidence, link.name + ' 两处方向证据应一致');
        assert.equal(link.handshake, shared.get(link.name).handshake, link.name + ' 两处握手结论应一致');
    }
    const bus = top.links.find(link => link.name === 'host_bus');
    // 两端各驱动一部分成员，因此不是"单一驱动端"，要靠角色名 master/slave 定主流向。
    assert.equal(bus.flowEvidence, 'role');
    assert.deepEqual(bus.routes.map(route => [route.source, route.target]), [[0, 1]], 'master 应作为驱动端');
    const irqs = top.links.find(link => link.name === 'irqs');
    assert.equal(irqs.routes.length > 0, true, '三端共享束必须给出逐成员通路，不能整条判为未知');
    assert.equal(irqs.members.length, 2);
    const unknown = top.links.filter(link => link.kind === 'interface' && !link.routes.length);
    assert.deepEqual(unknown.map(link => link.name), [], '所有接口束都应有可解释的流向');
});

test('简图分组卡片沿用模块框并排列对外接口端口', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-ports-'));
    t.after(async () => {
        if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === base) await fs.rm(workspace, { recursive: true, force: true });
    });
    // 组内实例清单对读者没有信息量：关心的是这一组对外接了哪些通道。
    // 这里 deliberately 让「数据通路」组对外连一条 status 总线和一个使能信号。
    await fs.writeFile(path.join(workspace, 'ports.sv'), `
interface link_if;
    logic [7:0] data;
    modport src (output data);
    modport dst (input data);
endinterface
module producer(link_if.src out, input clk, output logic [3:0] status); ... endmodule
module consumer(link_if.dst in, input clk); ... endmodule
module observer(input logic [3:0] status, input logic enable); ... endmodule
module top(input clk, input enable);
    link_if inner();
    wire [3:0] status;
    producer u_producer(.out(inner), .clk(clk), .status(status));
    consumer u_consumer(.in(inner), .clk(clk));
    observer u_observer(.status(status), .enable(enable));
endmodule
`);
    await fs.writeFile(path.join(workspace, 'svtools.architecture.json'), JSON.stringify({ groups: { top: {
        u_producer: '数据通路', u_consumer: '数据通路', u_observer: '外部观察' } } }));
    const { book } = await buildArchitectureBook(await resolveContext({ workspace, top: 'top' }));
    const [top] = book.pages;
    const diagram = await layoutDiagram(top, 'overview');
    const card = diagram.cards.find(item => item.title === '数据通路');
    assert.ok(card, '分组卡片必须存在');
    assert.equal(card.nodes.length > 1, true, '两张实例应折进同一张分组卡片');
    assert.equal(card.groupPorts.length > 0, true, '分组卡片必须列出对外端口');
    assert.equal(card.entries.length, 0, '分组卡片不再保留组内实例清单');
    const svg = renderDiagram(diagram, top, false);
    assert.match(svg, /class="group-port-label"/u, '分组卡片要画出对外端口');
    assert.match(svg, /class="card-members" data-members="[^"]+"[^>]*>[^]*?2 个实例/u, '副标题打开组内互联图');
    assert.equal(/class="node-entry"/u.test(svg), false, '分组卡片卡体不再罗列组内实例');
    const group = (await renderGroupDiagrams(diagram, top, false))[card.id];
    assert.equal(group.connections, 1, '组外驱动两个接收端的共享时钟不会伪装为组内连接');
    assert.doesNotMatch(group.html, />u_observer</u, '组外实例不会出现在局部图内');
    assert.match(group.html, /<a href="#module-\d+"><g class="diagram-card instance/u, '实例卡链到各自章节');
    const groupStart = svg.lastIndexOf('<g class="diagram-card instance', svg.indexOf('2 个实例'));
    assert.equal(svg.slice(Math.max(0, groupStart - 40), groupStart).includes('<a href'), false, '分组卡不再包成第一个成员的章节链接');
});

test('超宽流水通路自动折行并保留完整连接模式', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-wrap-'));
    t.after(async () => {
        assert.equal(await fs.realpath(workspace), workspace);
        assert.equal(path.dirname(workspace), base);
        await fs.rm(workspace, { recursive: true, force: true });
    });
    const connections = Array.from({ length: 6 }, (_, index) => `channel mid_${index}();`).join('\n');
    const stages = Array.from({ length: 7 }, (_, index) => `stage u_stage_${index}(
        .data_in(${index === 0 ? 'data_in' : 'mid_' + (index - 1)}),
        .data_out(${index === 6 ? 'data_out' : 'mid_' + index}), .clk(clk));`).join('\n');
    await fs.writeFile(path.join(workspace, 'pipeline.sv'), `
interface channel;
    logic [31:0] data;
    modport master(output data);
    modport slave(input data);
endinterface
module stage(channel.slave data_in, channel.master data_out, input clk); ... endmodule
module top(input clk, channel.slave data_in, channel.master data_out);
    ${connections}
    ${stages}
endmodule
`);
    await fs.writeFile(path.join(workspace, 'svtools.architecture.json'), JSON.stringify({
        titles: { stage: '视频处理流水级（输入帧同步、像素整形与事务传递）' },
    }));
    const { book } = await buildArchitectureBook(await resolveContext({ workspace, top: 'top' }));
    const [top] = book.pages;
    const compact = await layoutDiagram(top, 'overview');
    assert.equal(compact.wrapped, true);
    assert.ok(compact.width <= 1400, '折行后的流水线应在内容列里保持可读字号');
    assert.equal(compact.cards.filter(card => card.kind === 'instance').length, 7);
    const covered = new Set(compact.edges.flatMap(edge => edge.links));
    assert.ok(top.links.every(link => covered.has(link.id)), '折行必须保留每条数据与时钟连接');
    assert.ok(compact.edges.every(edge => edge.sections.length > 0));
    const detailed = await layoutDiagram(top, 'detailed');
    assert.equal(detailed.wrapped, false);
    assert.ok(detailed.width > compact.width);
});

test('简图以可追溯的同名标签保留时钟复位，详细图保留端到端走线', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-clock-'));
    t.after(async () => {
        if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === base) await fs.rm(workspace, { recursive: true, force: true });
    });
    // 时钟/复位曾被当作 labeled 网络整体从简图过滤，导致 clkrst 卡片零连线，
    // 看起来像时钟域没接。它们必须画成可见的时钟域通道。
    await fs.writeFile(path.join(workspace, 'clock.sv'), `
module clkrst(input ref_clk, output gp_clk, output gp_rst);
    assign gp_clk = ref_clk;
    assign gp_rst = ref_clk;
endmodule
module worker(input gp_clk, input gp_rst); ... endmodule
module filler(input gp_clk, input gp_rst); ... endmodule
module top(input ref_clk);
    wire gp_clk, gp_rst;
    clkrst u_clkrst(.ref_clk(ref_clk), .gp_clk(gp_clk), .gp_rst(gp_rst));
    worker u_worker(.gp_clk(gp_clk), .gp_rst(gp_rst));
    filler u_filler(.gp_clk(gp_clk), .gp_rst(gp_rst));
endmodule
`);
    await fs.writeFile(path.join(workspace, 'svtools.architecture.json'),
        JSON.stringify({ groups: { top: { u_clkrst: '时钟分发', u_worker: '业务通路', u_filler: '业务通路' } } }));
    const { book } = await buildArchitectureBook(await resolveContext({ workspace, top: 'top' }));
    const [top] = book.pages;
    const clockLinks = top.links.filter(link => link.labeled);
    assert.equal(clockLinks.length > 0, true, 'fixture 必须含时钟/复位网络');
    const { cards, edges } = diagramTopology(top, 'overview');
    const clock = edges.filter(edge => edge.clock);
    assert.equal(clock.length > 0, true, '时钟网络必须画成可见的时钟域边');
    const clkrst = cards.find(item => item.title === '时钟分发');
    assert.equal(clock.some(edge => edge.from === clkrst.id || edge.to === clkrst.id), true,
        '时钟分发卡片必须有时钟边相连，不能是孤岛');
    const between = clock.filter(edge => [edge.from, edge.to].includes(clkrst.id));
    const covered = new Set(between.flatMap(edge => edge.links));
    assert.ok(clockLinks.every(link => covered.has(link.id)), '标签须保留每个时钟/复位网络的身份');
    const diagram = await layoutDiagram(top, 'overview');
    assert.ok(diagram.clockRegion, '仅依赖时钟的模块应集中显示');
    assert.ok(diagram.edges.every(edge => !edge.clockOnly || edge.sections.length === 2), '同名标签的两端都要有接线');
    const svg = renderDiagram(diagram, top, false);
    assert.match(svg, /class="diagram-edge clock"/u, '时钟域边要有独立样式');
    assert.match(svg, /class="edge-hit clock-hit"/u, 'HTML 导出的短引线也可在笔画之外响应悬浮');
    assert.match(svg, /时钟 \/ 复位 · 同名标签连接/u);
    assert.match(svg, /class="clock-row" data-clock="/u, '时钟网络带联动标记');
    const detailed = await layoutDiagram(top, 'detailed');
    assert.ok(detailed.edges.every(edge => !edge.clockOnly), '详细连线保持端到端接线');
    assert.ok(!detailed.clockRegion);
});

test('时钟/复位每个网络是一行端口：不截断、贴边圆点、带联动标记', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-clocks-'));
    t.after(async () => {
        if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === base) await fs.rm(workspace, { recursive: true, force: true });
    });
    await fs.writeFile(path.join(workspace, 'many.sv'), `
module sink(input clk_alpha, input clk_beta, input clk_gamma, input clk_delta, input clk_epsilon,
            input clk_zeta, input rst_alpha, input rst_beta); ... endmodule
module top(input clk_alpha, input clk_beta, input clk_gamma, input clk_delta, input clk_epsilon,
           input clk_zeta, input rst_alpha, input rst_beta);
    sink u_sink(.clk_alpha(clk_alpha), .clk_beta(clk_beta), .clk_gamma(clk_gamma), .clk_delta(clk_delta),
        .clk_epsilon(clk_epsilon), .clk_zeta(clk_zeta), .rst_alpha(rst_alpha), .rst_beta(rst_beta));
endmodule`);
    const { book } = await buildArchitectureBook(await resolveContext({ workspace, top: 'top' }));
    const [top] = book.pages;
    const svg = renderDiagram(await layoutDiagram(top, 'overview'), top, false);
    assert.doesNotMatch(svg, /\+[0-9]+<\/tspan>/u, '不再用 +N 截断');
    const rows = (svg.match(/class="clock-foot"/gu) || []).length;
    assert.equal(rows, 8, '每个时钟/复位网络占一行端口：' + rows);
    assert.equal((svg.match(/class="clock-pin"/gu) || []).length, 8, '每个网络一个贴边圆点');
    for (const name of ['clk_alpha', 'clk_zeta', 'rst_alpha', 'rst_beta']) {
        assert.match(svg, new RegExp('data-clock="' + name + '"', 'u'), name + ' 必须完整出现');
    }
});

test('简图将输入输出接口分置边界两侧，每条接口在模块上有独立落点', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-anchors-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    await fs.writeFile(path.join(workspace, 'ports.sv'), `
interface channel;
    logic [7:0] data;
    modport master(output data);
    modport slave(input data);
endinterface
module core(channel.master out0, channel.master out1, channel.slave in0, channel.slave in1,
            channel.master mid0, channel.master mid1);
    ...
endmodule
module sink(channel.slave in0, channel.slave in1); ... endmodule
module top(channel.master out0, channel.master out1, channel.slave in0, channel.slave in1);
    channel mid0();
    channel mid1();
    core child(.out0(out0), .out1(out1), .in0(in0), .in1(in1), .mid0(mid0), .mid1(mid1));
    sink receiver(.in0(mid0), .in1(mid1));
endmodule
`);
    const { book } = await buildArchitectureBook(await resolveContext({ workspace, top: 'top' }));
    const [top] = book.pages;
    const diagram = await layoutDiagram(top, 'overview');
    const core = diagram.cards.find(card => card.nodes.some(node => node.name === 'child'));
    assert.equal(core.groupLayout.length, 6);
    const anchors = new Set(core.groupLayout.map(port => `${port.x},${port.y}`));
    assert.equal(anchors.size, 6, '不同接口不可叠在同一个接线点');
    const receiver = diagram.cards.find(card => card.nodes.some(node => node.name === 'receiver'));
    const internal = diagram.edges.filter(edge => edge.from === core.id && edge.to === receiver.id);
    assert.equal(internal.length, 2, '模块间的不同接口束应各自落到具名端口');
    for (const card of diagram.cards.filter(card => card.kind === 'pad')) {
        for (const node of card.nodes) {
            assert.equal(card.edgeSide, node.ports[0].type.endsWith('.master') ? 'right' : 'left');
        }
    }
    for (const edge of diagram.edges) {
        assert.equal(edge.forward, true, '布局归一后仍应保留真实主流向');
        const first = edge.sections[0].startPoint;
        const last = edge.sections.at(-1).endPoint;
        assert.ok(first.x < last.x);
    }
});

test('端口图按声明方向归类，引脚可选择，名称中的标记按文本显示', () => {
    const markup = renderModuleSymbol('top', [
        { name: 'data<in>', direction: 'input', width: 16 },
        { name: 'ready', direction: 'output', width: 1 },
        { name: 'adc', direction: 'interface', type: 'sample_link.sink' },
        { name: 'adc_full', direction: 'interface', type: 'sample_link' },
        { name: 'request', direction: 'interface', type: 'axi_if.master' },
        { name: 'reply', direction: 'interface', type: 'axi_if.slave' },
        { name: 'state_ref', direction: 'ref', type: 'logic' },
        { name: 'flag', direction: 'inout', width: 1 },
    ], { interactive: true, selected: 'data<in>' });
    assert.match(markup, /group input[^]*?data-port="data&lt;in&gt;" aria-pressed="true"[^]*?16 位/u);
    const right = markup.match(/class="module-pin-group output"[^]*?<\/section>/u)?.[0];
    assert.match(right, /data-port="ready"[^]*?data-port="flag"[^]*?<span class="module-pin-direction" role="img" aria-label="双向">↔<\/span>/u);
    const inputs = markup.match(/class="module-pin-group input"[^]*?<\/section>/u)?.[0];
    assert.match(inputs, /data-port="adc"[^]*?sample_link · sink/u);
    assert.match(inputs, /data-port="adc_full"[^]*?sample_link · <span[^>]*>—/u);
    assert.match(right, /module-interface-pin master"[^>]*data-port="request"[^>]*>[^]*?class="module-interface-role">Master</u);
    assert.match(inputs, /module-interface-pin slave"[^>]*data-port="reply"[^>]*>[^]*?class="module-interface-role">Slave</u);
    const shared = markup.match(/class="module-pin-group shared"[^]*?<\/section>/u)?.[0];
    assert.match(shared, /data-port="state_ref"/u);
    assert.doesNotMatch(shared, /data-port="(?:adc|flag)"|双向/u);
});

test('同一网名在标签网络、卡底时钟行与图形层只有一个结论', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-clock-'));
    t.after(async () => { await fs.rm(workspace, { recursive: true, force: true }); });
    await fs.writeFile(path.join(workspace, 'clock.sv'), [
        'module clock_top(input logic sys_clk_div, input logic nrst, input logic clk_en, output logic done);',
        '    lane u_lane(.clk(sys_clk_div), .rst(nrst), .en(clk_en), .d(done));',
        'endmodule',
        'module lane(input logic clk, input logic rst, input logic en, output logic d);',
        '    assign d = clk & ~rst & en;',
        'endmodule',
        '',
    ].join('\n'));
    const snapshot = await resolveContext({ workspace, top: 'clock_top' });
    const { book } = await buildArchitectureBook(snapshot);
    const page = book.pages.find(item => item.name === 'clock_top');
    for (const name of ['sys_clk_div', 'nrst', 'clk_en']) {
        assert.equal(isClockLike(name), true, name + ' 应判为时钟/复位');
        assert.equal(page.links.find(item => item.name === name)?.labeled, true, name + ' 应进入标签网络');
    }
    const { edges } = diagramTopology(page, 'overview');
    const clockEdges = edges.filter(edge => edge.clock);
    assert.ok(clockEdges.length >= 3, '时钟/复位连线应进入时钟域');
    assert.ok(clockEdges.every(edge => edge.clockOnly), '时钟连线应全部标记为同名标签连接');
    assert.equal(isClockLike('ddr_init_done'), false);
});
test('端口图把时钟/复位折到卡底两行，列内不再重复', () => {
    const markup = renderModuleSymbol('demo', [
        { name: 'clk', direction: 'input', width: 1, type: 'logic' },
        { name: 'rst_n', direction: 'input', width: 1, type: 'logic' },
        { name: 'din', direction: 'input', width: 8, type: 'logic' },
        { name: 'dout', direction: 'output', width: 8, type: 'logic' },
    ], { interactive: true });
    assert.match(markup, /class="module-symbol-foot"/u);
    assert.match(markup, /class="clock-tag">CLK<\/span>[^]*?data-port="clk"/u);
    assert.match(markup, /class="clock-tag">RST<\/span>[^]*?data-port="rst_n"/u);
    assert.equal((markup.match(/data-port="clk"/gu) || []).length, 1, '时钟端口只出现在脚注里');
    assert.equal((markup.match(/data-port="rst_n"/gu) || []).length, 1, '复位端口只出现在脚注里');
    assert.match(markup, /class="module-symbol-meta">1 个输入 · 1 个输出/u, '副标题只数列内端口');
});
test('时钟复位短标签与接口预览保留真实名称和未知方向', () => {
    assert.equal(signalKind('hp_axi_aclk'), 'CLK');
    assert.equal(signalKind('gp_clk_rst'), 'RST');
    assert.equal(signalKind('s_axi_aresetn'), 'RST');
    assert.equal(signalKind('ddr_init_done'), '');
    const html = connectionPreview({ name: '<bus>', type: 'bus_if', kind: 'interface',
        endpoints: [{ name: 's', node: 'boundary:s', port: 's' }],
        members: [{ name: '<data>', directions: ['unknown'] }] });
    assert.match(html, /&lt;bus&gt;/u);
    assert.match(html, /&lt;data&gt;/u);
    assert.match(html, /未声明 modport/u);
    assert.match(html, /待确认/u);
    assert.ok(!html.includes('<bus>') && !html.includes('<data>'));
    assert.match(connectionPreview({ name: 'data', kind: 'signal',
        endpoints: [{ node: 'boundary:data', port: 'data' }], routes: [] }), /普通信号/u);
});
