'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, result } = require('./protocol');
const { readOptions, listProjects, page, hash } = require('./context');
const { readJson } = require('./storage');
const { executeAsset, locateVivado } = require('./vivado');
const { acquireWorkspaceLease } = require('../toolchains/workspace-lease');
const { keyOf } = require('../project/model');
const { parseXpr, samePath } = require('../vivado/xpr');
const { rowsOf, parametersOf } = require('../vivado/asset-task');
const { createIpMetadata } = require('../vivado/ip-metadata');
const { readAssetText } = require('../vivado/asset-preview');
const summary = require('../vivado/summary');
const { createSummaryReports } = require('../vivado/summary-reports');
const { createSummaryMessages } = require('../vivado/summary-messages');
const ip = require('../vivado/ip');
const bd = require('../vivado/block-design');

const commands = {
    ip: ['list', 'catalog', 'inspect', 'create', 'configure', 'import', 'generate', 'template', 'upgrade', 'synthesize', 'repositories'],
    bd: ['list', 'inspect', 'create', 'import', 'edit', 'validate', 'generate', 'wrapper', 'export']
};
const capabilities = ['vivado.overview', 'vivado.messages', 'vivado.report.power', ...Object.entries(commands)
    .flatMap(([kind, verbs]) => verbs.map(verb => 'vivado.' + kind + '.' + verb))];
const severity = { error: 'errors', 'critical-warning': 'criticalWarnings', warning: 'warnings', info: 'info', status: 'status' };
const extensions = { ip: /\.(?:xci|xcix)$/iu, bd: /\.bd$/iu };

async function target(input) {
    const { options } = await readOptions(input);
    const candidates = options.project ? [{ path: path.resolve(options.workspace, options.project) }] : await listProjects(options.workspace);
    if (candidates.length > 1) fail('AMBIGUOUS_PROJECT', '工作区存在多个工程，请显式指定--project', { candidates });
    const xpr = candidates[0]?.path;
    if (!xpr || !/\.xpr$/iu.test(xpr)) fail('VIVADO_PROJECT_REQUIRED', 'Vivado 操作要求 --project 指向 .xpr 工程');
    const file = await fs.realpath(xpr).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
    });
    if (!file || !(await fs.stat(file)).isFile()) fail('PROJECT_NOT_FOUND', 'Vivado 工程不存在', { project: xpr });
    return { options, xpr: file };
}

function fromRows(rows, type, label) {
    const value = rowsOf(rows, type)[0]?.[0];
    if (!value) fail('VIVADO_NO_RESULT', 'Vivado 未返回' + label);
    return value;
}

function runBatch(project, body, runner, readOnly = true) {
    const { options, xpr } = project;
    return executeAsset(options, xpr, body, { runner, readOnly });
}

function members(project, kind) {
    return parseXpr(project.xpr).sets.flatMap(({ name, files }) => files
        .filter(file => extensions[kind].test(file)).map(file => ({ file, fileset: name, name: path.basename(file, path.extname(file)) })));
}

function fileOption(project, kind) {
    const { file } = project.options;
    if (!file || !extensions[kind].test(file)) fail('INVALID_ARGUMENT', kind === 'ip' ? '需要 --file <XCI|XCIX>' : '需要 --file <BD>');
    return path.resolve(project.options.workspace, file);
}

function memberFile(project, kind) {
    const file = fileOption(project, kind);
    if (!members(project, kind).some(item => samePath(item.file, file))) {
        fail('ASSET_NOT_FOUND', '资产不属于所选 Vivado 工程', { file, project: project.xpr });
    }
    return file;
}

async function locked(project, action) {
    const release = await acquireWorkspaceLease(project.options.workspace, 'vivado-' + hash(keyOf(project.xpr)).slice(0, 32));
    try { return await action(); }
    finally { await release(); }
}

function build(factory) {
    try { return factory(); }
    catch (error) { fail('INVALID_ARGUMENT', error.message); }
}

async function spec(project) {
    const value = project.options.spec;
    if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGUMENT', '需要 --spec <JSON|文件>');
    try {
        return /^[\[{]/u.test(value.trimStart()) ? JSON.parse(value) : await readJson(path.resolve(project.options.workspace, value));
    } catch (error) {
        fail('INVALID_ARGUMENT', '无法读取 --spec：' + error.message);
    }
}

function changes(items) {
    const text = value => typeof value === 'string' && value.length <= 65536 && !value.includes('\0');
    if (!Array.isArray(items) || !items.length || items.length > 256 ||
        items.some(item => !item || typeof item.key !== 'string' || !/^CONFIG\.[\w.:-]+$/u.test(item.key) || !text(item.before) || !text(item.value)) ||
        new Set(items.map(item => item.key)).size !== items.length) {
        fail('INVALID_ARGUMENT', '配置需要不同的 CONFIG 参数及其字符串 before/value');
    }
    return items;
}

function queryItems(items, query, fields, { offset, limit } = {}) {
    const term = String(query || '').toLowerCase().trim();
    return page(term ? items.filter(item => fields(item).some(value => value?.toLowerCase().includes(term))) : items, offset, limit);
}

async function overview(project, runner, messagesOnly) {
    const { offset = 0, limit = 50, run, severity: level, query } = project.options;
    if (messagesOnly) {
        page([], offset, limit);
        if (level && !Object.hasOwn(severity, level)) fail('INVALID_ARGUMENT', '未知的消息级别');
    }
    const { rows, artifacts } = await runBatch(project, summary.query(), runner);
    fromRows(rows, 'project', '工程状态');
    const snapshot = summary.parse(rows), allPaths = summary.runPaths(snapshot, project.xpr);
    if (messagesOnly && run && !Object.hasOwn(allPaths, run)) fail('VIVADO_RUN_NOT_FOUND', '找不到所选顶层运行', { run });
    const paths = messagesOnly && run ? { [run]: allPaths[run] } : allPaths;
    const messages = createSummaryMessages();
    const counts = await messages.summarize(paths);
    artifacts.push(...Object.keys(counts).map(id => ({ kind: 'log', path: paths[id].log, run: id })));
    if (messagesOnly) {
        const filtered = messages.page(paths, { run, level: severity[level], search: query, offset, limit });
        const items = filtered.items.map(item => ({ ...item, file: paths[item.run].log }));
        return { data: { ...filtered, items, counts, nextOffset: offset + limit < filtered.total ? offset + limit : null }, artifacts };
    }
    const { results } = await createSummaryReports().read(snapshot, allPaths);
    const reports = [...Object.values(results.utilization), results.timing, results.power, results.drc];
    artifacts.push(...reports.filter(item => item?.file).map(item => ({ kind: 'report', path: item.file, run: item.run })));
    return { data: { ...snapshot, reports: results, runMessages: counts }, artifacts };
}

async function details(project, rows, runner) {
    fromRows(rows, 'ip', 'IP 参数');
    const [name, vlnv, locked, upgrade, checkpoint, ...targets] = rowsOf(rows, 'ip')[0];
    const flag = value => value === '1' || value === 'true';
    const bin = runner ? undefined : path.dirname(await locateVivado(project.options));
    const describe = createIpMetadata(() => bin);
    return describe({ name, vlnv, locked: flag(locked), upgrade, checkpoint: flag(checkpoint), targets,
        parameters: parametersOf(rows) }, rowsOf(rows, 'definition_xml')[0]?.[0]);
}

async function taskArtifact(output, name, kind) {
    if (fromRows(output.rows, 'artifact', '产物路径') !== name) fail('VIVADO_RESULT_INVALID', 'Vivado 返回意外的产物路径');
    const file = path.join(output.directory, name);
    if (!(await fs.lstat(file).catch(() => null))?.isFile()) fail('VIVADO_NO_RESULT', 'Vivado 未生成产物 ' + name, { artifacts: output.artifacts });
    output.artifacts.push({ kind, path: file });
    return file;
}

async function ipCommand(project, verb, runner) {
    const options = project.options;
    if (verb === 'catalog') {
        const { rows, artifacts } = await runBatch(project, ip.catalog(), runner);
        fromRows(rows, 'tool', 'IP Catalog 信息');
        const [version, part] = rowsOf(rows, 'tool')[0];
        const items = rowsOf(rows, 'definition').map(([vlnv, label, description, ipi, ...categories]) =>
            ({ vlnv, label: label || vlnv, description, ipi: ipi === '1', categories }));
        return { data: { version, part, ...queryItems(items, options.query, item => [item.vlnv, item.label, item.description, ...item.categories], options) }, artifacts };
    }
    if (verb === 'repositories') {
        const { rows, artifacts } = await runBatch(project, ip.repositories(), runner);
        return { data: { repositories: rowsOf(rows, 'repo').map(([repo]) => repo) }, artifacts };
    }
    if (verb === 'inspect') {
        const file = memberFile(project, 'ip');
        // Vivado 将只读工程里的 IP 一律标为锁定。正常打开才能查询真实状态。
        const { rows, artifacts } = await runBatch(project, ip.info(file), runner, false);
        return { data: { file, ...await details(project, rows, runner) }, artifacts };
    }
    return locked(project, async () => {
        if (verb === 'create' || verb === 'import') {
            const body = build(() => verb === 'create' ? ip.create({ name: options.name, vlnv: options.vlnv }) :
                ip.importSource(fileOption(project, 'ip'), options.copy === true));
            const { rows, artifacts } = await runBatch(project, body, runner, false);
            return { data: { file: fromRows(rows, verb === 'create' ? 'created' : 'imported', 'IP 路径') }, artifacts };
        }
        const file = memberFile(project, 'ip');
        if (verb === 'configure') {
            const edits = changes(await spec(project));
            const body = build(() => ip.configure(file, edits, { readBack: true }));
            const { rows, artifacts } = await runBatch(project, body, runner, false);
            const info = await details(project, rows, runner);
            return { data: { file, ...info }, artifacts };
        }
        if (verb === 'template') {
            const suffix = options.language === 'vhdl' ? '.vho' : '.veo';
            if (options.language && !['verilog', 'vhdl'].includes(options.language)) fail('INVALID_ARGUMENT', '模板语言须为 verilog 或 vhdl');
            const output = await runBatch(project, ip.template(file, suffix), runner, false);
            return { data: { file, template: await taskArtifact(output, 'template' + suffix, 'template') }, artifacts: output.artifacts };
        }
        const body = build(() => verb === 'generate' ? ip.generate(file, options.target || 'all') :
            verb === 'upgrade' ? ip.upgrade(file) : ip.synthesize(file));
        const { artifacts } = await runBatch(project, body, runner, false);
        return { data: { file, ...(verb === 'generate' ? { target: options.target || 'all' } : {}) }, artifacts };
    });
}

function blockEdit(file, edit) {
    if (!edit || typeof edit !== 'object') fail('INVALID_ARGUMENT', '需要 Block Design 编辑对象');
    const endpoint = item => {
        if (!item || typeof item.id !== 'string' || !item.id || !['pin', 'interface_pin', 'port', 'interface_port'].includes(item.kind)) {
            fail('INVALID_ARGUMENT', 'Block Design 端点必须包含有效的 kind 和 id');
        }
        return item;
    };
    switch (edit.action) {
        case 'add-cell': return bd.addCell(file, edit);
        case 'add-port': return bd.addPort(file, edit);
        case 'add-interface-port': return bd.addInterfacePort(file, edit);
        case 'connect': return bd.connect(file, endpoint(edit.from), endpoint(edit.to), undefined, edit.level);
        case 'disconnect': {
            const item = endpoint(edit.endpoint), net = edit.net;
            if (!net || typeof net.id !== 'string' || !net.id || net.kind !== (bd.isInterface(item) ? 'interface_net' : 'net')) {
                fail('INVALID_ARGUMENT', '断开连接需指定同类型的网络和端点');
            }
            return bd.disconnect(file, net, item);
        }
        case 'externalize': return bd.externalize(file, endpoint(edit.endpoint));
        case 'configure-cell': return bd.configure(file, edit.id, changes(edit.changes));
        case 'configure-port': return bd.configurePort(file, endpoint(edit.endpoint), changes(edit.changes));
        case 'assign-addresses': return bd.assignAddresses(file);
        case 'map-address': return bd.mapAddress(file, edit);
        case 'set-address': return bd.setAddress(file, edit.id, edit);
        default: fail('INVALID_ARGUMENT', '未知的 Block Design 编辑动作');
    }
}

async function blockCommand(project, verb, runner) {
    if (verb === 'inspect' || verb === 'validate' || verb === 'export') {
        const file = memberFile(project, 'bd');
        const stamp = verb === 'inspect' ? (await readAssetText(file)).stamp : null;
        // Vivado requires a writable session to infer interface parameters during validation.
        const output = await runBatch(project, { inspect: bd.read, validate: bd.check, export: bd.exportTcl }[verb](file), runner, verb !== 'validate');
        if (verb === 'export') return { data: { file, tcl: await taskArtifact(output, 'block-design.tcl', 'tcl') }, artifacts: output.artifacts };
        if (verb === 'validate') return { data: { file, validated: true }, artifacts: output.artifacts };
        fromRows(output.rows, 'design', 'Block Design 模型');
        if ((await readAssetText(file)).stamp !== stamp) fail('CONTEXT_CHANGED', 'Block Design 在读取期间发生变化');
        return { data: { file, stamp, ...bd.snapshot(output.rows) }, artifacts: output.artifacts };
    }
    return locked(project, async () => {
        if (verb === 'create') {
            const body = build(() => bd.create(project.options.name));
            const { rows, artifacts } = await runBatch(project, body, runner, false);
            return { data: { file: fromRows(rows, 'created', 'Block Design 路径') }, artifacts };
        }
        const file = verb === 'import' ? fileOption(project, 'bd') : memberFile(project, 'bd');
        if (verb === 'edit') {
            const edit = await spec(project);
            const body = build(() => blockEdit(file, edit));
            if (!/^[0-9a-f]{64}$/u.test(project.options.expect || '')) fail('INVALID_ARGUMENT', '编辑需要 bd inspect 返回的 --expect <stamp>');
            if ((await readAssetText(file)).stamp !== project.options.expect) fail('CONTEXT_CHANGED', 'Block Design 已变化，请重新读取');
            const { rows, artifacts } = await runBatch(project, [...body, ...bd.inspect()], runner, false);
            return { data: { file, stamp: (await readAssetText(file)).stamp, ...bd.snapshot(rows) }, artifacts };
        }
        const body = build(() => ({ import: bd.importSource, generate: bd.generate, wrapper: bd.wrapper }[verb])(file));
        const { artifacts } = await runBatch(project, body, runner, false);
        return { data: { file }, artifacts };
    });
}

async function command(action, verb, input, { runner } = {}) {
    const standalone = ['overview', 'messages'].includes(action) && !verb;
    if (!standalone && !commands[action]?.includes(verb)) fail('INVALID_ARGUMENT', '未知的 Vivado 资产命令');
    const project = await target(input);
    const output = standalone ? await overview(project, runner, action === 'messages') :
        verb === 'list' ? { data: queryItems(members(project, action), input.query, item => [item.file, item.fileset], input), artifacts: [] } :
        await (action === 'ip' ? ipCommand : blockCommand)(project, verb, runner);
    const operation = 'vivado.' + action + (verb ? '.' + verb : '');
    return result(operation, { xpr: project.xpr, source: 'project', ...output.data }, null, [], output.artifacts);
}

module.exports = { command, capabilities };
