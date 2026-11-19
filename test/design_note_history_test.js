'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const history = require('../src/design/note-history-store');
const { anchorsIn } = require('../src/design/note-history-view');

test('文档历史识别源码中的多个模块，沿用合法笔记标记', () => {
    const source = [
        'module fifo;',
        '    //< 写侧 [note:nt_shared]',
        '    always_comb begin : update',
        '       //: 条件 [note:nt_nested]',
        '    end',
        '    //>',
        '    /*',
        '    //: 示例 [note:nt_false]',
        '    */',
        'endmodule',
        'module tb;',
        '    //: FIFO 检查 [note:nt_shared]',
        'endmodule'
    ].join('\r\n');
    assert.deepEqual(anchorsIn(source).map(({ id, module, line }) => [id, module, line]), [
        ['nt_nested', 'fifo', 4], ['nt_shared', 'fifo', 2], ['nt_shared', 'tb', 12]
    ]);
});

test('历史版本不可变、相同保存去重，损坏项和已删除笔记仍可查找', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-note-history-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const id = 'nt_1234-abcd';
    const firstText = '# FIFO\n\n第一个版本\n', secondText = '# FIFO\n\n新稿\n';
    const auto = await history.record(root, id, firstText, 'save');
    assert.equal(await history.record(root, id, firstText, 'save'), auto);
    const pinned = await history.record(root, id, firstText, 'checkpoint', '评审前');
    const updated = await history.record(root, id, secondText, 'save');
    assert.notEqual(pinned, auto);
    assert.equal((await history.readRevision(root, id, pinned)).content, firstText);
    const result = await history.listRevisions(root, id);
    assert.deepEqual(result.revisions.map(({ version, label }) => [version, label]), [[updated, ''], [pinned, '评审前'], [auto, '']]);
    assert.ok(result.revisions.every(entry => !Object.hasOwn(entry, 'content')));
    assert.deepEqual([...await history.listNotes(root)], [[id, false]]);

    const savedFile = path.join(root, '.svtools/agent/note-history', id, updated + '.json');
    await fs.writeFile(savedFile, '{"schemaVersion":1}');
    const recovered = await history.listRevisions(root, id);
    assert.deepEqual(recovered.revisions.map(entry => entry.version), [pinned, auto]);
    assert.deepEqual(recovered.invalid.map(entry => entry.version), [updated]);
    assert.notEqual(await history.record(root, id, secondText, 'save'), updated);
    await assert.rejects(history.readRevision(root, id, '../outside'), /版本 ID/);
    await assert.rejects(history.record(root, '../outside', 'test', 'save'), /笔记 ID/);
});
