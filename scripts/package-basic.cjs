'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify, parseArgs } = require('node:util');
const { pipeline } = require('node:stream/promises');
const esbuild = require('esbuild');
const { inject } = require('postject');
const { extract, sha256, fromVsce } = require('./release-archive.cjs');
const { nativeArtifactName } = require('../src/native-loader');

const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const sample = 'example/struct-packet-hub';
const exampleFiles = ['README.md', 'channels.sv', 'blocks.sv', 'packet_hub.sv'];
const top = 'packet_hub';

async function copyFile(source, destination) {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}

async function makeExecutable(working, executable, version) {
    const entry = path.join(working, 'entry.cjs');
    await esbuild.build({ absWorkingDir: root, entryPoints: ['scripts/struct-sea-entry.cjs'], outfile: entry,
        platform: 'node', target: 'node24', format: 'cjs', bundle: true, packages: 'external' });
    const stamp = path.join(working, 'version');
    await fsp.writeFile(stamp, version);
    const config = path.join(working, 'sea.json');
    const output = path.join(working, 'sea.blob');
    await fsp.writeFile(config, JSON.stringify({ main: entry, output, disableExperimentalSEAWarning: true,
        assets: { version: stamp, parser: path.join(root, 'bin', nativeArtifactName()) } }));
    await execute(process.execPath, ['--experimental-sea-config=' + config], { cwd: working, windowsHide: true, timeout: 60_000 });
    await copyFile(process.execPath, executable);
    await inject(executable, 'NODE_SEA_BLOB', await fsp.readFile(output), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
}

async function zip(directory, archive) {
    const out = new (fromVsce('yazl').ZipFile)();
    const files = (await fsp.readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
        .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
    for (const file of files) out.addFile(path.join(directory, file), file);
    const complete = pipeline(out.outputStream, fs.createWriteStream(archive, { flags: 'wx' }));
    out.end();
    await complete;
}

async function verify(directory, working) {
    const cwd = path.join(working, '独立验收 工程');
    const isolated = path.join(working, '只放 EXE');
    const temp = path.join(working, '临时缓存');
    for (const dir of [cwd, isolated, temp]) await fsp.mkdir(dir);
    const executable = path.join(isolated, 'svtools-struct.exe');
    await copyFile(path.join(directory, 'svtools-struct.exe'), executable);
    for (const file of exampleFiles) await copyFile(path.join(directory, sample, file), path.join(cwd, file));
    // No repo modules, Node installation or HDL simulator on PATH.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:path|node_path|node_options|tmp|temp)$/i.test(name)));
    Object.assign(env, { Path: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), TEMP: temp, TMP: temp });
    const settings = { cwd, env, windowsHide: true, timeout: 60_000, encoding: 'utf8' };
    async function cli(args, expected = 0) {
        let stdout;
        try { ({ stdout } = await execute(executable, [...args, '--workspace', cwd], settings)); assert.equal(expected, 0); }
        catch (error) {
            assert.equal(error.code, expected, error.stderr || error.message);
            stdout = error.stdout;
        }
        const response = JSON.parse(stdout);
        assert.equal(response.status, expected ? 'failed' : 'success', JSON.stringify(response.diagnostics));
        return response;
    }
    const version = (await execute(executable, ['--version'], settings)).stdout.trim();
    const tree = (await cli(['parse'])).data;
    const packet = tree.units.find(unit => unit.kind === 'interface' && unit.name === 'packet_link');
    const sampler = tree.units.find(unit => unit.kind === 'interface' && unit.name === 'sample_link');
    assert.equal(packet.width, 37);
    assert.equal(sampler.width, 18);
    assert.equal(packet.modports.find(port => port.name === 'source').members.find(port => port.name === 'ready').direction, 'input');
    const arch = (await cli(['arch', '--top', top, '--save', 'baseline'])).data;
    assert.equal(arch.engine, 'struct');
    assert.equal(arch.instances.length, 10);
    assert.equal(arch.instances.filter(item => item.implementation === 'blackbox').length, 9);
    const paths = [['u_lane0', 'u_arbiter'], ['u_arbiter', 'u_fifo'], ['u_fifo', 'u_router']];
    for (const pair of paths) assert.ok(arch.interfaces.some(row => pair.every(name => [row.from.name, row.to.name].includes(name)) && row.bits === 37), pair.join(' -> '));
    assert.equal((await cli(['check', '--top', top])).data.status, 'clean');
    const image = (await cli(['render', '--top', top, '--out', 'diagrams'])).artifacts[0];
    const svg = await fsp.readFile(image.path, 'utf8');
    assert.match(svg, /u_fifo/);
    assert.match(svg, /u_arbiter/);
    const lowered = (await cli(['lower'])).data.files;
    assert.equal(lowered.length, 3);
    const stubs = await fsp.readFile(path.join(cwd, lowered.find(file => file.endsWith('/blocks.sv'))), 'utf8');
    assert.match(stubs, /TODO: RTL implementation/);
    assert.doesNotMatch(stubs, /\.\.\./);

    const topFile = path.join(cwd, 'packet_hub.sv');
    const original = await fsp.readFile(topFile, 'utf8');
    const disconnected = original.replace('.clk(clk), .rst_n(rst_n), .enqueue(', '.clk(), .rst_n(rst_n), .enqueue(');
    assert.notEqual(disconnected, original);
    await fsp.writeFile(topFile, disconnected);
    const missingClock = (await cli(['check', '--top', top], 1)).diagnostics.find(item => item.code === 'UNDRIVEN_INPUT' && item.details?.instance === 'u_fifo' && item.details?.port === 'clk');
    assert.ok(missingClock, 'Expected precise FIFO clock diagnostic');
    assert.equal(missingClock.source.file, 'packet_hub.sv');
    assert.match(disconnected.split('\n')[missingClock.source.line - 1], /\.clk\(\)/u);
    await fsp.writeFile(topFile, original.replace('.watched(adc0)', '.watched(telemetry)'));
    const wrongType = (await cli(['check', '--top', top], 1)).diagnostics.find(item => item.code === 'ARCH_INTERFACE_TYPE' && item.details?.instance === 'u_monitor');
    assert.ok(wrongType, 'Expected interface type mismatch diagnostic');
    const restricted = original.replace(/sample_link\s+adc0,/u, 'sample_link.sink    adc0,');
    assert.notEqual(restricted, original);
    await fsp.writeFile(topFile, restricted);
    const wrongView = (await cli(['check', '--top', top], 1)).diagnostics.find(item => item.code === 'ARCH_MODPORT_MISMATCH' && item.details?.instance === 'u_monitor');
    assert.equal(wrongView?.details.actual, 'sample_link.sink');
    assert.equal(wrongView.details.expected, 'sample_link.tap');
    await fsp.writeFile(topFile, original);

    const blockFile = path.join(cwd, 'blocks.sv');
    const blocks = await fsp.readFile(blockFile, 'utf8');
    const edited = blocks.replace(/(module packet_fifo\b[\s\S]*?)\.\.\./u, '$1assign high_watermark = 1\'b0;');
    assert.notEqual(edited, blocks);
    await fsp.writeFile(blockFile, edited);
    const changed = (await cli(['diff', '--top', top, '--baseline', 'baseline'])).data.diff;
    assert.deepEqual(changed.implemented, ['u_fifo']);
    const formatter = (await execute(path.join(directory, 'svtools-format.exe'), ['--version'], settings)).stdout.trim();
    const formatted = (await execute(path.join(directory, 'svtools-format.exe'), [topFile], settings)).stdout;
    assert.match(formatted, /module packet_hub/);
    return { image: image.path, report: { version, formatter, standalone: true, instanceCount: arch.instances.length,
        boundaryCount: arch.graph.stats.boundaries, edges: arch.graph.edges.length, sharedPacketPaths: paths,
        packetBits: packet.width, check: 'clean', missingClock, wrongType, wrongView, implemented: changed.implemented, loweredFiles: lowered.sort() } };
}

async function main() {
    const { values } = parseArgs({ options: { version: { type: 'string', default: '4.3.0-preview.3' }, 'node-license': { type: 'string' } } });
    assert.equal(process.platform + '/' + process.arch, 'win32/x64', '绿色包当前目标为 Windows x64');
    assert.ok(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u.test(values.version), '版本号无效');
    const bin = await fsp.realpath(path.join(root, 'bin'));
    const name = `svtools-basic-${values.version}-win-x64`;
    const archive = path.join(bin, name + '.zip');
    const results = path.join(bin, name + '-validation');
    for (const target of [archive, archive + '.sha256', results]) {
        if (fs.existsSync(target)) throw new Error('交付路径已存在：' + target);
    }
    const working = await fsp.mkdtemp(path.join(bin, '.struct-kit-'));
    try {
        const stage = path.join(working, 'kit');
        await fsp.mkdir(stage);
        await makeExecutable(working, path.join(stage, 'svtools-struct.exe'), values.version);
        for (const [source, file] of [
            [path.join(root, 'bin/svtools-format.exe'), 'svtools-format.exe'],
            ...['LICENSE', 'NOTICE', 'AUTHORS', 'THIRD_PARTY_NOTICES.md'].map(file => [path.join(root, file), 'licenses/' + file]),
            [path.join(root, 'bin/vendor/ELK-LICENSE.md'), 'licenses/ELK-LICENSE.md'],
            [values['node-license'] || path.join(path.dirname(process.execPath), 'LICENSE'), 'licenses/NODE-LICENSE.txt'],
            ...exampleFiles.map(file => [path.join(root, sample, file), sample + '/' + file])
        ]) await copyFile(source, path.join(stage, file));
        const readme = await fsp.readFile(path.join(root, 'docs/STRUCT_KIT.md'), 'utf8');
        await fsp.writeFile(path.join(stage, 'README.md'), readme.replace('../' + sample, sample));
        const files = await Promise.all(['svtools-struct.exe', 'svtools-format.exe'].map(async file => ({ file, sha256: await sha256(path.join(stage, file)) })));
        await fsp.writeFile(path.join(stage, 'BUILD.json'), JSON.stringify({ version: values.version, platform: 'win32-x64', node: process.version, files }, null, 2) + '\n');
        const zipped = path.join(working, 'kit.zip');
        await zip(stage, zipped);
        const unpacked = path.join(working, '解压 工具包');
        await extract(zipped, unpacked, name => name);
        for (const item of files) assert.equal(await sha256(path.join(unpacked, item.file)), item.sha256);
        const verified = await verify(unpacked, working);
        await fsp.mkdir(results);
        await copyFile(verified.image, path.join(results, 'packet_hub.svg'));
        await fsp.writeFile(path.join(results, 'verification.json'), JSON.stringify(verified.report, null, 2) + '\n');
        await copyFile(zipped, archive);
        const digest = await sha256(archive);
        await fsp.writeFile(archive + '.sha256', digest + '  ' + path.basename(archive) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ archive, sha256: digest, bytes: (await fsp.stat(archive)).size, results: verified.report }, null, 2));
    } finally {
        const actual = await fsp.realpath(working);
        if (path.dirname(actual) === bin && path.basename(actual).startsWith('.struct-kit-')) {
            await fsp.rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
