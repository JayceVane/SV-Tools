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
const { generateReportMarkdown } = require('../src/design/report');
const { resolveStyles } = require('../src/design/architecture-image');

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

test('报告接口方向使用 modport 证据，全双工总线不再一律写成 bus', async t => {
    // 结构投影只认位级连线，接口两端在它那里都是未知方向；这里确认 modport 证据已回填到报告表格。
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-report-flow-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    await fsp.writeFile(path.join(directory, 'flow.sv'), `
interface axi_like_if;
    logic [31:0] addr, wdata, rdata;
    modport master (output addr, wdata, input rdata);
    modport slave  (input addr, wdata, output rdata);
endinterface
module host(axi_like_if.master m); ... endmodule
module device(axi_like_if.slave s); ... endmodule
module top;
    axi_like_if bus();
    host   u_host(.m(bus));
    device u_device(.s(bus));
endmodule
`);
    const response = await run(['design', 'report', '--workspace', directory, '--top', 'top', '--out', 'rep']);
    assert.equal(response.exitCode, 0, JSON.stringify(response.output.diagnostics));
    assert.equal(response.output.data.evidence.layout.renderer, 'block-design');
    const svgFile = response.output.data.files.find(file => file.path.endsWith('.svg'));
    const svg = await fsp.readFile(path.join(directory, svgFile.path), 'utf8');
    assert.match(svg, /class="card-head"/u);
    assert.match(svg, /class="schematic-pin/u);
    assert.equal(response.output.data.evidence.layout.theme, 'mono');
    assert.ok(!svg.includes('var(--'), '独立 SVG 中的配色已解析，PNG 栅格化不依赖宿主主题');
    assert.ok(!svg.includes('color-mix('), '独立 SVG 内不得保留 color-mix');
    // 独立文档图必须是灰阶：R=G=B，不得出现品牌蓝、状态色或渐变。
    const styled = svg.replace(/<metadata[\s\S]*?<\/metadata>/gu, '').replace(/url\(#[^)]*\)/gu, '');
    let colored = 0;
    for (const match of styled.matchAll(/#([0-9a-fA-F]{3,8})/gu)) {
        const raw = match[1];
        if (![3, 4, 6, 8].includes(raw.length)) continue;
        const digits = raw.length <= 4 ? [...raw.slice(0, 3)].map(char => char + char).join('') : raw.slice(0, 6);
        assert.equal(digits.slice(0, 2), digits.slice(2, 4), 'document 必须 R=G：#' + raw);
        assert.equal(digits.slice(2, 4), digits.slice(4, 6), 'document 必须 G=B：#' + raw);
        colored += 1;
    }
    assert.ok(colored > 20, '灰阶检查应覆盖内联样式与文字颜色：' + colored);
    assert.equal((svg.match(/id="svtools-evidence"/gu) || []).length, 1);
    const leaf = await run(['design', 'render', '--workspace', directory, '--top', 'host', '--out', 'leaf']);
    assert.equal(leaf.exitCode, 0, JSON.stringify(leaf.output.diagnostics));
    assert.equal(leaf.output.data.evidence.layout.renderer, 'block-design');
    const leafSvg = await fsp.readFile(leaf.output.artifacts[0].path, 'utf8');
    assert.equal((leafSvg.match(/class="card-head"/gu) || []).length, 1, '叶子模块仍应绘出自己的模块框');
    assert.match(leafSvg, /class="pin-label bus"[^>]*text-anchor="end">≡ m<\/text>/u, 'Master 接口放在模块右侧');
    const markdown = await fsp.readFile(path.join(directory, 'rep', 'architecture.md'), 'utf8');
    // 两端都驱动成员：角色名 master/slave 判定主流向，这条连接应写成 o 而不是 bus。
    const connectionSection = markdown.slice(markdown.indexOf('## 接口连接'));
    const row = connectionSection.split('\n').find(line => line.includes(' u_host ') || line.includes(' u_device '));
    assert.ok(row, '接口连接表应包含该束：\n' + connectionSection.slice(0, 600));
    assert.match(row, /\| o \|/u, '全双工接口应判定出方向，而不是 bus：' + row);
});

test('结构诊断缺少 details 时也能生成报告', () => {
    const markdown = generateReportMarkdown({ top: { name: 'top' }, checks: [{ severity: 'error', code: 'SYNTAX', message: 'bad | token' }],
        instances: [], interfaces: [], sourceFiles: [], limitations: [] },
        { svgFile: 'top.svg', pngFile: null, scale: null, svgSha256: 'svg-hash' });
    assert.match(markdown, /\| error \| SYNTAX \|  \| bad \\| token \|/);
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

test('独立图主题令牌按引用解析，未知令牌与循环引用显式失败', () => {
    const shared = ':root { --page: #ffffff; --ink: var(--page); --late: var(--ink); }';
    assert.equal(resolveStyles(shared, 'fill:var(--late)', {}), 'fill:#ffffff', '前向引用必须解析');
    assert.equal(resolveStyles(shared, 'fill:var(--late)', { late: '#111111' }), 'fill:#111111', '覆盖优先');
    assert.throws(() => resolveStyles(shared, 'fill:var(--missing)', {}), /未知主题令牌/u, '拼错令牌不能静默');
    assert.throws(() => resolveStyles(':root { --a: var(--b); --b: var(--a); }', 'fill:var(--a)', {}), /循环引用/u);
    assert.equal(resolveStyles(shared, 'fill:color-mix(in srgb, #ffffff 50%, #000000)', {}), 'fill:#808080');
});
