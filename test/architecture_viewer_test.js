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
const { exportArchitecture, renderArchitectureBook } = require('../src/design/architecture-export');
const { renderModuleSymbol } = require('../src/design/architecture-details');

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
    const loaded = await buildArchitectureBook(await resolveContext({ workspace, top: 'packet_hub' }));
    const [top] = loaded.book.pages;
    assert.equal(top.auto, 'overview');
    const fifo = top.nodes.find(node => node.name === 'u_fifo');
    assert.deepEqual(fifo.parameters, { DEPTH: 32 });
    assert.equal(loaded.book.pages.find(page => page.id === fifo.chapter).auto, 'detailed');
    const link = top.links.find(link => link.name === 'arbitrated');
    assert.equal(link.handshake, true);
    assert.deepEqual(link.endpoints.map(endpoint => endpoint.name), ['u_arbiter.selected', 'u_fifo.enqueue']);
    assert.deepEqual(link.members.map(({ name, width, flow }) => [name, width, flow]),
        [['payload', 32, 'forward'], ['lane', 2, 'forward'], ['last', 1, 'forward'], ['valid', 1, 'forward'], ['ready', 1, 'reverse']]);
    assert.deepEqual(link.members.at(-1).drivers, [1]);
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
    const clock = detailedLayout.cards.find(card => card.nodes[0]?.name === 'clk');
    assert(clock.terminal.labelX < clock.terminal.left);
    const clockEdges = detailedLayout.edges.filter(edge => edge.from === clock.id);
    assert(clockEdges.length > 1);
    for (const edge of clockEdges) {
        assert.deepEqual(edge.sections[0].startPoint, { x: clock.x + clock.terminal.right, y: clock.y + clock.terminal.centerY });
    }
    const svg = renderDiagram(await layoutDiagram(top, top.auto), top, true);
    assert.match(svg, /data-node="instance:u_fifo"/u);
    assert.match(svg, /data-edge=.+?arbitrated/u);
    const out = await exportArchitecture(loaded, 'html', { out: 'architecture.html' });
    const html = await fs.readFile(out, 'utf8');
    assert.ok(html.includes(`href="#${fifo.chapter}"`));
    assert.ok(html.includes(`id="${fifo.chapter}"`));
    assert.ok(html.includes(`href="#${link.id}"`));
    assert.match(html, /<code>u_fifo\.enqueue<\/code> → <code>u_arbiter\.selected<\/code>/u);
    assert.match(html, /<figure class="module-symbol" aria-label="packet_fifo #\(DEPTH=32\) 端口图"/u);
    assert.match(html, /<a class="module-pin module-interface-pin" href="#module-\d+-link-\d+"[^>]*><span class="module-bus-symbol"[^>]*><\/span>\s*<span class="module-interface-label">\s*<strong><code>enqueue<\/code>/u);
    assert.match(html, /id="chapter-filter"/u);
    assert.ok(html.includes(`data-print-open id="${link.id}"><summary>`));
    const printed = await renderArchitectureBook(loaded.book, undefined, { print: true });
    assert.ok(printed.includes(`data-print-open id="${link.id}" open><summary>`));
    assert.match(printed, /class="book-detail book-stubs" data-print-open open/u);
    assert.ok(!printed.includes('<script>'));
    const pinCount = markup => (markup.match(/schematic-pin/g) || []).length;
    const forced = await exportArchitecture(loaded, 'html', { out: 'architecture-detailed.html', modes: { [top.id]: 'detailed' } });
    const forcedHtml = await fs.readFile(forced, 'utf8');
    assert.ok(pinCount(forcedHtml) > pinCount(html));
    assert.match(forcedHtml, /<polygon class="boundary-symbol"[^>]*\/><text class="boundary-caption"[^>]*>clk<\/text>/u);
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
    const artifact = cli.output.artifacts[0];
    assert.equal(await fs.readFile(artifact.path, 'utf8'), html);
    assert.equal(artifact.sha256, createHash('sha256').update(html).digest('hex'));
    assert.equal((await run(args)).output.diagnostics[0].code, 'EEXIST');
    await fs.writeFile(path.join(workspace, 'svtools.architecture.json'), '{}');
    await assert.rejects(assertBookCurrent(loaded), /已修改/u);
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
    assert.match(html, /成员 irq 声明了多个输出端/u);
    assert.match(html, /实现桩待实现输出 · 1/u);
    assert.match(html, /href="#module-2">subsystem<\/a> · \d+ 条待复核/u);
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

test('端口图按声明方向归类，引脚可选择，名称中的标记按文本显示', () => {
    const markup = renderModuleSymbol('top', [
        { name: 'data<in>', direction: 'input', width: 16 },
        { name: 'ready', direction: 'output', width: 1 },
        { name: 'adc', direction: 'interface', type: 'sample_link.sink' },
        { name: 'adc_full', direction: 'interface', type: 'sample_link' },
        { name: 'state_ref', direction: 'ref', type: 'logic' },
        { name: 'flag', direction: 'inout', width: 1 },
    ], { interactive: true, selected: 'data<in>' });
    assert.match(markup, /group input[^]*?data-port="data&lt;in&gt;" aria-pressed="true"[^]*?16 位/u);
    const right = markup.match(/class="module-pin-group output"[^]*?<\/section>/u)?.[0];
    assert.match(right, /data-port="ready"[^]*?data-port="flag"[^]*?<span class="module-pin-direction" role="img" aria-label="双向">↔<\/span>/u);
    const interfaces = markup.match(/class="module-pin-group interfaces"[^]*?<\/section>/u)?.[0];
    assert.match(interfaces, /data-port="adc"[^]*?sample_link · sink/u);
    assert.match(interfaces, /data-port="adc_full"[^]*?sample_link · 未声明 modport/u);
    const shared = markup.match(/class="module-pin-group shared"[^]*?<\/section>/u)?.[0];
    assert.match(shared, /data-port="state_ref"/u);
    assert.doesNotMatch(shared, /data-port="(?:adc|flag)"|双向/u);
});
