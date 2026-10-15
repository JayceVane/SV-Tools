'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { parseXpr, parseXprText, resolveXprPath, samePath, fileSetOf } = require('../src/vivado/xpr');

const xprPath = path.resolve('sample project', 'prj', 'design.xpr');
const xprDir = path.dirname(xprPath);
const project = body => '<Project Version="7"><FileSets>' + body + '</FileSets></Project>';
const fileSet = files => '<FileSet Name="sources_1" Type="DesignSrcs">' + files + '</FileSet>';

async function fixture(t, text) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-xpr-contract-'));
    const file = path.join(dir, 'design.xpr');
    await fs.writeFile(file, text);
    t.after(async () => { await fs.unlink(file); await fs.rmdir(dir); });
    return file;
}

test('既有 Vivado XPR 形状保持器件、四文件集、各自 top 与成员顺序', () => {
    const text = '<?xml version="1.0" encoding="UTF-8"?>\n<Project Version="7" Minor="60">'
        + '<Configuration><Option Name="Part" Val="xc7z100ffg900-2"/></Configuration><FileSets>'
        + '<FileSet Name="sources_1" Type="DesignSrcs"><File Path="$PPRDIR/../src/clk.v"/><File Path="$PPRDIR/../src/fifo.sv"/><Config><Option Name="TopModule" Val="fifo"/></Config></FileSet>'
        + '<FileSet Name="constrs_1" Type="Constrs"><Config/></FileSet>'
        + '<FileSet Name="sim_1" Type="SimulationSrcs"><File Path="$PPRDIR/../sim/test.sv"/><Config><Option Name="TopModule" Val="test"/></Config></FileSet>'
        + '<FileSet Name="utils_1" Type="Utils"/></FileSets><Runs><Run Name="synth_1"/></Runs></Project>';
    const parsed = parseXprText(text, xprPath);
    assert.deepEqual(parsed, { path: xprPath, dir: xprDir, part: 'xc7z100ffg900-2', sets: [
        { name: 'sources_1', type: 'DesignSrcs', top: 'fifo', files: [path.resolve(xprDir, '../src/clk.v'), path.resolve(xprDir, '../src/fifo.sv')] },
        { name: 'constrs_1', type: 'Constrs', top: '', files: [] },
        { name: 'sim_1', type: 'SimulationSrcs', top: 'test', files: [path.resolve(xprDir, '../sim/test.sv')] },
        { name: 'utils_1', type: 'Utils', top: '', files: [] }
    ] });
});

test('属性顺序、额外属性、单双引号、CRLF 和等号空白不影响读取', () => {
    const text = "\uFEFF<?xml version = '1.0' encoding='utf-8'?>\r\n<Project>\r\n<Configuration><Option Val = 'xc7a35t' Other='ignored' Name = 'Part' /></Configuration>"
        + "<FileSets><FileSet\r\n Type = 'DesignSrcs' RelSrcDir='ignored' Name = 'sources_1' >"
        + "<File Other='>'\r\n Path = '../src/a.sv' /><Config><Option Val = 'a' Name = 'TopModule' /></Config></FileSet></FileSets></Project>";
    const parsed = parseXprText(text, xprPath);
    assert.equal(parsed.part, 'xc7a35t');
    assert.equal(parsed.sets[0].top, 'a');
    assert.deepEqual(parsed.sets[0].files, [path.resolve(xprDir, '../src/a.sv')]);
});

test('XML entity 只解码一次，支持五种命名与十进制/十六进制 Unicode 引用', () => {
    const text = project('<FileSet Type="DesignSrcs" Name="source&amp;test"><File Path="../src/a&amp;b&#32;&#x4E2D;&#x1F680;&apos;&quot;&lt;&gt;.sv"/><File Path="../src/literal&amp;amp;.v"/><Config><Option Name="TopModule" Val="top&amp;alias"/></Config></FileSet>');
    const parsed = parseXprText(text, xprPath);
    assert.equal(parsed.sets[0].name, 'source&test');
    assert.equal(parsed.sets[0].top, 'top&alias');
    assert.deepEqual(parsed.sets[0].files, [path.resolve(xprDir, '../src/a&b 中🚀\'"<>.sv'), path.resolve(xprDir, '../src/literal&amp;.v')]);
});

test('注释、processing instruction、CDATA 内伪造 FileSet 不进入元数据', () => {
    const parsed = parseXprText('<?xml version="1.0"?><Project><!-- <FileSet Name="fake" Type="DesignSrcs"/> --><?vivado metadata?><Metadata><![CDATA[<FileSet Name="fake"/> &bad;]]></Metadata><FileSets>' + fileSet('<File Path="../src/a.sv"/>') + '</FileSets></Project><!-- 完整文件 -->', xprPath);
    assert.equal(parsed.sets.length, 1);
    assert.equal(parsed.sets[0].name, 'sources_1');
});

test('普通相对路径与 PPRDIR 均以 XPR 目录为基准，与 cwd 无关', () => {
    for (const reference of ['../src/a.sv', '..\\src\\a.sv', '$PPRDIR/../src/a.sv', '$PPRDIR\\..\\src\\a.sv']) {
        assert.equal(resolveXprPath(reference, xprDir), path.resolve(xprDir, '../src/a.sv'));
    }
    assert.equal(resolveXprPath('local.sv', xprDir), path.join(xprDir, 'local.sv'));
});

test('绝对路径不重新锚定，file URL 正确处理空格、Unicode 与编码字符', () => {
    const absolute = path.resolve('other location', '中文 # design.sv');
    assert.equal(resolveXprPath(absolute, xprDir), absolute);
    assert.equal(resolveXprPath(pathToFileURL(absolute).href, xprDir), absolute);
});

test('成员查询与路径比较保持现有大小写及 normalize 合同', () => {
    const file = path.resolve(xprDir, '../src/a.sv');
    const parsed = parseXprText(project(fileSet('<File Path="../src/a.sv"/>')), xprPath);
    assert.equal(fileSetOf(parsed, file), 'sources_1');
    assert.equal(fileSetOf(parsed, path.join(xprDir, 'missing.sv')), null);
    assert.equal(samePath(path.join(xprDir, 'child', '..', 'a.sv'), path.join(xprDir, 'a.sv')), true);
    assert.equal(samePath(file.toUpperCase(), file.toLowerCase()), process.platform === 'win32');
});

test('完整空 Project 可读取，不把未知 Vivado 元数据当作错误', () => {
    assert.deepEqual(parseXprText('<Project><Unknown Meta="value"><Child/></Unknown></Project>', xprPath).sets, []);
});

const malformed = [
    ['空文件', ''],
    ['根元素错误', '<Workspace/>'],
    ['多个根元素', '<Project/><Project/>'],
    ['根闭合后残留文本', '<Project/>broken'],
    ['根尚未写完', '<Project><FileSets>'],
    ['末尾半写标签', '<Project></Pro'],
    ['中间半写属性', '<Project><FileSets><FileSet Name="sources_1" Type="DesignSrcs"><File Path="x</FileSet></FileSets></Project>'],
    ['嵌套结束标签不匹配', '<Project><FileSets></Project></FileSets>'],
    ['多余结束标签', '<Project/></Project>'],
    ['属性重复', '<Project Version="7" Version="8"/>'],
    ['属性缺少引号', '<Project Version=7/>'],
    ['属性缺少分隔空白', '<Project A="1"B="2"/>'],
    ['裸 ampersand', project(fileSet('<File Path="a&b.sv"/>'))],
    ['未知 entity', '<Project Meta="&vendor;"/>'],
    ['非法数值 entity', '<Project Meta="&#0;"/>'],
    ['超 Unicode entity', '<Project Meta="&#x110000;"/>'],
    ['文本 entity 损坏', '<Project><Metadata>&bad;</Metadata></Project>'],
    ['注释损坏', '<Project><!-- invalid -- comment --></Project>'],
    ['注释截断', '<Project><!-- missing ending</Project>'],
    ['CDATA 截断', '<Project><![CDATA[unfinished</Project>'],
    ['CDATA 根外', '<![CDATA[text]]><Project/>'],
    ['DOCTYPE 不受支持', '<!DOCTYPE Project [<!ENTITY x "value">]><Project/>'],
    ['XML 声明在根内', '<Project><?xml version="1.0"?></Project>'],
    ['XML 编码属性为空', '<?xml version="1.0" encoding=""?><Project/>'],
    ['XML standalone 属性为空', '<?xml version="1.0" standalone=""?><Project/>'],
    ['XML 声明顺序损坏', '<?xml version="1.0" standalone="yes" encoding="UTF-8"?><Project/>'],
    ['XML 声明非法 entity', '<?xml version="&#49;.0"?><Project/>'],
    ['file URL 编码损坏', project(fileSet('<File Path="file:///%INVALID"/>'))],
    ['文件集缺少 Type', project('<FileSet Name="sources_1"/>')],
    ['文件缺少 Path', project(fileSet('<File/>'))],
    ['重复文件集名称', project(fileSet('') + fileSet(''))],
    ['文件集嵌套', project(fileSet(fileSet('')))],
    ['控制字符', '<Project Meta="\u0000"/>'],
    ['孤立 surrogate', '<Project Meta="\uD800"/>']
];
for (const [name, text] of malformed) {
    test('损坏或半写 XPR 明确失败：' + name, () => {
        assert.throws(() => parseXprText(text, xprPath), error => error.message.includes('XPR XML') && error.message.includes(xprPath));
    });
}

test('磁盘读取接口与纯文本解析结果一致，文件错误保留路径上下文', async t => {
    const text = project(fileSet('<File Path="../src/a.sv"/>'));
    const file = await fixture(t, text);
    assert.deepEqual(parseXpr(file), parseXprText(text, file));
    assert.throws(() => parseXpr(path.join(path.dirname(file), 'missing.xpr')), /读取 XPR 失败.*missing\.xpr.*ENOENT/);
});

test('磁盘半写内容和损坏 UTF-8 不返回部分工程结果', async t => {
    const file = await fixture(t, '<Project><FileSets>');
    assert.throws(() => parseXpr(file), /读取 XPR 失败.*文件未写完/);
    await fs.writeFile(file, Buffer.from([0x3c, 0x50, 0x72, 0xff]));
    assert.throws(() => parseXpr(file), error => error.message.includes(file) && error.message.includes('读取 XPR 失败'));
});