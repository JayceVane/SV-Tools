'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { literal } = require('./asset-task');

const REPORTS = ['utilization', 'power', 'drc'];
const GENERATED_REPORTS_KEY = 'svtools.vivado.summaryReports';
const MAX_PREFIX = 512 * 1024;
const RESOURCE_NAMES = [
    ['lut', /^(?:slice|clb) luts?$/i],
    ['ff', /^(?:slice|clb) registers$/i],
    ['bram', /^block ram tiles?$/i],
    ['dsp', /^dsps?(?: blocks| slices)?$/i],
    ['uram', /^uram(?:s|288)?$/i],
    ['io', /^(?:bonded iobs?|user i\/o)$/i]
];
const SEVERITIES = ['errors', 'criticalWarnings', 'warnings', 'advisories', 'other'];

const columns = line => {
    const text = line.trim();
    return text.startsWith('|') && text.endsWith('|') ? text.slice(1, -1).split('|').map(cell => cell.trim()) : [];
};
function number(text) {
    const clean = String(text ?? '').replaceAll(',', '').trim();
    if (!/^-?\d+(?:\.\d+)?$/u.test(clean)) return null;
    const value = Number(clean);
    return Number.isFinite(value) ? value : null;
}

function utilization(text) {
    const measures = new Map();
    let usedIndex = -1, availableIndex = -1;
    for (const line of text.split(/\r?\n/u)) {
        const [name, ...cells] = columns(line);
        if (!name) continue;
        if (cells.includes('Used') && cells.includes('Available')) {
            usedIndex = cells.indexOf('Used');
            availableIndex = cells.indexOf('Available');
            continue;
        }
        const resource = RESOURCE_NAMES.find(([, pattern]) => pattern.test(name.replace(/[\s*]+$/u, '')));
        if (usedIndex < 0 || !resource || measures.has(resource[0])) continue;
        const used = number(cells[usedIndex]), available = number(cells[availableIndex]);
        if (used === null || available === null) continue;
        measures.set(resource[0], { resource: resource[0], used, available });
    }
    return measures.size ? RESOURCE_NAMES.flatMap(([key]) => measures.has(key) ? [measures.get(key)] : []) : null;
}

function power(text) {
    const values = {};
    for (const line of text.split(/\r?\n/u)) {
        const [label, value] = columns(line);
        if (/^total on-chip power\s*\(w\)$/i.test(label)) values.total = number(value);
        else if (/^dynamic\s*\(w\)$/i.test(label)) values.dynamic = number(value);
        else if (/^device static\s*\(w\)$/i.test(label)) values.static = number(value);
        else if (/^confidence level$/i.test(label)) values.confidence = value;
    }
    return values.total != null ? values : null;
}

function drc(text) {
    const counts = Object.fromEntries(SEVERITIES.map(key => [key, 0]));
    const reported = number(/^\s*Violations found:\s*([\d,]+)\s*$/imu.exec(text)?.[1]);
    if (reported === 0 || /^\s*(?:no drc violations (?:were )?(?:found|detected)|no rule violations (?:were )?found)\.?\s*$/imu.test(text)) {
        return { total: 0, counts, rules: [] };
    }
    const rules = [];
    let indexes, hasRows = false, complete = false;
    for (const line of text.split(/\r?\n/u)) {
        const cells = columns(line);
        if (!indexes && cells.includes('Rule') && cells.includes('Severity') && cells.includes('Violations')) {
            indexes = ['Rule', 'Severity', 'Violations'].map(label => cells.indexOf(label));
            continue;
        }
        if (!indexes) continue;
        if (!cells.length && hasRows && /^\s*\+/u.test(line)) { complete = true; break; }
        const [rule, severity, violations] = indexes.map(index => cells[index]);
        const count = number(violations);
        if (!rule || !Number.isSafeInteger(count) || count < 0) continue;
        hasRows = true;
        const level = { error: 'errors', 'critical warning': 'criticalWarnings', warning: 'warnings',
            advisory: 'advisories', info: 'advisories' }[String(severity).trim().toLowerCase()] || 'other';
        counts[level] += count;
        if (count) rules.push({ rule, level, count });
    }
    if (!indexes || !complete) return null;
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (reported !== null && reported !== total) return null;
    rules.sort((left, right) => SEVERITIES.indexOf(left.level) - SEVERITIES.indexOf(right.level) || right.count - left.count);
    return { total, counts, rules: rules.slice(0, 5) };
}

const parsers = { utilization, power, drc };
const reportName = /^(?:.*_)?(utilization|power|drc)(?:_([a-z0-9-]+))?\.rpt$/iu;
const stagePriority = { bitstream: 7, routed: 6, route: 6, physopt: 5, postroute: 5, placed: 4, place: 4, opt: 3, opted: 3, synth: 2 };
const stageOf = phase => stagePriority[phase] || 0;

async function filesIn(directory) {
    if (!directory) return [];
    return fs.readdir(directory, { withFileTypes: true }).catch(() => []);
}

const fileStamp = stat => [stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const getFile = async file => (await fs.lstat(file).catch(() => null))?.isFile() === true;
function keep(map, key, value, bound) {
    map.delete(key);
    map.set(key, value);
    if (map.size > bound) map.delete(map.keys().next().value);
}

/** 只读取当前综合和实现的报告。报告摘要位于文件开头，轮询按文件指纹复用解析结果。 */
function createSummaryReports(workspaceState) {
    const cache = new Map(), generated = new Map(workspaceState?.get(GENERATED_REPORTS_KEY, []) || []);

    async function parsedReport(kind, file, stat) {
        const stamp = fileStamp(stat);
        const previous = cache.get(file);
        if (previous?.stamp === stamp) return previous.value;
        const handle = await fs.open(file, 'r').catch(() => null);
        if (!handle) return null;
        try {
            const buffer = Buffer.alloc(Math.min(MAX_PREFIX, stat.size));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const value = parsers[kind](buffer.subarray(0, bytesRead).toString('utf8'));
            if (fileStamp(await handle.stat()) !== stamp) return null;
            keep(cache, file, { stamp, value }, 32);
            return value;
        } catch {
            return null;
        } finally {
            await handle.close();
        }
    }

    async function inspect(run, directory) {
        const reports = {};
        const checkpoints = [];
        const candidates = Object.fromEntries(REPORTS.map(kind => [kind, []]));
        for (const entry of await filesIn(directory)) {
            if (!entry.isFile()) continue;
            const file = path.join(directory, entry.name);
            if (/\.dcp$/iu.test(entry.name)) {
                const phase = (/_([a-z]+)\.dcp$/iu.exec(entry.name)?.[1] || '').toLowerCase();
                checkpoints.push({ file, phase });
                continue;
            }
            const match = reportName.exec(entry.name);
            if (!match || /(?:^|_)(?:methodology_drc|clock_utilization)(?:_|\.)/iu.test(entry.name)) continue;
            candidates[match[1].toLowerCase()].push({ file, phase: match[2]?.toLowerCase() || '' });
        }
        async function existing(items) {
            const checked = await Promise.all(items.map(async item => ({ ...item, stat: await fs.lstat(item.file).catch(() => null) })));
            return checked.filter(item => item.stat?.isFile()).sort((a, b) =>
                stageOf(b.phase) - stageOf(a.phase) || b.stat.mtimeMs - a.stat.mtimeMs);
        }
        const checkpoint = (await existing(checkpoints))[0];
        const identity = checkpoint && [run.id, checkpoint.file, fileStamp(checkpoint.stat)].join('\0');
        await Promise.all(REPORTS.map(async kind => {
            const extra = generated.get(identity)?.[kind];
            const known = await existing(candidates[kind]);
            const additional = extra ? await existing([{ file: extra, phase: checkpoint.phase }]) : [];
            for (const candidate of [...known, ...additional]) {
                const data = await parsedReport(kind, candidate.file, candidate.stat);
                if (!data) continue;
                reports[kind] = { run: run.id, phase: candidate.phase, stale: run.needsRefresh, data, file: candidate.file };
                break;
            }
        }));
        return { run, identity, reports };
    }

    return {
        async read(snapshot, paths) {
            const current = [snapshot.currentRuns.implementation || 'impl_1', snapshot.currentRuns.synthesis || 'synth_1'];
            const runs = current.map(id => snapshot.runs.find(run => run.id === id)).filter(Boolean);
            const inspections = await Promise.all(runs.map(run => inspect(run,
                Object.hasOwn(paths, run.id) ? paths[run.id].directory : undefined)));
            const results = {};
            for (const kind of REPORTS) {
                const match = inspections.find(item => item.reports[kind])?.reports[kind];
                if (match) results[kind] = match;
            }
            if (!results.power) {
                const run = runs.find(item => Number.isFinite(item.power));
                if (run) results.power = { run: run.id, stale: run.needsRefresh, data: { total: run.power } };
            }
            const preferred = inspections.find(item => item.identity && /complete/i.test(item.run.status));
            const kinds = preferred ? REPORTS.filter(kind => !preferred.reports[kind]) : [];
            const generation = kinds.length ? { run: preferred.run.id, identity: preferred.identity, kinds } : null;
            return { results, generation };
        },
        async isCurrent(request) {
            const [, file, stamp] = request.identity.split('\0');
            const stat = await fs.lstat(file).catch(() => null);
            return Boolean(stat?.isFile() && fileStamp(stat) === stamp);
        },
        async remember(request, directory) {
            const files = { ...generated.get(request.identity) };
            for (const kind of request.kinds) {
                const file = path.join(directory, 'summary_' + kind + '.rpt');
                if (await getFile(file)) files[kind] = file;
            }
            keep(generated, request.identity, files, 16);
            await workspaceState?.update(GENERATED_REPORTS_KEY, [...generated]);
        }
    };
}

/** 在独立批处理会话中打开现有 run。报告写入当前任务目录。 */
function analysisCommands({ run, kinds }) {
    return [
        'open_run ' + literal(run),
        ...REPORTS.filter(kind => kinds.includes(kind)).map(kind =>
            'if {[catch {report_' + kind + ' -file [file join [pwd] summary_' + kind + '.rpt]} message]} { sv_row analysis_error ' + kind + ' $message }')
    ];
}

module.exports = { createSummaryReports, analysisCommands };
