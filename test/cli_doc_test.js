'use strict';
// 文档与实现的一致性护栏：CLI.md 错误码判定表中出现的每个 code 必须真实存在于源码。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// 波形错误码已下沉到 Rust（`src/native/src/wave`），必须一并纳入核对：
// 只扫 JS 会让文档与真实产出漂移，也逼着 JS 侧重复写一遍字符串去「骗过」测试。
const SOURCES = ['src/agent', 'src/toolchains', 'src/vivado', 'src/native/src'];
const EXTENSIONS = ['.js', '.rs'];

async function readSources() {
    const chunks = [];
    for (const dir of SOURCES) {
        for (const entry of await fs.readdir(path.join(ROOT, dir), { recursive: true, withFileTypes: true })) {
            if (!entry.isFile() || !EXTENSIONS.some(extension => entry.name.endsWith(extension))) continue;
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
    // Rust 侧用双引号、JS 侧用单引号写字符串字面量，两种都要认。
    const missing = codes.filter(code => !source.includes("'" + code + "'") && !source.includes('"' + code + '"'));
    assert.deepEqual(missing, [], '文档列出但源码不存在的错误码：' + missing.join(', '));
});
