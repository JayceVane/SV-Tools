'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { extract, openCandidate, sha256, fromVsce } = require('./release-archive.cjs');
const { runProcess } = require('../src/toolchains/process');

const root = path.resolve(__dirname, '..');
const skills = ['agent', 'delivery', 'design', 'vivado', 'waveform'];
const documents = ['docs/AGENT_QUICKSTART.md', 'docs/CLI.md', 'docs/DESIGN_WORKFLOW.md', 'docs/WAVEFORM.md', 'docs/V4_2_PLAN.md'];
const runtime = name => /^(?:src\/|bin\/|templates\/|package\.json$|LICENSE(?:\.txt)?$|NOTICE$|AUTHORS$|THIRD_PARTY_NOTICES\.md$)/.test(name);
const launcher = '@echo off\r\nnode "%~dp0src\\cli\\main.js" %*\r\nexit /b %errorlevel%\r\n';

async function smoke(stage, workspace) {
    await fsp.mkdir(workspace);
    await fsp.writeFile(path.join(workspace, 'top.sv'), 'module top(input logic a, output logic y); assign y = a; endmodule\n');
    await fsp.writeFile(path.join(workspace, 'wave.vcd'), '$timescale 1ns $end\n$scope module tb $end\n$var wire 1 ! clk $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n#10\n1!\n');
    const cmd = path.join(stage, 'svtools-agent.cmd');
    const cases = [['doctor'], ['format', '--file', 'top.sv'], ['wave', 'signals', '--file', 'wave.vcd'], ['design', 'report', '--top', 'top', '--out', 'reports']];
    for (const args of cases) {
        const result = await runProcess(cmd, [...args, '--workspace', workspace], { cwd: workspace, timeoutMs: 60000 });
        assert.equal(result.code, 0, JSON.stringify(result));
        const data = JSON.parse(result.stdout);
        assert.equal(data.apiVersion, '1');
        assert.equal(data.status, 'success', JSON.stringify(data.diagnostics));
    }
    const mismatch = await runProcess(cmd, ['format', '--file', 'missing.sv', '--workspace', workspace], { cwd: workspace, timeoutMs: 60000 });
    assert.notEqual(mismatch.code, 0, '启动脚本必须保留 CLI 失败退出码');
}

async function packageAgent(vsix, output) {
    assert.equal(process.platform + '/' + process.arch, 'win32/x64', 'Agent 便携包当前面向 Windows x64');
    const tmpRoot = await fsp.realpath(os.tmpdir());
    const temporary = await fsp.mkdtemp(path.join(tmpRoot, 'svtools-agent-package-'));
    const archive = path.join(temporary, 'agent.zip');
    try {
        const payload = path.join(temporary, 'payload');
        const identity = await openCandidate(vsix, payload);
        const zip = new (fromVsce('yazl').ZipFile)();
        const files = (await fsp.readdir(payload, { recursive: true, withFileTypes: true }))
            .filter(entry => entry.isFile()).map(entry => path.relative(payload, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
            .filter(runtime).sort();
        for (const name of ['src/cli/main.js', 'bin/svtools.win32-x64-msvc.node', 'LICENSE.txt', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'bin/vendor/ELK-LICENSE.md', 'bin/vendor/resvg-LICENSE.txt', 'bin/vendor/yosys/THIRD-PARTY-NOTICES.txt']) {
            assert.ok(files.includes(name), '缺少 Agent 运行文件或许可 ' + name);
        }
        for (const name of files) zip.addFile(path.join(payload, name), name);
        const skillDirectories = skills.map(name => 'skills/svtools-' + name);
        const tracked = execFileSync('git', ['ls-files', '-z', '--', ...skillDirectories], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
        for (const dir of skillDirectories) assert.ok(tracked.includes(dir + '/SKILL.md'), '缺少 Skill ' + dir);
        for (const name of [...tracked, ...documents]) {
            assert.match(name, /^(?:skills\/svtools-[a-z]+\/|docs\/)[A-Za-z0-9_./-]+\.(?:md|json)$/);
            assert.ok((await fsp.lstat(path.join(root, name))).isFile(), '发行文档须为普通文件 ' + name);
            zip.addFile(path.join(root, name), name);
        }
        zip.addBuffer(Buffer.from(launcher), 'svtools-agent.cmd');
        zip.addFile(path.join(root, 'docs', 'AGENT_QUICKSTART.md'), 'README.md');
        zip.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1, target: 'win32-x64', ...identity }, null, 2) + '\n'), 'RELEASE.json');
        const write = pipeline(zip.outputStream, fs.createWriteStream(archive, { flags: 'wx' }));
        zip.end();
        await write;
        const unpacked = path.join(temporary, 'agent unpacked');
        await extract(archive, unpacked, name => name);
        await smoke(unpacked, path.join(temporary, 'sample workspace'));
        await fsp.copyFile(archive, output, fs.constants.COPYFILE_EXCL);
        return { ...identity, file: output, sha256: await sha256(output), smoke: ['doctor', 'format', 'wave signals', 'design report', 'exit code'] };
    } finally {
        const real = await fsp.realpath(temporary);
        assert.ok(path.dirname(real) === tmpRoot && path.basename(real).startsWith('svtools-agent-package-'));
        await fsp.rm(real, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
}

if (require.main === module) {
    const [vsix, output] = process.argv.slice(2);
    if (!vsix || !output) { console.error('用法: node scripts/package-agent.cjs <vsix> <agent.zip>'); process.exitCode = 2; }
    else packageAgent(path.resolve(vsix), path.resolve(output)).then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
module.exports = { packageAgent };
