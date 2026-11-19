'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { run } = require('../src/cli/main');

async function workspace(t) {
    const base = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(base, 'svtools-note-struct-'));
    t.after(async () => {
        if (path.dirname(await fs.realpath(root)) === base) await fs.rm(root, { recursive: true, force: true });
    });
    const write = async (name, text) => fs.writeFile(path.join(root, name), text);
    const cli = (...args) => run([...args, '--workspace', root]);
    async function ok(...args) {
        const { output, exitCode } = await cli(...args);
        assert.equal(exitCode, 0, JSON.stringify(output));
        return output.data;
    }
    return { root, write, cli, ok };
}

test('结构前端解析接口/modport、空模块和实现省略体，输出图与实现桩，探测未连接输入', async t => {
    const { root, write, ok, cli } = await workspace(t);
    const src = `interface bus_if; logic [7:0] data; modport sink(input data); modport source(output data); endinterface
module child(input logic clk, bus_if.sink bus); ... endmodule
module top(input logic clk, bus_if.sink bus); child u_child(.clk(), .bus(bus)); endmodule\n`;
    await write('top.sv', src);
    const tree = await ok('struct', 'parse', '--file', 'top.sv');
    assert.equal(tree.units.find(unit => unit.kind === 'interface').width, 8);
    assert.equal(tree.units.find(unit => unit.name === 'child').ports.find(port => port.name === 'bus').interface.modport, 'sink');
    const arch = await ok('design', 'arch', '--top', 'top', '--engine', 'struct', '--save', 'before');
    assert.equal(arch.instances[0].implementation, 'blackbox');
    const check = await cli('design', 'check', '--top', 'top', '--engine', 'struct');
    assert.equal(check.exitCode, 1);
    assert.ok(check.output.diagnostics.some(item => item.details?.port === 'clk'));
    const lower = await ok('design', 'lower', '--file', 'top.sv');
    const stub = await fs.readFile(path.join(root, lower.files[0]), 'utf8');
    assert.match(stub, /TODO: RTL implementation/);
    assert.doesNotMatch(stub, /\.\.\./);
    await write('top.sv', src.replace('module top(input logic clk, bus_if.sink', 'module top(input logic clk, bus_if.source'));
    const viewMismatch = await cli('design', 'check', '--top', 'top', '--engine', 'struct');
    assert.equal(viewMismatch.exitCode, 1);
    const diagnostic = viewMismatch.output.diagnostics.find(item => item.code === 'ARCH_MODPORT_MISMATCH');
    assert.equal(diagnostic?.details.expected, 'bus_if.sink');
    assert.equal(diagnostic.details.actual, 'bus_if.source');
    assert.equal(diagnostic.source.line, 3);
    await write('top.sv', src.replace('... endmodule', 'logic stored; always_ff @(posedge clk) stored <= 1\'b0; endmodule'));
    const changed = await ok('design', 'diff', '--top', 'top', '--baseline', 'before');
    assert.equal(changed.diff.summary.implementedInstances, 1);
});
