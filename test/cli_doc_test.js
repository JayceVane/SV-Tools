'use strict';
// 文档与实现的一致性护栏：CLI.md 错误码判定表中出现的每个 code 必须真实存在于源码。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = ['src/agent', 'src/toolchains', 'src/vivado'];

async function readSources() {
    const chunks = [];
    for (const dir of SOURCES) {
        for (const entry of await fs.readdir(path.join(ROOT, dir), { recursive: true, withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
            chunks.push(await fs.readFile(path.join(entry.parentPath, entry.name), 'utf8'));
        }
    }
    return chunks.join('\n');
}

test('CLI.md 错误码判定表与源码一致', async () => {
    const doc = await fs.readFile(path.join(ROOT, 'docs', 'CLI.md'), 'utf8');
    const section = doc.split('## 错误码与判定')[1].split('\n## ')[0];
    const codes = [...new Set([...section.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map(match => match[1]))];
    assert(codes.length >= 10, '错误码表缺失或解析失败：' + codes.length);
    const source = await readSources();
    const missing = codes.filter(code => !source.includes("'" + code + "'"));
    assert.deepEqual(missing, [], '文档列出但源码不存在的错误码：' + missing.join(', '));
});
