'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { cancelledError } = require('../toolchains/job');
const { parseXpr, samePath } = require('./xpr');
const { script, sessionScript, readRows, rowsOf, parametersOf, removeFromProject } = require('./asset-task');
const { openBlockDesignPanels } = require('./block-design-view');
const { openIpPanels, resolveEdits } = require('./ip-view');
const { openIpFormPanels } = require('./ip-form-view');
const { openCatalogPanels } = require('./ip-catalog-view');
const { readAssetText, savedBlock, savedIp } = require('./asset-preview');
const { createIpMetadata } = require('./ip-metadata');
const { createBlockDesignCache, digest } = require('./block-design-cache');
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
const IP_LANGUAGES = ['verilog', 'systemverilog', 'vhdl'];

function activateAssetCommands(context, { vscode, findProjectXpr, incrementalAction, runIncrementalTcl, pickerToken, refresh, resolveBinDir }) {
    const cacheName = 'svtools.vivado.ipCatalog.v2';
    const describeIp = createIpMetadata(resolveBinDir);
    const catalogCache = new Map(context.workspaceState?.get(cacheName, []) || []), ipCache = new Map();
    const blockCache = createBlockDesignCache(context.storageUri?.fsPath, 'model', 8);
    let reads = Promise.resolve();
    const window = vscode.window;
    let lastHdlEditor = window.activeTextEditor;
    const pick = (items, title, options = {}) => window.showQuickPick(items, {
        title, matchOnDescription: true, matchOnDetail: true, ...options
    }, pickerToken());
    const input = (title, options = {}) => window.showInputBox({ title, ...options }, pickerToken());
    const nameInput = (title, value) => input(title, { value, validateInput: text =>
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(text) ? undefined : '名称须以字母或下划线开头，可包含数字' });
    const files = options => window.showOpenDialog({ canSelectMany: false, ...options });
    const confirm = async (message, button) => await window.showWarningMessage(message, { modal: true }, button) === button;

    async function projectFor(expectedXpr) {
        const xpr = await findProjectXpr();
        if (!xpr) throw new Error('请先选择 Vivado 工程（.xpr）');
        if (expectedXpr && !samePath(expectedXpr, xpr)) throw new Error('工程已切换，请从当前工程重新打开');
        return { xpr, project: parseXpr(xpr) };
    }

    function projectAction(label, expectedXpr, callback) {
        return incrementalAction(label, async () => {
            const { xpr, project } = await projectFor(expectedXpr);

            async function run(name, body, { readOnly = false, needsWritableProject = false, target, guard, quiet = readOnly } = {}) {
                const result = await runIncrementalTcl(name + '.tcl', script(xpr, body, { readOnly: readOnly && !needsWritableProject }), xpr, async current => {
                    if (pickerToken()?.isCancellationRequested) return false;
                    if (target && !member(current, target.file, target.fileset)) return false;
                    if (guard && await hash(target.file) !== guard) {
                        throw new Error('资产文件已在其他位置修改，请先刷新');
                    }
                    return true;
                }, { quiet, sessionBody: sessionScript(body), watch: target ? [target.file] : [] });
                if (result?.status === 'cancelled') throw cancelledError('Vivado 操作已取消');
                if (result?.code !== 0 || !result.logPath) {
                    const detail = result?.stdout?.match(/^SVTOOLS_TCL_ERROR (.*)$/mu)?.[1];
                    throw new Error(detail || result?.issues?.find(item => item.level === 'ERROR')?.text || result?.error || '请查看 Vivado 输出');
                }
                const directory = path.dirname(result.logPath);
                const rows = await readRows(directory);
                if (!readOnly) {
                    if (name.startsWith('ip_') || name.startsWith('bd_')) ipCache.clear();
                    if (name === 'ip_update_catalog') {
                        catalogCache.clear();
                        await context.workspaceState?.update(cacheName, []);
                    }
                    await refresh();
                }
                return { rows, directory };
            }
            try { return await callback({ project, xpr, run }); }
            catch (error) { if (error.code !== 'TOOL_CANCELLED') throw error; }
        });
    }

    function queueAction(label, xpr, callback, active = () => true) {
        const request = reads.then(() => active() ? projectAction(label, xpr, callback) : undefined);
        reads = request.catch(() => {});
        return request;
    }

    function store(map, key, value, limit) {
        map.delete(key);
        map.set(key, value);
        while (map.size > limit) map.delete(map.keys().next().value);
    }

    const catalogKey = xpr => [xpr, resolveBinDir?.() || ''].join('\0');
    async function cachedCatalog(xpr) {
        const item = catalogCache.get(catalogKey(xpr));
        if (item?.stamp === await hash(xpr)) return item;
    }

    async function loadCatalog(session) {
        const key = catalogKey(session.xpr), stamp = await hash(session.xpr);
        const { rows } = await session.run('ip_catalog', ip.catalog(), { readOnly: true });
        const [version, part] = rowsOf(rows, 'tool')[0];
        if (await hash(session.xpr) !== stamp || catalogKey(session.xpr) !== key) throw new Error('工程或 Vivado 安装已变化，请刷新目录');
        const result = { version, part, stamp, expires: Date.now() + 120000,
            items: rowsOf(rows, 'definition').map(([value, label, detail, ipi, ...categories]) =>
                ({ label: label || value, value, detail, ipi: ipi === '1', categories: categories.filter(Boolean) })) };
        store(catalogCache, key, result, 3);
        await context.workspaceState?.update(cacheName, [...catalogCache]);
        return result;
    }

    async function parameterChanges(parameters, title) {
        const edits = new Map();
        while (!pickerToken()?.isCancellationRequested) {
            const selected = await pick([
                ...(edits.size ? [{ label: `应用 ${edits.size} 项修改`, apply: true }] : []),
                ...parameters.filter(parameter => !parameter.readOnly).map(parameter => ({ label: parameter.label || parameter.key.slice(7),
                    description: edits.has(parameter.key) ? `${parameter.value} → ${edits.get(parameter.key)}` : parameter.value,
                    detail: [parameter.group, parameter.help || parameter.key].filter(Boolean).join(' · '), parameter }))
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
        const editor = lastHdlEditor;
        if (editor && !editor.document.isClosed && IP_LANGUAGES.includes(editor.document.languageId) &&
            (file.value === '.vho') === (editor.document.languageId === 'vhdl') &&
            await confirm(`将 Vivado 生成的例化模板插入 ${path.basename(editor.document.fileName)} 的光标处？`, '插入')) {
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

    function ipDetails(rows) {
        const [name, vlnv, locked, upgrade, checkpoint, ...targets] = rowsOf(rows, 'ip')[0];
        const readOnly = ['1', 'true'].includes(locked);
        return { name, vlnv, locked: readOnly, upgrade, targets, parameters: parametersOf(rows),
            actions: [
                ...(!readOnly ? [{ id: 'generate', label: '生成产物…' }] : []),
                ...(['1', 'true'].includes(checkpoint) && !readOnly ? [{ id: 'synth', label: 'OOC 综合' }] : []),
                ...(targets.includes('instantiation_template') && !readOnly ? [{ id: 'template', label: '例化模板…' }] : []),
                ...(upgrade ? [{ id: 'upgrade', label: '升级 IP…' }] : []),
                { id: 'remove', label: '移出工程…' }
            ] };
    }

    const ipKey = (session, target) => [catalogKey(session.xpr), target.file, target.fileset].join('\0');
    function rememberIp(session, target, info, projectStamp) {
        store(ipCache, ipKey(session, target), { stamp: info.stamp, projectStamp, expires: Date.now() + 120000, info }, 16);
        return info;
    }

    async function readIp(session, target, force = false) {
        const stamp = await hash(target.file), projectStamp = await hash(session.xpr);
        const cached = ipCache.get(ipKey(session, target));
        if (!force && cached?.stamp === stamp && cached.projectStamp === projectStamp && cached.expires > Date.now()) return cached.info;
        // Vivado 在只读工程中把所有 IP 标成锁定，查询实际状态需要正常打开工程。
        const { rows } = await session.run('ip_properties', ip.info(target.file), { target, readOnly: true, needsWritableProject: true });
        if (await hash(target.file) !== stamp || await hash(session.xpr) !== projectStamp) throw new Error('IP 或工程已在读取期间变化，请重新读取');
        const info = await describeIp({ ...ipDetails(rows), stamp }, rowsOf(rows, 'definition_xml')[0]?.[0]);
        return rememberIp(session, target, info, projectStamp);
    }

    async function runIpAction(session, target, info, action, changes) {
        if (action === 'load') return { info: await readIp(session, target) };
        if (action === 'apply') {
            const { rows } = await session.run('ip_configure', ip.configure(target.file, changes, { readBack: true }), { target, guard: info.stamp, quiet: true });
            const next = await describeIp({ ...ipDetails(rows), stamp: await hash(target.file) }, rowsOf(rows, 'definition_xml')[0]?.[0]);
            return { info: rememberIp(session, target, next, await hash(session.xpr)), message: 'Vivado 已应用参数。' };
        }
        if (action === 'generate') {
            const labels = { all: '全部', synthesis: '综合', simulation: '仿真', instantiation_template: '例化模板',
                example_design: '示例设计', changelog: '变更说明' };
            const selected = await pick(ip.TARGETS.filter(item => item === 'all' || info.targets.includes(item))
                .map(value => ({ label: labels[value], value })), '生成目标');
            if (!selected) return;
            await session.run('ip_generate', ip.generate(target.file, selected.value), { target });
            return { message: 'Vivado 已生成 ' + selected.label + ' 产物。' };
        } else if (action === 'synth') {
            await session.run('ip_ooc', ip.synthesize(target.file), { target });
            return { message: 'IP OOC 综合已完成。' };
        } else if (action === 'template') {
            await template(session, target);
        } else if (action === 'upgrade' && await confirm(`升级 ${info.name}？Vivado 会更新此 IP 的配置及产物。`, '升级')) {
            await session.run('ip_upgrade', ip.upgrade(target.file), { target });
            return { info: await readIp(session, target), message: 'IP 已升级。' };
        } else if (action === 'remove' && await confirm(`将 ${info.name} 从 ${target.fileset} 移出？`, '移出')) {
            await session.run('ip_remove', removeFromProject(target.file, target.fileset), { target });
            const updated = parseXpr(session.xpr);
            if (member(updated, target.file, target.fileset)) throw new Error('工程没有保存 IP 移出结果');
            return { members: assets(updated, IP_EXTENSION), message: 'IP 已从工程移出。' };
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
        return true;
    }

    async function createIp(session, vlnv) {
        const name = await nameInput('IP 模块名', vlnv.split(':')[2].replace(/[^\w]/gu, '_') + '_0');
        if (!name) return;
        const location = await pick(choices([['local', '保存在工程内'], ['external', '选择外部目录']]), 'IP 保存位置');
        if (!location) return;
        const directory = location.value === 'external'
            ? (await files({ canSelectFolders: true, canSelectFiles: false, openLabel: '选择 IP 保存目录' }))?.[0]?.fsPath : undefined;
        if (location.value === 'external' && !directory) return;
        const { rows } = await session.run('ip_create', ip.create({ vlnv, name, directory }), { quiet: true });
        return rowsOf(rows, 'created')[0]?.[0];
    }

    async function importIp(session) {
        const filename = (await files({ filters: { 'Vivado IP': ['xci', 'xcix'] }, openLabel: '选择 IP 源文件' }))?.[0]?.fsPath;
        if (!filename) return;
        const choice = await pick(choices([['ref', '引用原位置'], ['copy', '复制到当前工程']]), '添加方式');
        if (!choice) return;
        const { rows } = await session.run('ip_import', ip.importSource(filename, choice.value === 'copy'));
        return rowsOf(rows, 'imported')[0]?.[0];
    }

    async function addIp(session, action, vlnv) {
        const file = await (action === 'create' ? createIp(session, vlnv) : importIp(session));
        if (!file) return;
        const items = assets(parseXpr(session.xpr), IP_EXTENSION);
        const focus = items.find(item => samePath(item.file, file));
        if (!focus) throw new Error('Vivado 未将所选 IP 加入工程');
        return { xpr: session.xpr, members: items, focus };
    }

    async function refreshIps(session, target) {
        const items = assets(parseXpr(session.xpr), IP_EXTENSION);
        const focus = (target && items.find(item => item.fileset === target.fileset && samePath(item.file, target.file))) || items[0];
        return { members: items, focus, ...(focus ? { info: await readIp(session, focus, true) } : {}) };
    }

    const openCatalog = openCatalogPanels(context, vscode, {
        cached: async xpr => { await projectFor(xpr); return cachedCatalog(xpr); },
        async refresh(xpr, active) {
            const result = await queueAction('IP Catalog', xpr, loadCatalog, active);
            if (!result?.items) throw new Error(result?.error || 'IP 目录读取已取消');
            return result;
        },
        async create(xpr, vlnv) {
            const result = await queueAction('创建 IP', xpr, session => addIp(session, 'create', vlnv));
            if (result?.xpr) { ipPanels.open(result); return '已创建 ' + result.focus.label; }
            return result?.error;
        }
    });

    // Block Design 专用目录：选定 IP 后创建实例并打开定制对话框。
    let bdCatalogTarget = null;
    const openBdCatalogImpl = openCatalogPanels(context, vscode, {
        cached: async xpr => { await projectFor(xpr); return cachedCatalog(xpr); },
        async refresh(xpr, active) {
            const result = await queueAction('Block Design IP Catalog', xpr, loadCatalog, active);
            if (!result?.items) throw new Error(result?.error || 'IP 目录读取已取消');
            return result;
        },
        async create(xpr, vlnv) { return addBlockIp(xpr, vlnv); },
        title: 'IP Catalog · Block Design',
        action: '添加到 Block Design',
        windowTitle: 'Block Design IP Catalog'
    });
    function openBdCatalog(xpr) { openBdCatalogImpl(xpr); }

    /** 在原理图中创建 IP 实例，随后打开与 Vivado Re-customize IP 等价的定制对话框。 */
    async function addBlockIp(xpr, vlnv) {
        const target = bdCatalogTarget;
        if (!target || !samePath(target.xpr, xpr)) throw new Error('Block Design 已切换，请从当前设计重新打开 IP Catalog');
        const name = await nameInput('实例名', vlnv.split(':')[2].replace(/[^\w]/gu, '_') + '_0');
        if (!name) return '已取消';
        const result = await queueAction('添加 IP', xpr, async session => {
            const guard = await hash(target.file);
            const { rows } = await session.run('bd_add_cell', [...bd.addCell(target.file, { type: 'ip', reference: vlnv, name }), ...bd.inspect()],
                { target, guard, quiet: true });
            return rememberBlock(target, parseXpr(xpr), {
                model: bd.snapshot(rows), stamp: await hash(target.file), projectStamp: await hash(xpr)
            });
        });
        if (!result || result.status === 'failed') throw new Error(result?.error || '添加 IP 已取消');
        if (!result.model) return '已取消';
        panels.update(target, result);
        const cell = result.model.cells.find(item => item.id === name || item.id.endsWith('/' + name));
        if (cell) {
            const key = formKey(target, 'cell', cell.id);
            formTargets.set(key, { ...target, id: cell.id, vlnv });
            formPanels.open({ key, title: 'IP 定制 · ' + cell.id, subtitle: vlnv });
        }
        return '已添加 ' + name + (cell ? '，可在定制对话框调整参数' : '');
    }

    const ipPanels = openIpPanels(context, vscode, async (xpr, action, target, info, changes, active) => {
        if (action === 'create') return openCatalog(xpr);
        if (action === 'preview') {
            const session = await projectFor(xpr);
            if (!target || !member(session.project, target.file, target.fileset) || path.extname(target.file).toLowerCase() !== '.xci') return;
            const preview = await readAssetText(target.file).then(({ text }) => savedIp(text, target.file)).catch(() => undefined);
            return preview && { info: await describeIp(preview) };
        }
        return queueAction('Vivado IP 管理', xpr, async session => {
            if (action === 'import') return addIp(session, action);
            if (action === 'report') return reportIpStatus(session);
            if (action === 'refresh') return refreshIps(session, target);
            if (action === 'repositories') {
                if (await repositories(session)) return refreshIps(session, target);
                return;
            }
            if (!target || !member(session.project, target.file, target.fileset)) {
                throw new Error('此 IP 已不在当前工程中，请重新读取工程。');
            }
            return runIpAction(session, target, info, action, changes);
        }, active);
    });

    async function ipManager(node) {
        try {
            const session = await projectFor(node?.xpr);
            const members = assets(session.project, IP_EXTENSION);
            const focus = node?.file && members.find(item => item.fileset === node.fileset && samePath(item.file, node.file));
            if (node?.file && !focus) throw new Error('此 IP 已不在当前工程的文件集中');
            ipPanels.open({ xpr: session.xpr, members, focus });
        } catch (error) { window.showErrorMessage(error.message); }
    }

    async function ipCatalog(node) {
        try { openCatalog((await projectFor(node?.xpr)).xpr); }
        catch (error) { window.showErrorMessage(error.message); }
    }

    async function readBlock(session, target) {
        const before = await hash(target.file);
        const projectStamp = await hash(session.xpr);
        const { rows } = await session.run('bd_read', bd.read(target.file), { target, guard: before, readOnly: true });
        if (await hash(target.file) !== before || await hash(session.xpr) !== projectStamp) throw new Error('Block Design 或工程在读取期间发生变化，请重试');
        return rememberBlock(target, session.project, { model: bd.snapshot(rows), stamp: before, projectStamp });
    }

    const blockKey = target => digest([catalogKey(target.xpr), target.file, target.fileset]);
    async function blockDependencies(project, target, model) {
        const hasRtl = model.cells.some(cell => cell.type === 'module');
        const types = hasRtl ? /\.(?:bd|xcix?|v|sv|vh|svh|vhdl?|vhdp)$/iu : /\.(?:bd|xcix?)$/iu;
        const files = [...new Set(project.sets.filter(set => set.type === 'DesignSrcs' || set.name === target.fileset)
            .flatMap(set => set.files.filter(file => types.test(file) && !samePath(file, target.file))))].sort();
        const stamps = [];
        for (let start = 0; start < files.length; start += 32) {
            const batch = await Promise.all(files.slice(start, start + 32).map(async file => {
                try {
                    const { size, mtimeMs, ctimeMs } = await fs.stat(file);
                    return [file, size, mtimeMs, ctimeMs];
                } catch (error) { return [file, error.code || 'unavailable']; }
            }));
            stamps.push(...batch);
        }
        return digest(stamps);
    }
    async function rememberBlock(target, project, state) {
        const entry = { ...state, dependencies: await blockDependencies(project, target, state.model) };
        await blockCache.set(blockKey(target), entry);
        return entry;
    }

    async function previewBlock(target) {
        const session = await projectFor(target.xpr);
        if (!member(session.project, target.file, target.fileset)) throw new Error('此 Block Design 已不在当前工程的文件集中');
        const cached = await blockCache.get(blockKey(target));
        if (cached && cached.stamp === await hash(target.file) && cached.projectStamp === await hash(target.xpr) &&
            cached.dependencies === await blockDependencies(session.project, target, cached.model)) return cached;
        const saved = await readAssetText(target.file).catch(() => undefined);
        if (!saved) return;
        const model = await Promise.resolve().then(() => savedBlock(saved.text)).catch(() => undefined);
        if (model) return { model, stamp: saved.stamp, preview: true };
    }

    // ---- IP 定制对话框：读取单元格参数、应用修改并回推原理图 ----
    const formTargets = new Map();
    const formKey = (target, kind, id) => [target.xpr, target.file, kind, id].join('\0');

    async function readCellParameters(session, target) {
        const { rows } = await session.run('bd_read_config', bd.parameters(target.file, target.id), { target, readOnly: true, quiet: true });
        return parametersOf(rows);
    }

    async function describeCell(target, parameters) {
        if (!target.vlnv) return { parameters, notes: [] };
        const described = await describeIp({ vlnv: target.vlnv, parameters });
        return { parameters: described.parameters, notes: described.notes || [] };
    }

    const formPanels = openIpFormPanels(context, vscode, {
        async load(key) {
            const target = formTargets.get(key);
            if (!target) return { error: 'IP 配置目标已失效，请重新打开' };
            const read = () => queueAction('IP 定制', target.xpr, async session => {
                // 记录读取时的文件戳：应用时据此发现对话框打开期间的外部修改。
                target.guard = await hash(target.file);
                return { name: target.id, vlnv: target.vlnv || '', ...await describeCell(target, await readCellParameters(session, target)),
                    locked: false, preview: false };
            });
            let result = await read();
            // 原理图刚提交的动作可能仍占用队列；稍后重试一次，避免对话框首次打开就失败。
            if (result?.status === 'skipped') { await new Promise(resolve => setTimeout(resolve, 800)); result = await read(); }
            if (!result || result.status === 'failed' || result.status === 'skipped') return { error: result?.error || '参数读取已取消' };
            return result;
        },
        async apply(key, edits) {
            const target = formTargets.get(key);
            if (!target) return { error: 'IP 配置目标已失效，请重新打开' };
            const result = await queueAction('应用 IP 参数', target.xpr, async session => {
                const changes = resolveEdits(edits, { parameters: await readCellParameters(session, target) });
                if (!changes) throw new Error('参数已变化或不满足依赖，请重新读取后再试');
                if (!changes.length) return { message: '没有需要应用的修改' };
                const { rows } = await session.run('bd_set_config', [
                    ...bd.configure(target.file, target.id, changes),
                    ...bd.parameters(target.file, target.id),
                    ...bd.inspect()
                ], { target, guard: target.guard, quiet: true });
                target.guard = await hash(target.file);
                const entry = await rememberBlock(target, parseXpr(target.xpr), {
                    model: bd.snapshot(rows), stamp: await hash(target.file), projectStamp: await hash(target.xpr)
                });
                panels.update(target, entry);
                return {
                    info: { name: target.id, vlnv: target.vlnv || '', ...await describeCell(target, parametersOf(rows)),
                        locked: false, preview: false },
                    message: '已应用 ' + changes.length + ' 项修改'
                };
            });
            if (!result || result.status === 'failed') return { error: result?.error || '应用已取消' };
            return result;
        }
    });

    // Block Design 动作使用面板当前快照，实际 Tcl 对象仍由 Vivado 精确解析。
    async function blockAction(session, target, state, action, selection) {
        const filename = target.file;
        const guard = state.stamp;
        const update = async (name, body) => {
            const { rows } = await session.run(name, [...body, ...bd.inspect()], { target, guard, quiet: true });
            return rememberBlock(target, parseXpr(target.xpr), { model: bd.snapshot(rows), stamp: await hash(filename), projectStamp: await hash(target.xpr) });
        };
        if (action === 'add-cell') {
            const type = (await pick(choices([['ip', '从 Catalog 添加 IP'], ['module', '添加 RTL 模块引用'], ['hier', '创建层级块']]), '添加模块'))?.value;
            if (!type) return;
            if (type === 'ip') {
                // 目录面板负责选择；选定后创建实例并直接打开定制对话框。
                bdCatalogTarget = target;
                openBdCatalog(target.xpr);
                return { message: '已打开 IP Catalog：选择 IP 后会创建实例并打开定制对话框' };
            }
            const reference = type === 'module' ? await nameInput('工程中已有的 Verilog / SystemVerilog / VHDL 模块名') : undefined;
            if (type !== 'hier' && !reference) return;
            const name = await nameInput('实例名', type === 'module' ? reference + '_0' : 'group_0');
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
        } else if (action === 'config' && selection?.cell?.vlnv) {
            // IP 实例与 Vivado 的 Re-customize IP 一致：在独立对话框里按 XGUI 分组编辑。
            const key = formKey(target, 'cell', selection.cell.id);
            formTargets.set(key, { ...target, id: selection.cell.id, vlnv: selection.cell.vlnv });
            formPanels.open({ key, title: 'IP 定制 · ' + selection.cell.id, subtitle: selection.cell.vlnv });
            return { message: '已打开 IP 定制对话框' };
        } else if (action === 'config' || action === 'config-port') {
            const item = selection.endpoint || selection.cell;
            const query = selection.endpoint ? bd.portParameters(filename, item) : bd.parameters(filename, item.id);
            const { rows } = await session.run('bd_read_config', query, { target, guard, readOnly: true });
            let parameters = parametersOf(rows);
            if (selection.cell?.vlnv) parameters = (await describeIp({ vlnv: selection.cell.vlnv, parameters })).parameters;
            if (!parameters.length) throw new Error('Vivado 没有为此对象提供 CONFIG 参数');
            const changes = await parameterChanges(parameters, '配置 ' + item.id);
            if (changes?.length)
                return update('bd_set_config', selection.endpoint ? bd.configurePort(filename, item, changes) : bd.configure(filename, item.id, changes));
        } else if (action === 'connect') {
            const { endpoint, net, level, destination } = selection;
            const parent = id => id.slice(0, id.lastIndexOf('/'));
            const connected = new Set(state.model.nets.filter(link => parent(link.id) === level &&
                bd.isInterface(link) === bd.isInterface(endpoint)).flatMap(link => link.endpoints));
            const candidates = state.model.endpoints.filter(candidate => candidate.id !== endpoint.id &&
                (candidate.cell === level || candidate.cell && parent(candidate.cell) === level) &&
                !connected.has(candidate.id) && bd.isInterface(candidate) === bd.isInterface(endpoint));
            if (!candidates.length) throw new Error('当前层级没有可接入的同类端点');
            if (destination && !candidates.includes(destination)) throw new Error('目标端口已连接或已变化，请刷新后重新选择');
            const dest = destination || (await pick(candidates.map(item => ({ label: item.id, description: item.direction + ' · ' + (item.type || item.kind), item })),
                '连接到 ' + endpoint.id, { placeHolder: '选择未连接的同类端点，由 Vivado 检查方向和位宽' }))?.item;
            if (dest) return update('bd_connect', bd.connect(filename, endpoint, dest, net, level));
        } else if (action === 'externalize') {
            return update('bd_externalize', bd.externalize(filename, selection.endpoint));
        } else if (action === 'disconnect') {
            return update('bd_disconnect', bd.disconnect(filename, selection.net, selection.endpoint));
        } else if (action === 'remove') {
            const kind = selection.cell ? 'cell' : selection.net ? 'net' : 'endpoint';
            const item = selection[kind];
            if (await confirm(`删除 ${item.id}？Vivado 会更新与它相关的连接。`, '删除')) {
                formTargets.delete(formKey(target, 'cell', item.id));
                return update('bd_remove', bd.remove(filename, kind, item));
            }
        } else if (action === 'address-edit') {
            return update('bd_address_set', bd.setAddress(filename, selection.segment, { offset: selection.offset, range: selection.range }));
        } else if (action === 'address-map') {
            const hex = value => /^0x[0-9a-f]{1,16}$/iu.test(String(value).replace(/[_\s]/gu, ''));
            const spaces = (state.model.spaces || []).filter(space => space.owner.kind === 'port' ||
                space.owner.kind === 'pin' && space.owner.mode === 'Master' ||
                !space.owner.kind && space.segments.some(segment => /^0x/iu.test(segment.offset || '')));
            if (!spaces.length) throw new Error('当前 Block Design 没有可用的主地址空间');
            const slave = (state.model.spaces || []).flatMap(space => space.segments.map(segment => ({ ...segment, space: space.id })))
                .find(segment => segment.id === selection.segment);
            if (!slave) throw new Error('从设备段已变化，请刷新后重试');
            const target = spaces.length === 1 ? spaces[0].id : (await pick(spaces.map(space => ({
                label: space.id, description: space.owner.kind === 'port' ? '外部主设备' : '内部主设备', value: space.id
            })), '映射到主地址空间'))?.value;
            if (!target) return;
            const validateInput = value => hex(value) ? undefined : '请输入 0x 前缀的十六进制地址';
            const offset = await input('偏移地址', { value: '0x0000_0000', validateInput });
            if (!offset) return;
            const range = await input('范围', { value: slave.range || '0x00001000', validateInput });
            if (!range) return;
            return update('bd_address_map', bd.mapAddress(filename, { space: target, segment: selection.segment, offset, range }));
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

    const panels = openBlockDesignPanels(context, vscode, (target, state, action, selection, active) => {
        if (action === 'preview') return previewBlock(target);
        if (action === 'refresh') return queueAction('Block Design', target.xpr, session => readBlock(session, target), active);
        return queueAction('Block Design', target.xpr, session => blockAction(session, target, state, action, selection));
    });

    async function blockManager(node) {
        try {
            const session = await projectFor(node?.xpr);
            const members = assets(session.project, BD_EXTENSION);
            const selected = node?.file ? members.find(item => item.fileset === node.fileset && samePath(item.file, node.file))
                : await window.showQuickPick([{ label: '新建 Block Design', action: 'create' },
                    { label: '引用已有 Block Design', action: 'import' }, ...members], { title: 'Block Design · ' + path.basename(session.xpr), matchOnDetail: true });
            if (!selected) {
                if (node?.file) throw new Error('此 Block Design 已不在当前工程的文件集中');
                return;
            }
            if (!selected.action) { panels.open({ ...selected, xpr: session.xpr }); return; }
            return queueAction('Block Design', session.xpr, async session => {
                if (selected.action === 'create') {
                    const name = await nameInput('Block Design 名称', 'design_1');
                    if (!name) return;
                    const result = await session.run('bd_create', [...bd.create(name), ...bd.inspect()]);
                    const created = rowsOf(result.rows, 'created')[0]?.[0];
                    const target = assets(parseXpr(session.xpr), BD_EXTENSION).find(item => created && samePath(item.file, created));
                    if (!target) throw new Error('Vivado 未将新建的 Block Design 加入工程');
                    const entry = { ...target, xpr: session.xpr };
                    panels.open(entry, await rememberBlock(entry, parseXpr(session.xpr), { model: bd.snapshot(result.rows), stamp: await hash(target.file), projectStamp: await hash(session.xpr) }));
                } else {
                    const file = (await files({ filters: { 'Vivado Block Design': ['bd'] }, openLabel: '选择 Block Design' }))?.[0]?.fsPath;
                    if (!file) return;
                    await session.run('bd_add_file', bd.importSource(file));
                    const target = assets(parseXpr(session.xpr), BD_EXTENSION).find(item => samePath(item.file, file));
                    if (!target) throw new Error('Vivado 未将所选 Block Design 加入工程');
                    panels.open({ ...target, xpr: session.xpr });
                }
            });
        } catch (error) { window.showErrorMessage(error.message); }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.vivado.assets.ip', node => ipManager(node?.nodeData)),
        vscode.commands.registerCommand('svtools.vivado.assets.catalog', node => ipCatalog(node?.nodeData)),
        vscode.commands.registerCommand('svtools.vivado.assets.bd', node => blockManager(node?.nodeData))
    );
    const editorSelection = window.onDidChangeActiveTextEditor?.(editor => {
        if (editor && IP_LANGUAGES.includes(editor.document.languageId)) lastHdlEditor = editor;
    });
    if (editorSelection) context.subscriptions.push(editorSelection);
    const configuration = vscode.workspace.onDidChangeConfiguration?.(event => {
        if (event.affectsConfiguration('svtools.vivado.path')) catalogCache.clear();
    });
    if (configuration) context.subscriptions.push(configuration);
}

module.exports = { activateAssetCommands };
