'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createToolTaskManager } = require('../src/toolchains/job');
const { runVivadoBatchTask } = require('../src/vivado/batch');
const { buildBatchArgs, findVivadoBinDir } = require('../src/vivado/toolchain');
const { createVivadoSessions } = require('../src/vivado/session');
const { tclQuote } = require('../src/vivado/tclgen');
const { script, sessionScript, readRows, rowsOf, parametersOf, literal, removeFromProject } = require('../src/vivado/asset-task');
const ip = require('../src/vivado/ip');
const bd = require('../src/vivado/block-design');
const { resolveSelection, createSchematicLayouts } = require('../src/vivado/block-design-view');
const { digest } = require('../src/vivado/block-design-cache');
const { layoutSchematic } = require('../src/vivado/block-design-layout');
const { resolveEdits } = require('../src/vivado/ip-view');
const { savedBlock, savedIp } = require('../src/vivado/asset-preview');
const { createIpMetadata } = require('../src/vivado/ip-metadata');
const { parseXpr, samePath } = require('../src/vivado/xpr');
const summary = require('../src/vivado/summary');
const { createSummaryReports, analysisCommands } = require('../src/vivado/summary-reports');
const { createSummaryMessages } = require('../src/vivado/summary-messages');

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
    assert.equal(resolveEdits(edits, { ...params, preview: true }), undefined);
    assert.equal(resolveEdits([edits[0], edits[0]], params), undefined);
    assert.equal(resolveEdits([{ key: 'CONFIG.FORGED', value: '8' }], params), undefined);
});

test('地址编辑器按主地址空间分组，改址与映射只接受快照里可验证的段', () => {
    const model = bd.snapshot([
        ['address_space', '/S_AXI_0', '0x0000000000008000', 'port', '/S_AXI_0', 'Slave'],
        ['address', '/S_AXI_0', '/S_AXI_0/SEG_bram_Mem0', 'SEG_bram_Mem0', '0x0000', '0x1000'],
        ['address_space', '/bram/S_AXI', '0x00008000', 'pin', '/bram/S_AXI', 'Slave'],
        ['address', '/bram/S_AXI', '/bram/S_AXI/Mem0', 'Mem0', '', '0x00001000']
    ]);
    assert.equal(model.spaces.length, 2);
    assert.deepEqual(model.spaces[0].owner, { kind: 'port', id: '/S_AXI_0', mode: 'Slave' });
    assert.equal(model.spaces[0].segments[0].name, 'SEG_bram_Mem0');
    assert.equal(model.spaces[1].segments[0].offset, '');
    const edit = resolveSelection(model, { action: 'address-edit', space: '/S_AXI_0', segment: '/S_AXI_0/SEG_bram_Mem0',
        offset: '0x1000', range: '0x1000' });
    assert.deepEqual(edit, { space: '/S_AXI_0', segment: '/S_AXI_0/SEG_bram_Mem0', offset: '0x1000', range: '0x1000' });
    assert.equal(resolveSelection(model, { action: 'address-edit', space: '/S_AXI_0', segment: '/S_AXI_0/SEG_bram_Mem0',
        offset: '0x', range: '0x1000' }), undefined);
    assert.equal(resolveSelection(model, { action: 'address-edit', space: '/S_AXI_0', segment: '/missing', offset: '0x1000', range: '0x1000' }), undefined);
    assert.deepEqual(resolveSelection(model, { action: 'address-map', segment: '/bram/S_AXI/Mem0' }), { segment: '/bram/S_AXI/Mem0' });
    assert.equal(resolveSelection(model, { action: 'address-map', segment: '/S_AXI_0/SEG_bram_Mem0' }), undefined);
    assert.throws(() => bd.setAddress('x.bd', '/a/b', { offset: '4096', range: '0x1000' }), /十六进制/u);
    assert.throws(() => bd.mapAddress('x.bd', { space: '/s', segment: '/a/b', offset: '0x1000', range: '0x1000; exit' }), /十六进制/u);
    const script = bd.mapAddress('x.bd', { space: '/S_AXI_0', segment: '/bram/S_AXI/Mem0', offset: '0x2000', range: '0x1000' }).join('\n');
    assert.equal(script.includes('assign_bd_address -target_address_space $space -offset '), true);
    assert.match(bd.setAddress('x.bd', '/S_AXI_0/SEG_bram_Mem0', { offset: '0x1000', range: '0x1000' }).join('\n'), /set_property range/);
});

test('常驻会话脚本不重开工程，工程概览解析运行状态', () => {
    const body = sessionScript(['sv_row design demo']);
    assert.match(body, /SVTOOLS_ASSETS_V1/);
    assert.match(body, /sv_row design demo/);
    assert.doesNotMatch(body, /open_project|close_project|exit 1/);
    const data = summary.parse([
        ['project', 'demo', 'xc7a35tcsg324-1', 'C:/demo', 'top', ''],
        ['run', 'synth_1', 'Complete', '100%', 'Vivado Synthesis Defaults', '0', 'synth_design', '00:01:22', '', '', '', '', '0.5', '0'],
        ['run', 'impl_1', 'Running', 'Running', 'Performance', '1', 'place_design', '00:00:31', '-0.123', '-1.2', '0.05', '0', '1.2', '1', path.resolve('bin/custom-impl')],
        ['current_runs', 'synth_1', 'impl_1']
    ]);
    assert.equal(data.project.name, 'demo');
    assert.equal(data.project.part, 'xc7a35tcsg324-1');
    assert.equal(data.runs.length, 2);
    assert.equal(data.runs[1].timing.wns, -0.123);
    assert.equal(data.runs[1].needsRefresh, true);
    assert.equal(data.runs[1].implementation, true);
    assert.deepEqual(data.currentRuns, { synthesis: 'synth_1', implementation: 'impl_1' });
    assert.equal(summary.isActive(data.runs[1]), true);
    assert.equal(summary.isActive(data.runs[0]), false);
    const paths = summary.runPaths(data, path.join('C:', 'work', 'demo.xpr'));
    assert.equal(paths.synth_1.log.endsWith(path.join('demo.runs', 'synth_1', 'runme.log')), true);
    assert.equal(paths.impl_1.log, path.resolve('bin/custom-impl/runme.log'));
});

test('工程概览保留自定义顶层运行，隐藏 IP 和模块子运行', () => {
    const run = (id, source, parent, implementation) => ['run', id, 'Complete', '100%', '', '0', '', '', '', '', '', '', '',
        implementation ? '1' : '0', '', source, parent, implementation ? '0' : '1'];
    const data = summary.parse([
        ['fileset', 'rtl', 'DesignSrcs'], ['fileset', 'clock_ip', 'BlockSrcs'],
        run('rtl_synthesis', 'rtl', '', false), run('production', 'rtl', 'rtl_synthesis', true),
        run('clock_factory', 'clock_ip', '', false), run('clock_implementation', 'clock_ip', 'clock_factory', true),
        run('clock_implementation_with_main_srcset', 'rtl', 'clock_factory', true)
    ]);
    assert.deepEqual(data.runs.map(({ id }) => id), ['rtl_synthesis', 'production']);
    assert.deepEqual(Object.keys(summary.runPaths(data, path.resolve('demo.xpr'))), ['rtl_synthesis', 'production']);
});

test('运行消息按日志统计级别，支持筛选分页、原始行号和日志更新', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-messages-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const synthLog = path.join(directory, 'synth.log'), implLog = path.join(directory, 'impl.log');
    const paths = { synth_1: { log: synthLog }, impl_1: { log: implLog } };
    const critical = ['Command: route_design', 'CRITICAL WARNING: [Timing 38-35] Timing verification failed.',
        '  Generated clock is missing.', 'INFO: [Route 35-1] Info message.', 'STATUS: Complete'].join('\r\n');
    await Promise.all([
        fs.writeFile(synthLog, ['# synth_design -top demo', ...Array.from({ length: 52 }, (_, i) => `WARNING: [Synth 8-${i}] Sample ${i}`)].join('\n')),
        fs.writeFile(implLog, critical)
    ]);
    const messages = createSummaryMessages();
    const first = await messages.summarize(paths);
    assert.equal(first.synth_1.counts.warnings, 52);
    assert.deepEqual(first.impl_1.counts, { errors: 0, criticalWarnings: 1, warnings: 0, info: 1, status: 1 });
    const secondPage = messages.page(paths, { run: 'synth_1', level: 'warnings', offset: 50 });
    assert.equal(secondPage.total, 52);
    assert.deepEqual(secondPage.items.map(item => item.line), [52, 53]);
    assert.deepEqual(messages.page(paths, { run: 'impl_1', level: 'criticalWarnings', search: 'generated CLOCK' }).items, [{
        run: 'impl_1', level: 'criticalWarnings', id: 'Timing 38-35', step: 'route_design', line: 2,
        text: 'Timing verification failed.\nGenerated clock is missing.'
    }]);
    assert.deepEqual(messages.location(paths, 'impl_1', 2), { file: implLog, line: 2 });
    assert.equal(messages.location(paths, 'impl_1', 6), undefined);
    assert.equal(messages.location(paths, 'unknown', 1), undefined);
    await fs.writeFile(implLog, critical.replace('verification failed', 'verification needs review'));
    const refreshed = await messages.summarize(paths);
    assert.notEqual(refreshed.impl_1.revision, first.impl_1.revision);
    assert.equal(messages.page(paths, { search: 'needs review' }).total, 1);
});

test('概览按实际阶段汇总资源、功耗、DRC，缺报告时回退且使用检查点指纹生成', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-overview-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const implementation = path.join(directory, 'impl_1'), synthesis = path.join(directory, 'synth_1');
    const tasks = path.join(directory, 'tasks');
    await Promise.all([implementation, synthesis, tasks].map(item => fs.mkdir(item)));
    let savedReports;
    const workspaceState = {
        get: (_, fallback) => savedReports || fallback,
        async update(_, value) { savedReports = structuredClone(value); }
    };
    let read = createSummaryReports(workspaceState);
    const snapshot = {
        currentRuns: { synthesis: 'synth_1', implementation: 'impl_1' },
        runs: [{ id: 'synth_1', power: null, status: 'synth_design Complete!' },
            { id: 'impl_1', power: 0.123, status: 'route_design Complete!', needsRefresh: true,
                implementation: true, timing: { wns: -0.15, tns: -2.4 } }]
    };
    const paths = { synth_1: { directory: synthesis }, impl_1: { directory: implementation } };
    const resource = count => '| Site Type | Used | Fixed | Prohibited | Available | Util% |\n' +
        '| CLB LUTs* | ' + count + ' | 0 | 0 | 5,000 | -- |\n| Block RAM Tile | 1.5 | 0 | 0 | 200 | -- |\n';
    await Promise.all([
        fs.writeFile(path.join(synthesis, 'top_utilization_synth.rpt'), resource(250)),
        fs.writeFile(path.join(synthesis, 'top.dcp'), 'synthesized'),
        fs.writeFile(path.join(implementation, 'top_routed.dcp'), 'routed'),
        fs.writeFile(path.join(implementation, 'top_drc_opted.rpt'), 'Violations found: 0\n'),
        fs.writeFile(path.join(implementation, 'top_methodology_drc_routed.rpt'), 'Violations found: 0\n')
    ]);
    let { results, generation } = await read.read(snapshot, paths);
    assert.equal(results.utilization.synthesis.run, 'synth_1');
    assert.equal(results.utilization.implementation, undefined);
    assert.equal(results.power.data.total, 0.123);
    assert.deepEqual(results.timing.data, { wns: -0.15, tns: -2.4 });
    assert.equal(results.drc.data.total, 0);
    assert.equal(results.drc.phase, 'opted');
    assert.deepEqual(generation.kinds, ['utilization', 'timing', 'power']);
    assert.equal(await read.isCurrent(generation), true);
    assert.match(analysisCommands(generation).join('\n'), /open_run.*\n.*report_utilization.*\n.*report_timing_summary.*\n.*report_power/u);
    assert.doesNotMatch(analysisCommands(generation).join('\n'), /launch_runs|report_drc/u);

    await Promise.all([
        fs.writeFile(path.join(tasks, 'summary_power.rpt'), '| Total On-Chip Power (W) | 0.105 |\n| Dynamic (W) | 0.001 |\n' +
            '| Device Static (W) | 0.104 |\n| Confidence Level | Medium |\n\n1.1 On-Chip Components\n' +
            '| On-Chip | Power (W) |\n| Clocks | 0.001 |\n| Slice Logic | <0.001 |\n|   Register | <0.001 |\n' +
            '| Static Power | 0.104 |\n| Total | 0.105 |\n\n1.2 Power Supply Summary\n'),
        fs.writeFile(path.join(tasks, 'summary_timing.rpt'), ['| Design Timing Summary', '',
            ['WNS(ns)', 'TNS(ns)', 'TNS Failing Endpoints', 'TNS Total Endpoints', 'WHS(ns)', 'THS(ns)', 'THS Failing Endpoints',
                'THS Total Endpoints', 'WPWS(ns)', 'TPWS(ns)', 'TPWS Failing Endpoints', 'TPWS Total Endpoints'].join('    '),
            '-----    ------', ['-0.150', '-2.400', '3', '127', 'inf', '0.000', '0', '127', '-0.040', '-0.080', '2', '38'].join('    ')
        ].join('\n')),
        fs.writeFile(path.join(implementation, 'top_utilization_placed.rpt'), resource(325)),
        fs.writeFile(path.join(implementation, 'top_drc_routed.rpt'), 'Violations found: 3\n+---+\n| Rule | Severity | Description | Violations |\n' +
            '+---+\n| NSTD-1 | Critical Warning | I/O | 2 |\n| P-1 | Warning | Ports | 1 |\n+---+\n')
    ]);
    const request = generation;
    await read.remember(request, tasks);
    read = createSummaryReports(workspaceState);
    ({ results, generation } = await read.read(snapshot, paths));
    assert.equal(generation, null);
    assert.equal(results.utilization.implementation.stale, true);
    assert.equal(results.utilization.implementation.phase, 'placed');
    assert.equal(results.utilization.synthesis.data[0].used, 250);
    assert.deepEqual(results.utilization.implementation.data, [
        { resource: 'lut', used: 325, available: 5000 }, { resource: 'bram', used: 1.5, available: 200 }
    ]);
    assert.deepEqual(results.power.data, { total: 0.105, dynamic: 0.001, static: 0.104, confidence: 'Medium',
        components: [{ label: 'Clocks', watts: 0.001, below: null }, { label: 'Slice Logic', watts: null, below: 0.001 },
            { label: 'Static Power', watts: 0.104, below: null }] });
    assert.equal(results.timing.phase, 'routed');
    assert.equal(results.timing.data.whs, null);
    assert.equal(results.timing.data.setupFailing, 3);
    assert.equal(results.timing.data.wpws, -0.04);
    assert.equal(results.timing.data.pulseTotal, 38);
    assert.equal(results.drc.phase, 'routed');
    assert.equal(results.drc.data.total, 3);
    assert.equal(results.drc.data.counts.criticalWarnings, 2);
    await fs.unlink(path.join(synthesis, 'top_utilization_synth.rpt'));
    ({ results, generation } = await read.read(snapshot, paths));
    assert.equal(results.utilization.synthesis, undefined);
    assert.equal(generation.run, 'synth_1');
    assert.deepEqual(generation.kinds, ['utilization']);
    await fs.writeFile(path.join(implementation, 'top_routed.dcp'), 'new routed checkpoint');
    assert.equal(await read.isCurrent(request), false);
    ({ results, generation } = await read.read(snapshot, paths));
    assert.equal(results.power.data.total, 0.123);
    assert.deepEqual(generation.kinds, ['timing', 'power']);
});

test('Block Design 布局在宿主重启后复用坐标，结构、层级和接口展开状态分别匹配', async t => {
    const temp = await fs.realpath(os.tmpdir());
    const folder = await fs.mkdtemp(path.join(temp, 'svtools-bd-cache-'));
    t.after(async () => { if (path.dirname(folder) === temp) await fs.rm(folder, { recursive: true, force: true }); });
    const source = { name: 'demo', cells: [{ id: '/sub', type: 'hier' }] };
    let calls = 0;
    const engine = async (model, level, { expandedInterfaces }) => ({ width: ++calls, name: model.name, level, expandedInterfaces });
    const first = createSchematicLayouts(folder, engine);
    const id = digest(source);
    const [one, duplicate] = await Promise.all([first.resolve(id, source, '', false), first.resolve(id, source, '', false)]);
    assert.equal(calls, 1);
    assert.deepEqual(one, duplicate);
    const reopened = createSchematicLayouts(folder, engine);
    assert.deepEqual(await reopened.get(id, '', false), one);
    assert.deepEqual(await reopened.resolve(id, source, '', false), one);
    assert.equal(calls, 1);
    await reopened.resolve(id, source, '/sub', false);
    await reopened.resolve(id, source, '', true);
    const changed = { ...source, cells: [] };
    assert.equal(await reopened.resolve(digest(changed), changed, '', false).then(item => item.width), 4);
});

test('磁盘预览读取 XCI 保存值和 BD 层级连接，保留端口方向证据的边界', () => {
    const xml = `<s:design xmlns:s="urn:ipxact"><s:componentInstances><s:componentInstance>
        <s:instanceName>counter</s:instanceName><s:componentRef s:vendor="xilinx.com" s:library="ip" s:name="counter" s:version="1.0"/>
        <s:configurableElementValues><s:configurableElementValue s:referenceId="PARAM_VALUE.Width">12</s:configurableElementValue>
        <s:configurableElementValue s:referenceId="MODELPARAM_VALUE.Width">24</s:configurableElementValue>
        <s:configurableElementValue s:referenceId="PARAM_VALUE.Empty"/></s:configurableElementValues>
        </s:componentInstance></s:componentInstances></s:design>`;
    const preview = savedIp(xml, 'counter.xci');
    assert.equal(preview.vlnv, 'xilinx.com:ip:counter:1.0');
    assert.deepEqual(preview.parameters.map(({ key, value }) => [key, value]), [['CONFIG.Width', '12'], ['CONFIG.Empty', '']]);
    assert.equal(resolveEdits([{ key: 'CONFIG.Width', value: '6' }], preview), undefined);
    const json = { ip_inst: { xci_name: 'fifo', component_reference: 'xilinx.com:ip:fifo:1.2',
        parameters: { component_parameters: { Width: [{ value: '8' }] } } } };
    assert.equal(savedIp(JSON.stringify(json), 'fifo.xci').parameters[0].value, '8');
    const bdFile = { design: { design_info: { name: 'example' }, ports: { output: { direction: 'O', left: '7', right: '0' } },
        components: { sub: { components: { fifo: { vlnv: 'xilinx.com:ip:fifo:1.2' } } } }, nets: { link: { ports: ['sub/Q', 'output'] } } } };
    const graph = savedBlock(JSON.stringify(bdFile));
    assert.deepEqual(graph.cells.map(cell => [cell.id, cell.type]), [['/sub', 'hier'], ['/sub/fifo', 'ip']]);
    assert.deepEqual(graph.nets[0].endpoints, ['/sub/Q', '/output']);
    assert.equal(graph.endpoints.find(endpoint => endpoint.id === '/sub/Q').direction, '');
    assert.equal(graph.endpoints.find(endpoint => endpoint.id === '/output').right, '0');
});

test('IP 包提供显示名、选项和 XGUI 分组，校验使用修改后的依赖值', async t => {
    const temp = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temp, 'svtools-ip-metadata-'));
    t.after(async () => { if (path.dirname(root) === temp) await fs.rm(root, { recursive: true, force: true }); });
    await fs.mkdir(path.join(root, 'xgui'));
    const component = path.join(root, 'component.xml');
    await fs.writeFile(component, `<component><vendor>xilinx.com</vendor><library>ip</library><name>axi_gpio</name><version>2.0</version>
        <parameters><parameter><name>C_GPIO2_WIDTH</name><displayName>GPIO Width</displayName><value format="long" minimum="1" maximum="32">32</value></parameter>
        <parameter><name>C_IS_DUAL</name><value choiceRef="boolean">0</value></parameter></parameters>
        <choices><choice><name>boolean</name><enumeration text="Off">0</enumeration><enumeration text="On">1</enumeration></choice></choices>
        <fileSets><fileSet><name>xilinx_xpgui_view_fileset</name><file><name>xgui/core.tcl</name></file></fileSet></fileSets></component>`);
    await fs.writeFile(path.join(root, 'xgui', 'core.tcl'), `set page [ipgui::add_page $root -name Default]
set_property display_name "IP Configuration" $page
set group [ipgui::add_group $root -name "GPIO 2" -parent $page]
set panel [ipgui::add_panel $root -name panel -parent $group]
set width [ipgui::add_param $root -name C_GPIO2_WIDTH -parent $panel]
set_property tooltip "Set the GPIO port width" $width
ipgui::add_static_text $root -parent $panel -name hint -text "[0x0,0xFFFF]"
error "Arbitrary Tcl must not be run"`);
    const [width, dual] = ['CONFIG.C_GPIO2_WIDTH', 'CONFIG.C_IS_DUAL'];
    const details = await createIpMetadata()({ vlnv: 'xilinx.com:ip:axi_gpio:2.0', parameters:
        [[width, '32'], [dual, '0'], ['CONFIG.GPIO2_BOARD_INTERFACE', 'Custom']].map(([key, value]) => ({ key, value, choices: [] })) }, component);
    const [first, second] = details.parameters;
    assert.deepEqual([first.label, first.help, first.group, first.min, first.max], ['GPIO Width', 'Set the GPIO port width', 'IP Configuration / GPIO 2', '1', '32']);
    assert.deepEqual(second.optionLabels, [['0', 'Off'], ['1', 'On']]);
    // Vivado 不返回 choices 时用 component.xml 的枚举补齐，供下拉框使用。
    assert.deepEqual(second.choices, ['0', '1']);
    assert.deepEqual(details.notes, [{ group: 'IP Configuration / GPIO 2', texts: ['[0x0,0xFFFF]'] }]);
    const runtime = {
        params: new Map([['C_GPIO2_WIDTH', { label: 'GPIO Width', help: 'Set the GPIO port width', group: 'IP Configuration / GPIO 2', widget: 'textEdit' }]]),
        notes: new Map([['IP Configuration / GPIO 2', ['运行时说明']]]),
        enabled: new Map([['C_GPIO2_WIDTH', false]]),
        hidden: { pages: new Set(['AXI 页面']), groups: new Set(), params: new Set(['C_GPIO2_WIDTH']) }
    };
    const live = await createIpMetadata()({ vlnv: 'xilinx.com:ip:axi_gpio:2.0', parameters:
        [[width, '32'], [dual, '0']].map(([key, value]) => ({ key, value, choices: [] })) }, component, runtime);
    assert.equal(live.parameters[0].disabled, true);
    assert.deepEqual(live.parameters[1].choices, ['0', '1']);
    assert.deepEqual(live.hidden, { pages: ['AXI 页面'], groups: [], params: ['C_GPIO2_WIDTH'] });
    assert.deepEqual(live.notes, [{ group: 'IP Configuration / GPIO 2', texts: ['[0x0,0xFFFF]', '运行时说明'] }]);
    assert.equal(resolveEdits([{ key: width, value: '12' }], details), undefined);
    assert.equal(resolveEdits([{ key: width, value: '12' }, { key: dual, value: '1' }], details).length, 2);
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
    const config = top.nodes.find(node => node.ports[0]?.name === '/config');
    const interrupt = top.nodes.find(node => node.ports[0]?.name === '/irq_o');
    assert(config.x < source.x && config.terminal.labelX < config.terminal.left);
    assert(interrupt.x > source.x && interrupt.terminal.labelX > interrupt.terminal.right);
    assert.equal(config.ports[0].x, config.terminal.right);
    assert.equal(interrupt.x + interrupt.ports[0].x, interrupt.x + interrupt.terminal.left);
    const [externalWire] = top.edges.find(edge => model.nets[edge.net].id === '/interrupt').sections;
    assert.deepEqual(externalWire.endPoint, { x: interrupt.x + interrupt.terminal.left, y: interrupt.y + interrupt.terminal.centerY });
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
    const mapped = axiModel.spaces.flatMap(space => space.segments).find(segment => segment.offset);
    assert.ok(mapped, 'AXI 地址段已映射');
    const sessions = createVivadoSessions();
    async function runSession(name, body) {
        const directory = path.join(root, name);
        await fs.mkdir(directory);
        const scriptPath = path.join(directory, 'session.tcl');
        await fs.writeFile(scriptPath, sessionScript(body));
        const output = await sessions.run({ binDir: realBin, xpr: other, directory, scriptPath, name, watch: [axi], timeoutMs: 60000 });
        return { ...output, rows: output.ok ? await readRows(directory) : [] };
    }
    try {
        const baseline = await runSession('address_baseline', bd.setAddress(axi, mapped.id, { offset: '0x40000000', range: '0x10000' }));
        assert.equal(baseline.ok, true, baseline.stdout);
        const disk = await fs.readFile(axi, 'utf8');
        const rejected = await runSession('address_rejected', bd.setAddress(axi, mapped.id, { offset: '0x100000000', range: '0x8000' }));
        assert.equal(rejected.ok, false);
        assert.match(rejected.stdout, /aperture/u);
        assert.equal(await fs.readFile(axi, 'utf8'), disk);
        const later = await runSession('address_unrelated_edit', [
            ...bd.addCell(axi, { type: 'hier', name: 'scope' }),
            ...sameDesign(bd.addCell(axi, { type: 'ip', name: 'value', reference: constant, parent: '/scope' })),
            ...bd.inspect()
        ]);
        assert.equal(later.ok, true, later.stdout);
        const saved = bd.snapshot(later.rows);
        assert(saved.cells.some(cell => cell.id === '/scope/value' && cell.vlnv === constant));
        const segment = saved.spaces.flatMap(space => space.segments).find(item => item.id === mapped.id);
        assert.equal(BigInt(segment.range), 0x10000n, '随后保存其他修改不能带上失败的范围变更');
    } finally { await sessions.dispose(); }
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


test('IP 读取兼容不支持 -exclude_bd_ips 的 Vivado', () => {
    const body = ip.info('D:/work/demo/demo.srcs/sources_1/ip/fixed_value/fixed_value.xci');
    assert.ok(body.some(line => line.includes('[sv_standalone_ips]')));
    assert.ok(!body.some(line => /get_ips -quiet -exclude_bd_ips/u.test(line)));
    const generated = sessionScript(body);
    assert.match(generated, /proc sv_standalone_ips/u);
    // 老版本没有该选项时退回按 BD 目录过滤。
    assert.match(generated, /catch \{get_ips -quiet -exclude_bd_ips/u);
    assert.match(generated, /sources_1 bd/u);
});
