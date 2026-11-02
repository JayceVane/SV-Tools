'use strict';
// design report 证据包：一次导出 SVG+PNG+architecture.json/md/report.json，方向缩写与
// 快照哈希可追溯；render --format png 无宿主栅格化与 SVG 同源。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { run } = require('../src/cli/main');

const FIXTURES = path.join(__dirname, 'fixtures', 'design');

/** @param {object} t 测试上下文 @param {string} name fixture 名称。 @returns {Promise<string>} 隔离工作区。 */
async function workspace(t, name) {
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-report-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    await fsp.cp(path.join(FIXTURES, name), directory, { recursive: true });
    return directory;
}

/** @param {string} file 文件。 @returns {string} SHA-256。 */
function sha256(file) {
    return createHash('sha256').update(require('node:fs').readFileSync(file)).digest('hex');
}

test('design report 产出 SVG+PNG+json+md+manifest 证据包，哈希互相可追溯', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'report', '--workspace', directory, '--top', 'fifo_top', '--out', 'rep']);
    assert.equal(response.exitCode, 0, JSON.stringify(response.output.diagnostics));
    const data = response.output.data;
    assert.deepEqual(data.files.map(item => item.kind).sort(), ['document', 'image', 'image', 'manifest', 'source']);
    const outputDirectory = path.join(directory, 'rep');
    const names = (await fsp.readdir(outputDirectory)).sort();
    assert.equal(names.filter(name => name.endsWith('.svg')).length, 1);
    assert.equal(names.filter(name => name.endsWith('.png')).length, 1);
    assert.equal(names.includes('architecture.json'), true);
    assert.equal(names.includes('architecture.md'), true);
    assert.equal(names.includes('report.json'), true);
    // PNG 是有效位图，尺寸与 data 一致（2x 栅格化）。
    const pngName = names.find(name => name.endsWith('.png'));
    const png = await fsp.readFile(path.join(outputDirectory, pngName));
    assert.equal(png.slice(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), data.evidence.png.width);
    assert.equal(data.evidence.png.scale, 2);
    assert.equal(data.evidence.png.width, data.evidence.export.width * 2);
    // report.json 的 files 清单与磁盘文件哈希一致。
    const manifest = JSON.parse(await fsp.readFile(path.join(outputDirectory, 'report.json'), 'utf8'));
    for (const item of manifest.files) {
        assert.equal(sha256(path.join(outputDirectory, item.path)), item.sha256, item.path);
    }
    // Markdown：方向缩写（i/o/io、连接 o/io/bus）、图像引用与 SHA 引用。
    const markdown = await fsp.readFile(path.join(outputDirectory, 'architecture.md'), 'utf8');
    assert.match(markdown, /u_buf \| fifo_buf \| blackbox \| clk \[i:1\] din \[i:8\] dout \[o:8\]/);
    assert.match(markdown, /方向以端点 A 为视角：`o` = A 驱动 B；`io` = 双向或成员混合方向；`bus` = 共享网络相连/);
    assert.match(markdown, /## 结构检查/);
    assert.match(markdown, /无诊断/);
    const svgName = names.find(name => name.endsWith('.svg'));
    assert.equal(markdown.includes('![' + '](' + svgName + ')') || markdown.includes('](' + svgName + ')'), true, '引用实际 SVG 文件名');
    assert.equal(markdown.includes('`' + data.archSha256 + '`'), true, '引用架构 SHA');
    // architecture.json 与 arch 输出一致（含 checks）。
    const architecture = JSON.parse(await fsp.readFile(path.join(outputDirectory, 'architecture.json'), 'utf8'));
    assert.equal(architecture.archSha256, data.archSha256);
    assert.deepEqual(architecture.checks, []);
});

test('design report 对结构问题设计同样成包，检查表进入 Markdown', async t => {
    const directory = await workspace(t, 'check');
    const response = await run(['design', 'report', '--workspace', directory, '--top', 'check_top', '--out', 'rep']);
    assert.equal(response.exitCode, 0, '报告生成不因结构错误失败');
    assert.equal(response.output.data.checksSummary.errors, 4);
    const markdown = await fsp.readFile(path.join(directory, 'rep', 'architecture.md'), 'utf8');
    assert.match(markdown, /4 error \/ 4 warning/);
    assert.match(markdown, /\| error \| UNRESOLVED_MODULE \|/);
    assert.match(markdown, /\| warning \| WIDTH_MISMATCH \|/);
});

test('design render --format png 输出无宿主位图，--format 非法拒绝', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'render', '--workspace', directory, '--top', 'fifo_top', '--format', 'png', '--out', 'png']);
    assert.equal(response.exitCode, 0, JSON.stringify(response.output.diagnostics));
    const data = response.output.data;
    assert.equal(data.format, 'png');
    assert.equal(data.scale, 2);
    assert.match(data.sourceSha256, /^[0-9a-f]{64}$/, 'PNG 关联源 SVG 哈希');
    const artifact = response.output.artifacts[0];
    assert.equal(artifact.format, 'png');
    const png = await fsp.readFile(artifact.path);
    assert.equal(png.slice(1, 4).toString(), 'PNG');
    assert.equal(sha256(artifact.path), data.sha256);
    const invalid = await run(['design', 'render', '--workspace', directory, '--top', 'fifo_top', '--format', 'gif']);
    assert.equal(invalid.exitCode, 2);
    assert.equal(invalid.output.diagnostics[0].code, 'INVALID_ARGUMENT');
});

test('design report --out 越界拒绝，capabilities 与 help 同步', async t => {
    const directory = await workspace(t, 'skeleton');
    const escape = await run(['design', 'report', '--workspace', directory, '--top', 'fifo_top', '--out', '../report-escape-' + process.pid]);
    assert.equal(escape.exitCode, 2);
    assert.equal(escape.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    const doctor = await run(['doctor', '--workspace', directory]);
    assert.equal(doctor.output.data.capabilities.includes('design.report'), true);
    const help = await run(['--help']);
    assert.match(help.text, /design report --top/);
});
