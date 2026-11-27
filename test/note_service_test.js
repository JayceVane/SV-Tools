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

test('Note CLI 用 etag 防止写覆盖，具名块改名和搬移后仍能重定位，重复锚点阻止定版', async t => {
    const { root, write, cli, ok } = await workspace(t);
    const hdl = 'module top; initial begin : reset_path a = 1; end endmodule\n';
    await write('top.sv', hdl);
    const initial = await ok('note', 'add', '--note', 'nt_reset', '--topic', 'FIFO', '--title', '复位规则', '--file', 'top.sv',
        '--symbol', '--offset', String(hdl.indexOf('reset_path')));
    const changed = await ok('note', 'update', '--note', initial.id, '--expect', initial.etag, '--topic', 'FIFO 复位');
    assert.notEqual(changed.etag, initial.etag);
    const conflict = await cli('note', 'update', '--note', initial.id, '--expect', initial.etag, '--topic', '错误覆盖');
    assert.equal(conflict.output.diagnostics[0].code, 'NOTE_CONFLICT');
    await fs.rename(path.join(root, 'top.sv'), path.join(root, 'moved.sv'));
    const moved = '\nmodule top;\ninitial begin : renamed_path\n a = 1;\nend\nendmodule\n';
    await write('moved.sv', moved);
    const located = await ok('note', 'get', '--note', initial.id);
    assert.equal(located.location.path, 'moved.sv');
    assert.equal(located.location.name, 'renamed_path');
    assert.equal(located.location.line, 3);
    await write('duplicate.sv', moved);
    const check = await cli('note', 'check', '--note', initial.id);
    assert.equal(check.exitCode, 1);
    assert.equal(check.output.data.notes[0].status, 'ambiguous');
    const refused = await cli('note', 'export', '--note', initial.id, '--out', 'rejected', '--final');
    assert.equal(refused.output.diagnostics[0].code, 'EVIDENCE_STALE');
});
