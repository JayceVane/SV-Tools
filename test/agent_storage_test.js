'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../src/agent/storage');

test('提交阶段的瞬时共享冲突有限重试，超过预算才失败', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-storage-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'status.json');
    const original = fs.rename; let calls = 0;
    fs.rename = async (...args) => { calls += 1; if (calls <= 2) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return original.apply(fs, args); };
    try {
        await storage.writeJson(file, { state: 'running' });
        assert.equal(calls, 3);
        assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).state, 'running');
        calls = -100;
        await assert.rejects(storage.writeJson(file, { state: 'failed' }), { code: 'EPERM' });
        assert.equal(await fs.readdir(root).then(names => names.filter(n => n.endsWith('.tmp')).length), 0);
    } finally { fs.rename = original; }
});
