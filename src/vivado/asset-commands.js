'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { cancelledError } = require('../toolchains/job');
const { parseXpr, samePath } = require('./xpr');
const { script, readRows, rowsOf, parametersOf, removeFromProject } = require('./asset-task');
const { openBlockDesignPanels } = require('./block-design-view');
const ip = require('./ip');
const bd = require('./block-design');

const IP_EXTENSION = /\.(xci|xcix)$/iu;
const BD_EXTENSION = /\.bd$/iu;
const choices = entries => entries.map(([value, label, description]) => ({ value, label, description }));
const member = (project, file, fileset) => project.sets.some(set =>
    (!fileset || fileset === set.name) && set.files.some(item => samePath(item, file)));

function assets(project, extension) {
    return project.sets.flatMap(set => set.files.filter(file => extension.test(file)).map(file => ({
        file, fileset: set.name, label: path.basename(file), description: set.name, detail: path.relative(path.dirname(project.path), file)
    })));
}

const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');

function activateAssetCommands(context, { vscode, findProjectXpr, incrementalAction, runIncrementalTcl, pickerToken, refresh }) {
    const catalogCache = new Map();
    const window = vscode.window;
    const pick = (items, title, options = {}) => window.showQuickPick(items, {
        title, matchOnDescription: true, matchOnDetail: true, ...options
    }, pickerToken());
    const input = (title, options = {}) => window.showInputBox({ title, ...options }, pickerToken());
    const nameInput = (title, value) => input(title, { value, validateInput: text =>
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(text) ? undefined : '名称须以字母或下划线开头，可包含数字' });
    const files = options => window.showOpenDialog({ canSelectMany: false, ...options });
    const confirm = async (message, button) => await window.showWarningMessage(message, { modal: true }, button) === button;

    function projectAction(label, expectedXpr, callback) {
        return incrementalAction(label, async () => {
            const xpr = await findProjectXpr();
            if (!xpr) throw new Error('请先选择 Vivado 工程（.xpr）');
            if (expectedXpr && !samePath(expectedXpr, xpr)) throw new Error('工程已切换，请从当前工程重新打开');
            const project = parseXpr(xpr);

            async function run(name, body, { readOnly = false, needsWritableProject = false, target, guard } = {}) {
                const result = await runIncrementalTcl(name + '.tcl', script(xpr, body, { readOnly: readOnly && !needsWritableProject }), xpr, async current => {
                    if (pickerToken()?.isCancellationRequested) return false;
                    if (target && !member(current, target.file, target.fileset)) return false;
                    if (guard && await hash(target.file) !== guard) {
                        throw new Error('Block Design 已在其他位置修改，请先刷新');
                    }
                    return true;
                }, { quiet: readOnly });
                if (result?.status === 'cancelled') throw cancelledError('Vivado 操作已取消');
                if (result?.code !== 0 || !result.logPath) {
                    const detail = result?.stdout?.match(/^SVTOOLS_TCL_ERROR (.*)$/mu)?.[1];
                    throw new Error(detail || result?.issues?.find(item => item.level === 'ERROR')?.text || result?.error || '请查看 Vivado 输出');
                }
                const directory = path.dirname(result.logPath);
                const rows = await readRows(directory);
                if (!readOnly) {
                    catalogCache.clear();
                    await refresh();
                }
                return { rows, directory };
            }
            try { return await callback({ project, xpr, run }); }
            catch (error) { if (error.code !== 'TOOL_CANCELLED') throw error; }
        });
    }

    async function definition(session, forBlockDesign) {
        const key = session.xpr + '\0' + forBlockDesign;
        const before = await hash(session.xpr);
        let catalog = catalogCache.get(key);
        if (catalog?.stamp !== before || (catalog?.expires || 0) < Date.now()) {
            const { rows } = await session.run('ip_catalog', ip.catalog(forBlockDesign), { readOnly: true });
            const [version, part] = rowsOf(rows, 'tool')[0];
            catalog = { version, part, stamp: before, expires: Date.now() + 120000,
                items: rowsOf(rows, 'definition').map(([value, label, detail]) => ({ label: label || value, description: value, value, detail })) };
            if (await hash(session.xpr) === before) catalogCache.set(key, catalog);
        }
        if (!catalog.items.length) throw new Error('当前器件和仓库没有可用的 IP 定义');
        return (await pick(catalog.items, `IP Catalog · ${catalog.part} · Vivado ${catalog.version}`, {
            placeHolder: '按名称、厂商或 VLNV 搜索，选择精确版本'
        }))?.value;
    }

    async function parameterChanges(parameters, title) {
        const edits = new Map();
        while (!pickerToken()?.isCancellationRequested) {
            const selected = await pick([
                ...(edits.size ? [{ label: `应用 ${edits.size} 项修改`, apply: true }] : []),
                ...parameters.map(parameter => ({ label: parameter.key.slice(7),
                    description: edits.has(parameter.key) ? `${parameter.value} → ${edits.get(parameter.key)}` : parameter.value,
                    detail: parameter.key, parameter }))
            ], title, { placeHolder: '搜索参数，修改后选「应用」一次提交' });
            if (!selected) return;
            if (selected.apply) return parameters.filter(param => edits.has(param.key)).map(({ key, value }) => ({
                key, before: value, value: edits.get(key)
            }));
            const { key, value: original, choices: allowed } = selected.parameter;
            const value = allowed.length
                ? (await pick(allowed.map(value => ({ value, label: value || '空值' })), key))?.value
                : await input(key, { value: edits.get(key) ?? original, prompt: '值由 Vivado 验证' });
            if (value === original) edits.delete(key);
            else if (value !== undefined) edits.set(key, value);
        }
    }

    function artifact(result, targetExtension) {
        const leaf = rowsOf(result.rows, 'artifact')[0]?.[0];
        if (!leaf || path.basename(leaf) !== leaf || !targetExtension.test(leaf)) throw new Error('Vivado 未返回有效的产物');
        return path.join(result.directory, leaf);
    }

    async function template(session, target) {
        const file = await pick(choices([['.veo', 'Verilog / SystemVerilog'], ['.vho', 'VHDL']]), '例化模板语言');
        if (!file) return;
        const result = await session.run('ip_template', ip.template(target.file, file.value), { target });
        const templatePath = artifact(result, /\.(veo|vho)$/u);
        const text = await fs.readFile(templatePath, 'utf8');
        const editor = window.activeTextEditor;
        if (editor && ['verilog', 'systemverilog', 'vhdl'].includes(editor.document.languageId) &&
            (file.value === '.vho') === (editor.document.languageId === 'vhdl') &&
            await confirm('将 Vivado 生成的例化模板插入当前编辑器光标处？', '插入')) {
            if (!await editor.edit(edit => edit.insert(editor.selection.active, text))) throw new Error('编辑器已变化，未能插入模板');
        } else {
            await window.showTextDocument(vscode.Uri.file(templatePath), { preview: false });
        }
    }

    async function reportIpStatus(session) {
        const result = await session.run('ip_status', ['report_ip_status -file ip-status.rpt', 'sv_row artifact ip-status.rpt'],
            { readOnly: true, needsWritableProject: true });
        await window.showTextDocument(vscode.Uri.file(artifact(result, /\.rpt$/u)), { preview: false });
    }

    async function manageIp(session, target) {
        // Vivado 在只读工程中把所有 IP 标成锁定，查询实际状态需要正常打开工程。
        const { rows } = await session.run('ip_properties', ip.info(target.file), { target, readOnly: true, needsWritableProject: true });
        const [name, vlnv, locked, upgrade, checkpoint, ...targets] = rowsOf(rows, 'ip')[0];
        const parameters = parametersOf(rows);
        const action = (await pick(choices([
            ...(parameters.length ? [['config', locked === '1' ? '查看参数' : '配置参数', `${parameters.length} 项`]] : []),
            ['generate', '生成或更新输出产物'],
            ...(['1', 'true'].includes(checkpoint) && locked !== '1' ? [['synth', '运行 IP OOC 综合']] : []),
            ...(targets.includes('instantiation_template') ? [['template', '查看或插入例化模板']] : []),
            ...(upgrade ? [['upgrade', '升级 IP', upgrade]] : []),
            ['report', '打开工程 IP 状态报告'],
            ['remove', '移出工程', '保留源文件']
        ]), `${name} · ${vlnv}${locked === '1' ? ' · 已锁定' : ''}`))?.value;
        if (action === 'config') {
            if (locked === '1') {
                await pick(parameters.map(param => ({ label: param.key, description: param.value })), '锁定 IP 的参数');
                return;
            }
            const changes = await parameterChanges(parameters, '配置 ' + name);
            if (changes?.length) await session.run('ip_configure', ip.configure(target.file, changes), { target });
        } else if (action === 'generate') {
            const labels = { all: '全部', synthesis: '综合', simulation: '仿真', instantiation_template: '例化模板',
                example_design: '示例设计', changelog: '变更说明' };
            const selected = await pick(ip.TARGETS.filter(item => item === 'all' || targets.includes(item))
                .map(value => ({ label: labels[value], value })), '生成目标');
            if (selected) await session.run('ip_generate', ip.generate(target.file, selected.value), { target });
        } else if (action === 'synth') {
            await session.run('ip_ooc', ip.synthesize(target.file), { target });
        } else if (action === 'template') {
            await template(session, target);
        } else if (action === 'upgrade' && await confirm(`升级 ${name}？Vivado 会更新此 IP 的配置及产物。`, '升级')) {
            await session.run('ip_upgrade', ip.upgrade(target.file), { target });
        } else if (action === 'report') {
            await reportIpStatus(session);
        } else if (action === 'remove' && await confirm(`将 ${name} 从 ${target.fileset} 移出？`, '移出')) {
            await session.run('ip_remove', removeFromProject(target.file, target.fileset), { target });
            if (member(parseXpr(session.xpr), target.file, target.fileset)) throw new Error('工程没有保存 IP 移出结果');
        }
    }

    async function repositories(session) {
        const { rows } = await session.run('ip_repositories', ip.repositories(), { readOnly: true });
        const before = rowsOf(rows, 'repo').map(([dir]) => dir);
        const selection = await pick([
            { label: '添加仓库目录', action: 'add' },
            { label: '刷新 IP Catalog', action: 'refresh' },
            ...before.map(dir => ({ label: '移出仓库目录', description: dir, dir, action: 'remove' }))
        ], '自定义 IP 仓库');
        if (!selection) return;
        let after = before;
        if (selection.action === 'add') {
            const directory = (await files({ canSelectFolders: true, canSelectFiles: false, openLabel: '选择 IP 仓库' }))?.[0]?.fsPath;
            if (!directory || before.some(dir => samePath(dir, directory))) return;
            after = [...before, directory];
        } else if (selection.action === 'remove') {
            after = before.filter(dir => dir !== selection.dir);
        }
        await session.run('ip_update_catalog', ip.setRepositories(before, after));
    }

    async function ipManager(node) {
        return projectAction('Vivado IP 管理', node?.xpr, async session => {
            const members = assets(session.project, IP_EXTENSION);
            if (node?.file) {
                const target = members.find(item => item.fileset === node.fileset && samePath(item.file, node.file));
                if (!target) throw new Error('此 IP 已不在当前工程的文件集中');
                return manageIp(session, target);
            }
            const selected = await pick([
                { label: '从 IP Catalog 创建', action: 'create' },
                { label: '添加现有 IP', action: 'import' },
                { label: '自定义 IP 仓库', action: 'repositories' },
                { label: '打开工程 IP 状态报告', action: 'report' },
                ...members
            ], 'Vivado IP 管理 · ' + path.basename(session.xpr));
            if (selected?.action === 'create') {
                const vlnv = await definition(session, false);
                if (!vlnv) return;
                const name = await nameInput('IP 模块名', vlnv.split(':')[2].replace(/[^\w]/gu, '_') + '_0');
                if (!name) return;
                const location = await pick(choices([['local', '保存在工程内'], ['external', '选择外部目录']]), 'IP 保存位置');
                if (!location) return;
                const directory = location.value === 'external'
                    ? (await files({ canSelectFolders: true, canSelectFiles: false, openLabel: '选择 IP 保存目录' }))?.[0]?.fsPath : undefined;
                if (location.value === 'external' && !directory) return;
                const result = await session.run('ip_create', ip.create({ vlnv, name, directory }));
                const created = rowsOf(result.rows, 'created')[0]?.[0];
                const target = assets(parseXpr(session.xpr), IP_EXTENSION).find(item => created && samePath(item.file, created));
                if (!target) throw new Error('Vivado 未将新建 IP 加入工程');
                await manageIp(session, target);
            } else if (selected?.action === 'import') {
                const filename = (await files({ filters: { 'Vivado IP': ['xci', 'xcix'] }, openLabel: '选择 IP 源文件' }))?.[0]?.fsPath;
                if (!filename) return;
                const choice = await pick(choices([['ref', '引用原位置'], ['copy', '复制到当前工程']]), '添加方式');
                if (choice) {
                    const result = await session.run('ip_import', ip.importSource(filename, choice.value === 'copy'));
                    const added = rowsOf(result.rows, 'imported')[0]?.[0];
                    if (!added || !member(parseXpr(session.xpr), added)) throw new Error('Vivado 未将所选 IP 加入工程');
                }
            } else if (selected?.action === 'repositories') {
                await repositories(session);
            } else if (selected?.action === 'report') {
                await reportIpStatus(session);
            } else if (selected?.file) {
                await manageIp(session, selected);
            }
        });
    }

    async function readBlock(session, target) {
        const before = await hash(target.file);
        const { rows } = await session.run('bd_read', bd.read(target.file), { target, guard: before, readOnly: true });
        if (await hash(target.file) !== before) throw new Error('Block Design 在读取期间发生变化，请重试');
        return { model: bd.snapshot(rows), stamp: before };
    }

    // Block Design 动作使用面板当前快照，实际 Tcl 对象仍由 Vivado 精确解析。
    async function blockAction(session, target, state, action, selection) {
        const filename = target.file;
        const guard = state.stamp;
        const update = async (name, body) => {
            const { rows } = await session.run(name, [...body, ...bd.inspect()], { target, guard });
            return { model: bd.snapshot(rows), stamp: await hash(filename) };
        };
        if (action === 'refresh') return readBlock(session, target);
        if (action === 'add-cell') {
            const type = (await pick(choices([['ip', '从 Catalog 添加 IP'], ['module', '添加 RTL 模块引用'], ['hier', '创建层级块']]), '添加模块'))?.value;
            if (!type) return;
            const reference = type === 'ip' ? await definition(session, true)
                : type === 'module' ? await nameInput('工程中已有的 Verilog / SystemVerilog / VHDL 模块名') : undefined;
            if (type !== 'hier' && !reference) return;
            const name = await nameInput('实例名', type === 'ip' ? reference.split(':')[2].replace(/[^\w]/gu, '_') + '_0'
                : type === 'module' ? reference + '_0' : 'group_0');
            if (name) return update('bd_add_cell', bd.addCell(filename, { type, reference, name, parent: selection?.cell?.id }));
        } else if (action === 'add-port') {
            const kind = (await pick(choices([['signal', '普通信号'], ['interface', '协议接口']]), '外部端口类别'))?.value;
            if (!kind) return;
            if (kind === 'interface') {
                const mode = (await pick(choices([['Master', 'Master'], ['Slave', 'Slave'], ['Monitor', 'Monitor']]), '协议接口方向'))?.value;
                if (!mode) return;
                const vlnv = await input('接口 VLNV', { placeHolder: 'xilinx.com:interface:aximm_rtl:1.0',
                    validateInput: text => /^[\w.-]+:[\w.-]+:[\w.-]+:[\w.-]+$/u.test(text) ? undefined : '请输入完整的厂商:库:接口:版本' });
                if (!vlnv) return;
                const name = await nameInput('外部接口名');
                if (name) return update('bd_add_interface', bd.addInterfacePort(filename, { name, mode, vlnv }));
                return;
            }
            const direction = (await pick(choices([['I', '输入'], ['O', '输出'], ['IO', '双向']]), '外部端口方向'))?.value;
            if (!direction) return;
            const type = (await pick(choices([['data', '数据或控制信号'], ['clk', '时钟'], ['rst', '复位']]), '外部端口类型'))?.value;
            if (!type) return;
            const name = await nameInput('外部端口名');
            if (!name) return;
            const width = type === 'data' ? await input('端口位宽', { value: '1', validateInput: value =>
                /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value)) ? undefined : '请输入正整数' }) : '1';
            if (width) return update('bd_add_port', bd.addPort(filename, { name, direction, type, width: Number(width) }));
        } else if (action === 'config' || action === 'config-port') {
            const item = selection.endpoint || selection.cell;
            const query = selection.endpoint ? bd.portParameters(filename, item) : bd.parameters(filename, item.id);
            const { rows } = await session.run('bd_read_config', query, { target, guard, readOnly: true });
            const parameters = parametersOf(rows);
            if (!parameters.length) throw new Error('Vivado 没有为此对象提供 CONFIG 参数');
            const changes = await parameterChanges(parameters, '配置 ' + item.id);
            if (changes?.length)
                return update('bd_set_config', selection.endpoint ? bd.configurePort(filename, item, changes) : bd.configure(filename, item.id, changes));
        } else if (action === 'connect') {
            const { endpoint, net, level } = selection;
            const parent = id => id.slice(0, id.lastIndexOf('/'));
            const connected = new Set(state.model.nets.filter(link => parent(link.id) === level &&
                bd.isInterface(link) === bd.isInterface(endpoint)).flatMap(link => link.endpoints));
            const candidates = state.model.endpoints.filter(candidate => candidate.id !== endpoint.id &&
                (candidate.cell === level || candidate.cell && parent(candidate.cell) === level) &&
                !connected.has(candidate.id) && bd.isInterface(candidate) === bd.isInterface(endpoint));
            if (!candidates.length) throw new Error('当前层级没有可接入的同类端点');
            const dest = (await pick(candidates.map(item => ({ label: item.id, description: item.direction + ' · ' + (item.type || item.kind), item })),
            '连接到 ' + endpoint.id, { placeHolder: '选择未连接的同类端点，由 Vivado 检查方向和位宽' }))?.item;
            if (dest) return update('bd_connect', bd.connect(filename, endpoint, dest, net, level));
        } else if (action === 'externalize') {
            return update('bd_externalize', bd.externalize(filename, selection.endpoint));
        } else if (action === 'disconnect') {
            return update('bd_disconnect', bd.disconnect(filename, selection.net, selection.endpoint));
        } else if (action === 'remove') {
            const kind = selection.cell ? 'cell' : selection.net ? 'net' : 'endpoint';
            const item = selection[kind];
            if (await confirm(`删除 ${item.id}？Vivado 会更新与它相关的连接。`, '删除'))
                return update('bd_remove', bd.remove(filename, kind, item));
        } else if (action === 'assign') {
            return update('bd_assign_address', bd.assignAddresses(filename));
        } else if (action === 'validate') {
            return { ...await update('bd_validate', bd.validate(filename)), message: 'Vivado 已完成校验' };
        } else if (action === 'generate') {
            return update('bd_generate', bd.generate(filename));
        } else if (action === 'wrapper') {
            return update('bd_make_wrapper', bd.wrapper(filename));
        } else if (action === 'export') {
            const output = await window.showSaveDialog({ title: '导出 Block Design Tcl',
                defaultUri: vscode.Uri.file(path.join(path.dirname(filename), path.basename(filename, '.bd') + '.tcl')),
                filters: { Tcl: ['tcl'] } });
            if (!output) return;
            if (!/\.tcl$/iu.test(output.fsPath)) throw new Error('导出目标必须使用 .tcl 扩展名');
            const result = await session.run('bd_export', bd.exportTcl(filename), { target, guard, readOnly: true });
            await fs.copyFile(artifact(result, /\.tcl$/u), output.fsPath);
            return { message: 'Tcl 已导出到 ' + output.fsPath };
        } else if (action === 'remove-design' &&
            await confirm(`将 ${path.basename(filename)} 从 ${target.fileset} 移出？源文件会保留。`, '移出')) {
            await session.run('bd_remove_design', removeFromProject(filename, target.fileset), { target, guard });
            if (member(parseXpr(session.xpr), target.file, target.fileset)) throw new Error('工程没有保存 Block Design 移出结果');
            return { close: true };
        }
    }

    const panels = openBlockDesignPanels(context, vscode, (target, state, action, selection) =>
        projectAction('Block Design', target.xpr, session => blockAction(session, target, state, action, selection)));

    async function blockManager(node) {
        return projectAction('Block Design', node?.xpr, async session => {
            const members = assets(session.project, BD_EXTENSION);
            let target;
            if (node?.file) {
                target = members.find(item => item.fileset === node.fileset && samePath(item.file, node.file));
                if (!target) throw new Error('此 Block Design 已不在当前工程的文件集中');
            } else {
                const selected = await pick([{ label: '新建 Block Design', action: 'create' },
                    { label: '引用已有 Block Design', action: 'import' }, ...members], 'Block Design · ' + path.basename(session.xpr));
                if (!selected) return;
                if (selected.action === 'create') {
                    const name = await nameInput('Block Design 名称', 'design_1');
                    if (!name) return;
                    const result = await session.run('bd_create', [...bd.create(name), ...bd.inspect()]);
                    const created = rowsOf(result.rows, 'created')[0]?.[0];
                    target = assets(parseXpr(session.xpr), BD_EXTENSION).find(item => created && samePath(item.file, created));
                    if (!target) throw new Error('Vivado 未将新建的 Block Design 加入工程');
                    panels.open({ ...target, xpr: session.xpr }, { model: bd.snapshot(result.rows), stamp: await hash(target.file) });
                    return;
                } else if (selected.action === 'import') {
                    const file = (await files({ filters: { 'Vivado Block Design': ['bd'] }, openLabel: '选择 Block Design' }))?.[0]?.fsPath;
                    if (!file) return;
                    await session.run('bd_add_file', bd.importSource(file));
                    target = assets(parseXpr(session.xpr), BD_EXTENSION).find(item => samePath(item.file, file));
                    if (!target) throw new Error('Vivado 未将所选 Block Design 加入工程');
                } else {
                    target = selected;
                }
            }
            panels.open({ ...target, xpr: session.xpr }, await readBlock(session, target));
        });
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.vivado.assets.ip', node => ipManager(node?.nodeData)),
        vscode.commands.registerCommand('svtools.vivado.assets.bd', node => blockManager(node?.nodeData))
    );
    const configuration = vscode.workspace.onDidChangeConfiguration?.(event => {
        if (event.affectsConfiguration('svtools.vivado.path')) catalogCache.clear();
    });
    if (configuration) context.subscriptions.push(configuration);
}

module.exports = { activateAssetCommands };
