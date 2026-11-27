'use strict';
// CLI 索引与各专题保存不同领域的参数和诊断，核对链接与错误码。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKILLS = path.join(ROOT, 'skills');
const INDEX = path.join(SKILLS, 'svtools-agent', 'references', 'cli.md');
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

function relativeLinks(file, doc) {
    return [...doc.matchAll(/\]\(([^\s)]+)\)/gu)].map(([, link]) => link.split('#')[0])
        .filter(link => link && !/^[\w+.-]+:/u.test(link)).map(link => path.resolve(path.dirname(file), link));
}

test('CLI 命令索引和专题引用均指向随 Agent 分发的文件', async () => {
    const referenceFiles = relativeLinks(INDEX, await fs.readFile(INDEX, 'utf8'));
    assert(referenceFiles.length > 0, 'CLI 索引缺少专题链接');
    const entryFiles = ['agent', 'vivado', 'design', 'waveform', 'delivery'].map(name => path.join(SKILLS, 'svtools-' + name, 'SKILL.md'));
    for (const file of [INDEX, ...referenceFiles, ...entryFiles]) {
        const doc = await fs.readFile(file, 'utf8');
        for (const link of relativeLinks(file, doc)) {
            const relative = path.relative(SKILLS, link);
            assert(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), '链接超出 Agent 技能目录：' + link);
            assert((await fs.stat(link)).isFile(), '缺少链接目标：' + link);
        }
    }
});

test('CLI 参考的错误码判定表与源码一致', async () => {
    const referenceFiles = relativeLinks(INDEX, await fs.readFile(INDEX, 'utf8'));
    const sections = (await Promise.all(referenceFiles.map(file => fs.readFile(file, 'utf8'))))
        .map(doc => doc.split('## 错误码与判定')[1]?.split('\n## ')[0]).filter(Boolean);
    const codes = [...new Set([...sections.join('\n').matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map(match => match[1]))];
    assert(codes.length >= 10, '错误码表缺失或解析失败：' + codes.length);
    const source = await readSources();
    // Rust 侧用双引号、JS 侧用单引号写字符串字面量，两种都要认。
    const missing = codes.filter(code => !source.includes("'" + code + "'") && !source.includes('"' + code + '"'));
    assert.deepEqual(missing, [], '文档列出但源码不存在的错误码：' + missing.join(', '));
});
