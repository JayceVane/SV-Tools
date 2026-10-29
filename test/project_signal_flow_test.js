'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { traceProjectSignal } = require('../src/project/signal-flow');
const { projectTree } = require('../src/project/tree-model');
const port = (direction, bits) => ({ direction, bits });
const cell = (type, connections) => ({ type, connections });
function design() {
    return fromYosys({ modules: { top: { attributes: { src: 'top.sv:1.1-1.20' }, ports: { a: port('input', [2, 3]), b: port('input', [4, 5]), y: port('output', [6, 7]), z: port('output', [8, 9]) }, cells: { u_a: cell('middle', { rx: [2, 3], tx: [6, 7] }), u_b: cell('middle', { rx: [4, 5], tx: [8, 9] }) } },
            middle: { attributes: { src: 'middle.sv:1.1-1.20' }, ports: { rx: port('input', [10, 11]), tx: port('output', [11, 10]) }, cells: { u_leaf: cell('leaf', { data: [10, 11], result: [11, 10] }) } },
            leaf: { attributes: { src: 'leaf.sv:1.1-1.20' }, ports: { data: port('input', [20, 21]), result: port('output', [21, 20]), tie: port('output', ['0']) }, netnames: { r_data: { bits: [20, 21], attributes: { src: 'leaf.sv:2.1-2.20' } } } } } }, { top: 'top' });
}
function target(model, side = 'u_a') {
    const top = model.modules.find(m => m.id === model.top), middle = model.modules.find(m => m.name === 'middle'), leaf = model.modules.find(m => m.name === 'leaf');
    return { moduleId: leaf.id, instancePath: [top.cells.find(c => c.name === side).id, middle.cells[0].id], origin: { objectId: leaf.signals[0].id, indices: [0] } };
}
test('三层端口改名、父级上溯及位重排使用实际网络，另一个同模块实例不会被同名误标', () => {
    const model = design(), result = traceProjectSignal(model, target(model));
    const flagged = result.nodes.filter(n => n.roles.length);
    assert.deepEqual(flagged.map(n => n.names.join('.')), ['', 'u_a', 'u_a.u_leaf']);
    assert.ok(flagged.at(-1).roles.includes('internal'));
    assert.deepEqual(flagged.at(-1).details.find(d => d.port === 'result').indices, [1]);
    assert.ok(result.edges.length >= 2);
    assert.equal(result.truncated, false);
    assert.ok(result.nodes.filter(n => n.names[0] === 'u_b').every(n => !n.roles.length));
});
test('常量只标记起点，不把所有相同常量判成同一网络', () => {
    const model = design(), request = target(model), leaf = model.modules.find(m => m.id === request.moduleId);
    request.origin = { objectId: leaf.ports.find(p => p.name === 'tie').id };
    const result = traceProjectSignal(model, request);
    assert.equal(result.edges.length, 0);
    assert.ok(result.nodes.find(node => node.id === JSON.stringify(request.instancePath)).roles.includes('output'));
    assert.ok(result.issues.some(issue => issue.includes('常量')));
});
test('穿过父级内部连线进入另一个模块，遇到组合逻辑后不伪造输出透传', () => {
    const model=fromYosys({modules:{top:{ports:{a:port('input',[2]),y:port('output',[3])},cells:{u_source:cell('source',{i:[2],o:[4]}),u_sink:cell('sink',{i:[4],o:[3]})}},
        source:{ports:{i:port('input',[10]),o:port('output',[10])}},
        sink:{ports:{i:port('input',[20]),o:port('output',[21])},cells:{inv:{type:'$not',port_directions:{A:'input',Y:'output'},connections:{A:[20],Y:[21]}}}}}},{top:'top'});
    const top=model.modules.find(module=>module.id===model.top),source=model.modules.find(module=>module.name==='source');
    const result=traceProjectSignal(model,{moduleId:source.id,instancePath:[top.cells.find(cell=>cell.name==='u_source').id],origin:{objectId:source.ports.find(port=>port.name==='o').id}});
    const sink=result.nodes.find(node=>node.names[0]==='u_sink');
    assert.ok(sink.roles.includes('input'));
    assert.ok(!sink.roles.includes('output'));
    assert.ok(!result.nodes[0].details.some(port=>port.port==='y'));
});

test('内部寄存器与输入/输出角色只放文件或实例右侧，信号名留在提示中', () => {
    const model = design(), flow = traceProjectSignal(model, target(model));
    const project = { root: path.resolve('.'), sets: [{ name: 'sources', top: 'top', files: flow.nodes.map(n => n.source?.path).filter(Boolean) }] };
    const tree = projectTree(project, { projection: 'instances', flow });
    let nodes = [], stack = [...tree];
    while (stack.length) {
        const n = stack.pop();
        nodes.push(n);
        stack.push(...n.children);
    }
    assert.ok(nodes.every(n => !n.label.includes('r_data')));
    assert.ok(nodes.some(n => n.flags.some(f => f.symbol === '●') && n.flags.some(f => f.symbol === '→')));
    assert.ok(nodes.some(n => n.tooltip.includes('r_data')));
});
test('实际Slang/Yosys验证多层透传、切片与独立实例，并经Worker查询而不调用布局', { timeout: 60000 }, async (t) => {
    const base = path.resolve(__dirname, '../bin/project-flow-native');
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'run-')), file = path.join(root, 'flow.sv');
    const text = 'module leaf(input [7:0] data,output [7:0] result); assign result={data[3:0],data[7:4]}; endmodule\nmodule middle(input [7:0] rx,output [7:0] tx); leaf u_leaf(.data(rx),.result(tx)); endmodule\nmodule top(input [7:0] a,b,output [7:0] y,z); middle u_a(.rx(a),.tx(y)); middle u_b(.rx(b),.tx(z)); endmodule\n';
    await fs.writeFile(file, text);
    const { createToolTaskManager } = require('../src/toolchains/job'), { runYosysCircuit } = require('../src/circuit/yosys-runner'), { CircuitSession } = require('../src/circuit/session');
    const manager = createToolTaskManager(), task = manager.start('project-flow-test'), session = new CircuitSession();
    t.after(async () => {
        session.dispose();
        await task.finish({ keepArtifacts: true });
        await manager.dispose();
    });
    const generated = await runYosysCircuit({ sources: [file], top: 'top', sourceRoot: root, task, outputBase: root, timeoutMs: 30000 });
    const model = fromYosys(JSON.parse(await fs.readFile(generated.filePath, 'utf8')), { top: 'top' }), top = model.modules.find(m => m.id === model.top), middle = model.modules.find(m => m.id === top.cells.find(c => c.name === 'u_a').moduleId), leaf = model.modules.find(m => m.id === middle.cells[0].moduleId);
    const loaded = await session.request('load', { ...generated, top: 'top' }), identity = { designId: loaded.id, revision: loaded.revision };
    const result = await session.request('projectFlow', { ...identity, moduleId: leaf.id, instancePath: [top.cells.find(c => c.name === 'u_a').id, middle.cells[0].id], origin: { objectId: leaf.ports.find(p => p.name === 'data').id, indices: [6, 7] } });
    assert.equal(result.truncated, false);
    assert.ok(result.nodes.filter(n => n.names[0] === 'u_b').every(n => !n.roles.length));
    const node = result.nodes.find(n => n.names.join('.') === 'u_a.u_leaf');
    assert.deepEqual(node.details.find(d => d.port === 'result').indices.sort(), [2, 3]);
    await assert.rejects(session.request('projectFlow', { ...identity, revision: 0 }), /过期/);
});
