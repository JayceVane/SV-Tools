'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createToolTaskManager } = require('../src/toolchains/job');
const { runVivadoBatchTask } = require('../src/vivado/batch');
const { buildBatchArgs, findVivadoBinDir } = require('../src/vivado/toolchain');
const { tclQuote } = require('../src/vivado/tclgen');
const { script, readRows, rowsOf, parametersOf, literal, removeFromProject } = require('../src/vivado/asset-task');
const ip = require('../src/vivado/ip');
const bd = require('../src/vivado/block-design');
const { resolveSelection } = require('../src/vivado/block-design-view');
const { layoutSchematic } = require('../src/vivado/block-design-layout');
const { resolveEdits } = require('../src/vivado/ip-view');
const { parseXpr, samePath } = require('../src/vivado/xpr');

test('资产动作拒绝无效名称、任意生成目标、异类端点和只读元数据修改', () => {
    assert.throws(() => ip.create({ vlnv: 'xilinx.com:ip:xlconstant:1.1', name: 'new; exit' }), /名称/u);
    assert.throws(() => ip.create({ vlnv: 'xilinx.com:*', name: 'new_ip' }), /VLNV/u);
    assert.throws(() => ip.generate('example.xci', 'unsupported'), /生成目标/u);
    assert.throws(() => ip.configure('example.xci', [{ key: 'CONFIG.Component_Name', before: 'old', value: 'new' }]), /Vivado 管理/u);
    assert.throws(() => bd.connect('example.bd', { kind: 'pin', id: '/a/q' }, { kind: 'interface_pin', id: '/b/input' }), /端点/u);
    assert.doesNotMatch(literal('literal [exit]; $a \\n 测试'), /exit|literal|测试/u);
    const model = bd.snapshot([
        ['cell', '/scope', 'hier', ''], ['pin', '/scope/pin', 'O', 'data', '', ''],
        ['pin', '/scope/ip/out', 'O', 'data', '', ''], ['net', '/scope/wire', '/scope/pin', '/scope/ip/out'],
        ['interface_net', '/scope/unrelated', '/scope/pin']
    ]);
    assert.equal(resolveSelection(model, { action: 'remove', cell: 'constructor' }), undefined);
    assert.equal(resolveSelection(model, { action: 'connect', endpoint: 1 }), undefined);
    assert.equal(resolveSelection(model, { action: 'connect', endpoint: 1, level: 0 }).level, '/scope');
    assert.equal(resolveSelection(model, { action: 'connect', endpoint: 1, level: 0, destination: 0 }).destination.id, '/scope/pin');
    assert.equal(resolveSelection(model, { action: 'connect', endpoint: 1, level: 0, destination: 1 }), undefined);
    assert.equal(Boolean(resolveSelection(model, { action: 'disconnect', endpoint: 1, net: 1 })), false);
    assert.equal(resolveSelection(model, { action: 'disconnect', endpoint: 1, net: 0 }).net.id, '/scope/wire');
    const params = { parameters: [{ key: 'CONFIG.WIDTH', value: '4' }, { key: 'CONFIG.MODE', value: 'a' }] };
    const edits = [{ key: 'CONFIG.WIDTH', before: 'forged', value: '8' }, { key: 'CONFIG.MODE', value: 'a' }];
    assert.deepEqual(resolveEdits(edits, params), [{ key: 'CONFIG.WIDTH', before: '4', value: '8' }]);
    assert.equal(resolveEdits(edits, { ...params, locked: true }), undefined);
    assert.equal(resolveEdits([edits[0], edits[0]], params), undefined);
    assert.equal(resolveEdits([{ key: 'CONFIG.FORGED', value: '8' }], params), undefined);
});

test('Block Design 正交布局保留信号扇出、独立接口、边界端口和层级', async () => {
    const model = bd.snapshot([
        ['design', 'diagram'], ['cell', '/source', 'ip', 'test:ip:source:1.0'], ['cell', '/receiver', 'ip', 'test:ip:receiver:1.0'],
        ['cell', '/sub', 'hier', ''], ['cell', '/sub/sink', 'ip', 'test:ip:sink:1.0'],
        ['pin', '/source/range', 'O', 'data', '7', '0'], ['pin', '/receiver/in_data', 'I', 'data', '7', '0'],
        ['pin', '/sub/in_data', 'I', 'data', '7', '0'], ['pin', '/sub/sink/tap', 'I', 'data', '7', '0'],
        ['pin', '/source/irq', 'O', 'data', '0', '0'], ['port', '/irq_o', 'O', 'data', '0', '0'],
        ['interface_pin', '/source/S_AXI', 'Slave', 'test:interface:aximm:1.0'],
        ['interface_port', '/config', 'Slave', 'test:interface:aximm:1.0'],
        ['pin', '/source/axi_awready', 'O', 'data', '0', '0'], ['port', '/config_awready', 'O', 'data', '0', '0'],
        ['interface_members', '/source/S_AXI', '/source/axi_awready', '/source/irq'],
        ['interface_members', '/config', '/config_awready'],
        ['net', '/shared', '/source/range', '/receiver/in_data', '/sub/in_data'],
        ['interface_net', '/configuration', '/config', '/source/S_AXI'], ['net', '/interrupt', '/source/irq', '/irq_o'],
        ['net', '/sub/inner', '/sub/in_data', '/sub/sink/tap']
    ]);
    const Elk = require('elkjs/lib/elk.bundled.js');
    const options = { elk: new Elk() };
    const top = await layoutSchematic(model, '', options);
    const source = top.nodes.find(node => node.name === '/source');
    assert.equal(source.ports.find(port => port.label === 'range[7:0]').side, 'EAST');
    assert.equal(source.ports.find(port => port.label === 'S_AXI').side, 'WEST');
    assert(!source.ports.some(port => port.label === 'axi_awready'));
    assert(source.ports.some(port => port.label === 'irq'));
    assert(top.nodes.find(node => node.ports.some(port => port.name === '/config')).x < source.x);
    assert(top.nodes.find(node => node.ports.some(port => port.name === '/irq_o')).x > source.x);
    assert.equal(top.nodes.filter(node => node.kind === 'fork').length, 1);
    assert.equal(top.edges.filter(edge => edge.kind === 'bus').length, 3);
    assert.equal(top.edges.filter(edge => edge.kind === 'interface').length, 1);
    assert(!top.nodes.some(node => node.name === '/sub/sink'));
    const inner = await layoutSchematic(model, '/sub', options);
    assert.equal(inner.edges.length, 1);
    assert(inner.nodes.some(node => node.kind === 'boundary' && node.ports[0].name === '/sub/in_data'));
    const expanded = await layoutSchematic(model, '', { ...options, expandedInterfaces: true });
    assert(expanded.nodes.find(node => node.name === '/source').ports.some(port => port.label === 'axi_awready'));
    for (const edge of [...top.edges, ...inner.edges]) {
        for (const section of edge.sections) {
            const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
            assert(points.slice(1).every(({ x, y }, index) => x === points[index].x || y === points[index].y), edge.id);
        }
    }
});

const realBin = process.env.SVTOOLS_TEST_VIVADO_ASSETS === '1' && findVivadoBinDir('');

test('真实 Vivado 管理 IP 与 Block Design', { skip: !realBin && '需 SVTOOLS_TEST_VIVADO_ASSETS=1 与 Vivado', timeout: 480000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-vivado-assets-'));
    const jobs = createToolTaskManager({ retention: { keep: 40 } });
    let completed = false;
    t.after(async () => {
        await jobs.dispose();
        if (completed) {
            assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
            assert.match(path.basename(root), /^svtools-vivado-assets-/u);
            await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
        else t.diagnostic('复现目录 ' + root);
    });
    const exe = path.join(realBin, process.platform === 'win32' ? 'vivado.bat' : 'vivado');
    const xpr = path.join(root, 'primary', 'primary.xpr');
    const other = path.join(root, 'secondary', 'secondary.xpr');
    const constant = 'xilinx.com:ip:xlconstant:1.1';
    const vectorLogic = 'xilinx.com:ip:util_vector_logic:2.0';
    const launch = async (name, body, target, readOnly = false, expectFailure = false) => {
        const job = jobs.start('vivado');
        const folder = await job.directory(path.join(root, 'tasks'), 'vivado');
        const file = path.join(folder, 'action.tcl');
        try {
            await fs.writeFile(file, target ? script(target, body, { readOnly }) : body);
            const output = await runVivadoBatchTask({ task: job, executable: exe, args: buildBatchArgs(file), cwd: folder, scriptPath: file, timeoutMs: 90000 });
            assert.equal(output.ok, !expectFailure, name + ' · ' + output.logPath + '\n' + output.stdout);
            const rows = target && !expectFailure ? await readRows(folder) : [];
            return { rows, folder, output };
        } finally {
            await job.finish({ keepArtifacts: true });
        }
    };
    const part = process.env.SVTOOLS_TEST_VIVADO_PART || 'xc7z100ffg900-2';
    await launch('新建两个隔离工程', [xpr, other].map(file =>
        'create_project ' + tclQuote(path.basename(file, '.xpr')) + ' ' + tclQuote(path.dirname(file)) + ' -part ' + literal(part) + '\nclose_project').join('\n'));
    const catalog = await launch('搜索真实目录', ip.catalog(true), xpr, true);
    assert(rowsOf(catalog.rows, 'definition').some(([id]) => id === constant));
    const made = await launch('实例化独立 IP', ip.create({ vlnv: constant, name: 'fixed_value' }), xpr);
    const ipFile = rowsOf(made.rows, 'created')[0][0];
    assert(parseXpr(xpr).sets.some(set => set.files.some(file => samePath(file, ipFile))));
    const info = await launch('从 IP 读取参数和实际锁定状态', ip.info(ipFile), xpr);
    assert.equal(rowsOf(info.rows, 'ip')[0][1], constant);
    assert.equal(rowsOf(info.rows, 'ip')[0][2], '0');
    const width = parametersOf(info.rows).find(param => param.key === 'CONFIG.CONST_WIDTH');
    assert(width);
    const change = { key: width.key, before: width.value, value: '4' };
    const generated = await launch('配置宽度并生成综合、仿真和模板', [
        ...ip.configure(ipFile, [change], { readBack: true }), ...ip.generate(ipFile, 'synthesis'), ...ip.generate(ipFile, 'simulation'), ...ip.template(ipFile, '.veo')
    ], xpr);
    assert.equal(parametersOf(generated.rows).find(param => param.key === width.key).value, '4');
    assert.match(await fs.readFile(path.join(generated.folder, 'template.veo'), 'utf8'), /fixed_value/u);
    const stale = await launch('拒绝覆盖已变化的参数', ip.configure(ipFile, [change]), xpr, false, true);
    assert.match(stale.output.stdout, /CONFIG\.CONST_WIDTH/u);
    const updated = await launch('重新读取参数', ip.info(ipFile), xpr, true);
    assert.equal(parametersOf(updated.rows).find(param => param.key === width.key).value, '4');
    const importedResult = await launch('拷贝现有 IP', ip.importSource(ipFile, true), other);
    const imported = parseXpr(other).sets.flatMap(set => set.files).find(file => file.endsWith('fixed_value.xci'));
    assert(imported && !samePath(imported, ipFile) && samePath(imported, rowsOf(importedResult.rows, 'imported')[0][0]));
    await launch('移出复制项，改为引用原 IP', [
        ...removeFromProject(imported, 'sources_1'), ...ip.importSource(ipFile, false)
    ], other);
    assert(parseXpr(other).sets.some(set => set.files.some(item => samePath(item, ipFile))));
    await fs.access(imported);
    const repository = path.join(root, 'custom_repo');
    await fs.mkdir(repository);
    const counter = await launch('注册自定义仓库并创建可 OOC 的 IP', [
        ...ip.setRepositories([], [repository]), ...ip.repositories(),
        ...ip.create({ vlnv: 'xilinx.com:ip:c_counter_binary:12.0', name: 'review_counter' })
    ], xpr);
    assert(samePath(rowsOf(counter.rows, 'repo')[0][0], repository));
    const counterFile = rowsOf(counter.rows, 'created')[0][0];
    const ooc = await launch('读取可综合 IP 的状态并运行 OOC', [...ip.info(counterFile), ...ip.synthesize(counterFile)], xpr);
    assert.match(rowsOf(ooc.rows, 'ip')[0][4], /^(1|true)$/u);
    await fs.access(path.join(path.dirname(xpr), 'primary.runs', 'review_counter_synth_1', 'review_counter.dcp'));
    const sameDesign = body => body.slice(2);
    const axiPort = { kind: 'interface_port', id: '/S_AXI' };
    const addresses = await launch('创建独立 AXI 接口试点', [
        ...bd.create('design_axi'), 'create_bd_cell -type ip -vlnv xilinx.com:ip:axi_gpio:2.0 gpio',
        ...sameDesign(bd.addInterfacePort('design_axi.bd', { name: 'S_AXI', mode: 'Slave', vlnv: 'xilinx.com:interface:aximm_rtl:1.0' })),
        ...sameDesign(bd.configurePort('design_axi.bd', axiPort, [{ key: 'CONFIG.PROTOCOL', before: 'AXI4', value: 'AXI4LITE' }])),
        ...sameDesign(bd.connect('design_axi.bd', axiPort, { kind: 'interface_pin', id: '/gpio/S_AXI' })),
        ...sameDesign(bd.assignAddresses('design_axi.bd'))
    ], other);
    const axi = rowsOf(addresses.rows, 'created')[0][0];
    const axiModel = bd.snapshot((await launch('读取 AXI 接口与连接', bd.read(axi), other, true)).rows);
    const gpio = axiModel.endpoints.find(item => item.id === '/gpio/S_AXI');
    const host = axiModel.endpoints.find(item => item.id === '/S_AXI');
    const interconnect = axiModel.nets.find(net => net.kind === 'interface_net' && net.endpoints.includes(gpio.id));
    assert(interconnect && host);
    const rebuild = (await launch('断开、复连 AXI 接口并引出 GPIO 端口', [
        ...bd.disconnect(axi, interconnect, host), ...bd.connect(axi, gpio, host).slice(2),
        ...bd.externalize(axi, { kind: 'interface_pin', id: '/gpio/GPIO' }).slice(2)
    ], other)).output;
    assert(rebuild.ok);
    const design = await launch('新建 Block Design', bd.create('design_io'), xpr);
    const designFile = rowsOf(design.rows, 'created')[0][0];
    const [openFile, openDesign, ...addA] = bd.addCell(designFile, { type: 'ip', name: 'a', reference: constant });
    const out = { kind: 'port', id: '/dout' };
    const a = { kind: 'pin', id: '/a/dout' };
    const input = { kind: 'pin', id: '/b/Op1' };
    const result = { kind: 'pin', id: '/b/Res' };
    await launch('搭建设计并校验', [openFile, openDesign, ...addA,
        ...sameDesign(bd.addCell(designFile, { type: 'ip', name: 'b', reference: vectorLogic })),
        'set_property -dict {CONFIG.C_OPERATION not CONFIG.C_SIZE 1} [get_bd_cells b]',
        ...sameDesign(bd.addPort(designFile, { name: 'dout', direction: 'O', width: 1, type: 'data' })),
        ...sameDesign(bd.connect(designFile, a, input)),
        ...sameDesign(bd.connect(designFile, result, out)), ...sameDesign(bd.validate(designFile))
    ], xpr);
    const structure = bd.snapshot((await launch('读取实例、端口和网络', bd.read(designFile), xpr, true)).rows);
    assert(structure.cells.some(cell => cell.id === '/a' && cell.vlnv === constant));
    assert(structure.endpoints.some(endpoint => endpoint.id === '/b/Res' && endpoint.direction === 'O'));
    const link = structure.nets.find(net => net.endpoints.includes('/dout'));
    assert.deepEqual(new Set(link.endpoints), new Set(['/b/Res', '/dout']));
    await launch('断开并复连', [...bd.disconnect(designFile, link, out), ...sameDesign(bd.connect(designFile, result, out, link))], xpr);
    const output = await launch('生成 BD 产物与 wrapper', bd.wrapper(designFile), xpr);
    assert(parseXpr(xpr).sets.some(set => set.files.some(file => /design_io_wrapper\.(v|vhd)$/u.test(file))));
    assert(output.output.ok);
    const exported = await launch('导出可重建设计的 Tcl', bd.exportTcl(designFile), xpr, true);
    assert.match(await fs.readFile(path.join(exported.folder, 'block-design.tcl'), 'utf8'), /connect_bd_net/u);
    completed = true;
});
