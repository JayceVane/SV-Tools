'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { runProcess } = require('../src/toolchains/process');
const { findIverilogBinDir } = require('../src/toolchains/iverilog');
const { openCandidate, sha256 } = require('./release-archive.cjs');

const root = path.resolve(__dirname, '..');
const hosts = new Map([['circuit', 6], ['completion', 22], ['project', 10], ['vivado', 8], ['waveform', 5]]);
const ideKinds = ['Visual Studio Code', 'Qoder CN IDE'];

async function resolveIdes(entries) {
    const ides = [];
    for (const entry of entries ?? []) {
        const separator = entry.indexOf('=');
        assert.ok(separator > 0, '使用 --ide "<名称>=<可执行路径>"');
        const name = entry.slice(0, separator);
        const executable = await fs.realpath(entry.slice(separator + 1));
        assert.ok((await fs.stat(executable)).isFile());
        ides.push({ name, executable, sha256: await sha256(executable) });
    }
    assert.deepEqual(ides.map(ide => ide.name).sort(), [...ideKinds].sort(), '需要分别指定 VS Code 与 Qoder CN IDE');
    assert.equal(new Set(ides.map(ide => ide.sha256)).size, 2, '两个目标 IDE 必须使用不同的可执行文件');
    return ides;
}

function validateMatrix(matrix, candidate) {
    assert.equal(matrix.schemaVersion, 2);
    assert.deepEqual(matrix.candidate, candidate);
    assert.deepEqual(matrix.ides.map(ide => ide.name).sort(), [...ideKinds].sort());
    assert.ok(matrix.ides.every(ide => /^[a-f0-9]{64}$/.test(ide.sha256)));
    assert.equal(new Set(matrix.ides.map(ide => ide.sha256)).size, 2);
    const combinations = new Set();
    const reports = new Set();
    for (const row of matrix.rows) {
        assert.ok(ideKinds.includes(row.app) && hosts.has(row.host));
        const key = row.app + '/' + row.host;
        const ideIndex = matrix.ides.findIndex(ide => ide.name === row.app);
        assert.equal(String(row.report).replace(/\\/g, '/'), ideIndex + '-' + row.host + '/host-report.json');
        assert.ok(!combinations.has(key) && !reports.has(row.report), '重复的 IDE/宿主组合或报告');
        assert.ok(typeof row.vscode === 'string' && /^\d+\.\d+\.\d+/.test(row.vscode));
        assert.equal(row.extension, candidate.version);
        assert.ok(Number.isSafeInteger(row.passed) && row.passed >= hosts.get(row.host));
        assert.equal(row.failed, 0);
        assert.match(row.sha256, /^[a-f0-9]{64}$/);
        combinations.add(key);
        reports.add(row.report);
    }
    assert.equal(combinations.size, hosts.size * ideKinds.length, '缺少 IDE/宿主组合');
    return matrix;
}

async function verifyHosts({ directory, extensionPath, candidate, ideEntries, iverilogBin, cygwin }) {
    const ides = await resolveIdes(ideEntries);
    assert.ok(iverilogBin, '宿主验收需要真实 Icarus 编译');
    const rows = [];
    const matrix = { schemaVersion: 2, createdUtc: new Date().toISOString(), candidate, ides, rows };
    for (const [index, ide] of ides.entries()) {
        for (const [host, minimum] of hosts) {
            const runDirectory = path.join(directory, `${index}-${host}`);
            const script = path.join(root, 'scripts', `verify-${host}-host.ps1`);
            const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
                '-CodePath', ide.executable, '-ExtensionPath', extensionPath, '-RunDirectory', runDirectory];
            if (host === 'completion') {
                args.push('-IcarusPath', path.join(iverilogBin, 'iverilog.exe'));
                if (cygwin) args.push('-CygwinPath', cygwin);
            }
            console.error(`[host] ${ide.name} / ${host}`);
            const execution = await runProcess('pwsh.exe', args, { cwd: root, timeoutMs: 300000 });
            assert.equal(execution.code, 0, `${ide.name}/${host}: ${execution.stderr || execution.stdout || execution.errorMessage}`);
            const report = path.join(runDirectory, 'host-report.json');
            const data = JSON.parse(await fs.readFile(report, 'utf8'));
            assert.equal((await fs.realpath(data.extensionPath)).toLowerCase(), (await fs.realpath(extensionPath)).toLowerCase(), '宿主实际加载的扩展路径有误');
            assert.equal(data.version ?? data.extensionVersion, candidate.version);
            assert.ok(Array.isArray(data.checks) && data.checks.length >= minimum);
            assert.ok(data.checks.every(check => typeof check === 'string' ? check.length > 0 : check?.passed === true));
            if (host === 'completion') assert.equal(data.nativeSkipped, false);
            if (host === 'waveform') assert.ok(data.status?.ready && data.status.loaded && !data.status.error);
            rows.push({ host, app: ide.name, vscode: data.vscode, extension: candidate.version,
                passed: data.checks.length, failed: 0, report: path.relative(directory, report), sha256: await sha256(report) });
        }
    }
    validateMatrix(matrix, candidate);
    await fs.writeFile(path.join(directory, 'host-matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
    return matrix;
}

if (require.main === module) {
    async function main() {
        const { values } = parseArgs({ options: { vsix: { type: 'string' }, ide: { type: 'string', multiple: true },
            iverilog: { type: 'string' }, cygwin: { type: 'string' } } });
        assert.ok(values.vsix, '使用 --vsix 指定要验收的实际归档');
        const directory = path.join(root, 'bin', 'm5-host-matrix', randomUUID());
        const extensionPath = path.join(directory, 'extension');
        const candidate = await openCandidate(path.resolve(values.vsix), extensionPath);
        const matrix = await verifyHosts({ directory, extensionPath, candidate, ideEntries: values.ide,
            iverilogBin: findIverilogBinDir(values.iverilog), cygwin: values.cygwin });
        console.log(JSON.stringify({ directory, candidate, rows: matrix.rows.length }));
    }
    main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

module.exports = { verifyHosts, validateMatrix };
