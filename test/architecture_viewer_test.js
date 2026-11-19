'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildArchitectureBook, resolveContext, assertBookCurrent } = require('../src/design/architecture-model');
const { diagramTopology, layoutDiagram, renderDiagram } = require('../src/design/architecture-diagram');
const { exportArchitecture } = require('../src/design/architecture-export');

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
    const svg = renderDiagram(await layoutDiagram(top, top.auto), top, true);
    assert.match(svg, /data-node="instance:u_fifo"/u);
    assert.match(svg, /data-edge=.+?arbitrated/u);
    const out = await exportArchitecture(loaded, 'html', { out: 'architecture.html' });
    const html = await fs.readFile(out, 'utf8');
    assert.ok(html.includes(`href="#${fifo.chapter}"`));
    assert.ok(html.includes(`id="${fifo.chapter}"`));
    assert.ok(html.includes(`href="#${link.id}"`));
    assert.match(html, /<code>u_fifo\.enqueue<\/code> → <code>u_arbiter\.selected<\/code>/u);
    await fs.writeFile(path.join(workspace, 'svtools.architecture.json'), '{}');
    await assert.rejects(assertBookCurrent(loaded), /已修改/u);
});

test('小型子模块显示完整连接，接口宽度按实例参数解析，边界保留可确定的位宽', async t => {
    const base = await fs.realpath(os.tmpdir());
    const workspace = await fs.mkdtemp(path.join(base, 'svtools-arch-hierarchy-'));
    t.after(async () => {
        if (await fs.realpath(workspace) === workspace && path.dirname(workspace) === base) await fs.rm(workspace, { recursive: true, force: true });
    });
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
module top;
    pipeline #(.W(16)) u_pipe();
endmodule
`;
    await fs.writeFile(path.join(workspace, 'top.sv'), source);
    const { book } = await buildArchitectureBook(await resolveContext({ workspace, top: 'top' }));
    const [top, child, producer] = book.pages;
    assert.equal(top.nodes[0].chapter, child.id);
    assert.equal(child.auto, 'detailed');
    assert.deepEqual(child.parameters, { W: 16 });
    const connected = child.links.find(link => link.name === 'wire_between');
    assert.equal(connected.handshake, true);
    assert.deepEqual(connected.members.map(member => member.width), [16, 16, 1, 1]);
    assert.deepEqual(producer.links[0].members.map(member => member.width), [undefined, undefined, 1, 1]);
    assert.equal(diagramTopology(child, child.auto).edges.length, 1);
});
