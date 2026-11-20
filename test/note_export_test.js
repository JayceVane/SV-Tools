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

test('合并主题 Markdown 和 HTML，安全导出，并用定版清单参与设计提交及失效判断', async t => {
    const { root, write, ok } = await workspace(t);
    await write('top.sv', 'module top; endmodule\n');
    await write('draft.md', '# 数据约定\n\n**加粗**\n\n<script>window.injected=1</script>\n');
    await ok('note', 'add', '--note', 'nt_a', '--body', 'draft.md', '--topic', '设计约定');
    const note = await ok('note', 'add', '--note', 'nt_b', '--title', '用例推导', '--topic', '设计约定');
    const exported = await ok('note', 'export', '--topic', '设计约定', '--format', 'html', '--out', 'review', '--final', '--module', 'top');
    assert.deepEqual(exported.notes.map(note => note.id), ['nt_a', 'nt_b']);
    assert.ok(exported.notes.every(note => note.verification.status === 'unbound'));
    const html = await fs.readFile(path.join(root, 'review/notes.html'), 'utf8');
    assert.match(html, /<strong>加粗<\/strong>/u);
    assert.match(html, /用例推导/u);
    assert.match(html, /笔记版本已固定。未绑定仿真运行/u);
    assert.doesNotMatch(html, /<script>/iu);
    const spec = { schemaVersion: 1, id: 'study', title: 'Fixture', overview: 'Design submission', top: 'top', requirements: [{ id: 'R1', text: 'Fixture' }],
        modules: [{ id: 'top', name: 'top', responsibility: 'Fixture', sources: ['top.sv'], requirements: ['R1'], deltaSignals: ['tb.signal'] }] };
    await ok('design', 'plan', '--spec', JSON.stringify(spec));
    const claim = await ok('design', 'claim', '--module', 'top', '--role', 'design', '--actor', 'designer', '--revision', '0');
    const submitted = await ok('design', 'submit', '--module', 'top', '--actor', 'designer', '--revision', '1', '--token', claim.token,
        '--evidence', exported.manifest);
    assert.equal(submitted.modules[0].designCurrent, true);
    await ok('note', 'update', '--note', note.id, '--expect', note.etag, '--body', 'draft.md');
    assert.equal((await ok('design', 'tasks')).modules[0].designCurrent, false);
});
