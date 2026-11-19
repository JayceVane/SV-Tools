'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { fingerprint, json, safePath, MAX_TEXT, MAX_ARTIFACT } = require('./workflow-files');
const { validExpectedValue, compareReviewSample } = require('./review-sample');
const history = require('./note-history-store');
const noteAnchor = require('./note-anchor');
const { readAnchors } = require('../editor/design-notes');

const MANIFEST = 'svtools.review.json';
const MAX_MANIFEST = 512 * 1024;
const statuses = new Set(['passed', 'failed', 'not_triggered', 'inconclusive', 'pending_review']);
const interfaceStatuses = new Set(['compatible', 'mismatch', 'unresolved']);
const changeKinds = new Set(['contract', 'implementation', 'verification']);
const SHA256 = /^[a-f0-9]{64}$/i;

function check(condition, location) {
    if (!condition) throw new Error('设计讲解清单字段无效：' + location);
}

function string(value, location, max = 2000) {
    check(typeof value === 'string' && value.trim() && value.length <= max, location);
    return value;
}

function list(value, location, max, min = 1) {
    check(Array.isArray(value) && value.length >= min && value.length <= max, location);
    return value;
}

function indexed(value, location, max, parse, min = 1) {
    const ids = new Set();
    return list(value, location, max, min).map(item => {
        const id = string(item?.id, location + '.id', 64);
        check(/^[\w-]+$/.test(id) && !ids.has(id), location + '.id');
        ids.add(id);
        return { id, ...parse(item, location + '.' + id) };
    });
}

function fileIdentity(file, key) {
    const relative = string(file?.path, key + '.path', 700);
    check(!path.isAbsolute(relative) && !/[\\:\u0000-\u001f]/.test(relative)
        && relative.split('/').every(part => part && part !== '.' && part !== '..'), key + '.path');
    check(typeof file.sha256 === 'string' && file.sha256.length === 64 && SHA256.test(file.sha256), key + '.sha256');
    return { path: relative, sha256: file.sha256.toLowerCase() };
}

function parseReview(input) {
    check(input?.schemaVersion === 1, 'schemaVersion');
    const title = string(input.title, 'title', 120);
    const files = new Map(indexed(input.files, 'files', 160, (file, key) => {
        const identity = fileIdentity(file, key);
        return { ...identity, label: file.label === undefined ? identity.path : string(file.label, key + '.label', 100) };
    }).map(file => [file.id, file]));
    const links = new Map();
    const observations = new Map();
    const diffs = new Map();
    const notes = new Map();

    function references(inputRefs, key, expectations = new Map()) {
        return list(inputRefs, key, 8, 0).map((ref, index) => {
            const location = key + '[' + index + ']';
            const file = files.get(ref?.file);
            check(file, location + '.file');
            const label = string(ref.label, location + '.label', 100);
            const supportsWave = /\.(vcd|fst)$/i.test(file.path);
            if (ref.line !== undefined)
                check(!supportsWave && Number.isSafeInteger(ref.line) && ref.line >= 1, location + '.line');
            let sample;
            if (ref.sample !== undefined) {
                check(supportsWave, location + '.sample');
                const at = string(ref.sample?.at, location + '.sample.at', 48);
                check(/^\d+(?:\.\d+\s*(?:s|ms|us|ns|ps|fs)|\s*(?:s|ms|us|ns|ps|fs))?$/.test(at), location + '.sample.at');
                const signals = list(ref.sample.signals, location + '.sample.signals', 16)
                    .map(signal => string(signal, location + '.sample.signals', 256));
                const signalNames = new Set(signals);
                check(signalNames.size === signals.length && signals.every(signal => !/[*?]/.test(signal)),
                    location + '.sample.signals');
                const checked = new Set();
                const bindings = list(ref.sample.expect ?? [], location + '.sample.expect', signals.length, 0).map(entry => {
                    const expected = expectations.get(entry?.id);
                    check(expected && signalNames.has(entry.signal) && !checked.has(entry.signal), location + '.sample.expect');
                    checked.add(entry.signal);
                    return { signal: entry.signal, expected };
                });
                sample = { at, signals, bindings };
            }
            const token = 'link-' + links.size;
            links.set(token, { file, line: ref.line, sample, supportsWave });
            return { token, label, hasSample: sample !== undefined };
        });
    }

    const rules = indexed(input.rules, 'rules', 40, (rule, key) => {
        let frozenNote, reviewNote;
        if (rule.note !== undefined) {
            const { id, version, sha256, anchor } = rule.note || {};
            const location = key + '.note';
            check(typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}(?![\s\S])/.test(id), location + '.id');
            check(typeof version === 'string' && /^\d{13}-[a-f0-9]{16}(?![\s\S])/.test(version), location + '.version');
            check(typeof sha256 === 'string' && SHA256.test(sha256), location + '.sha256');
            const file = files.get(anchor?.file);
            check(file && /\.(?:v|vh|sv|svh)$/i.test(file.path) && Number.isSafeInteger(anchor.line) && anchor.line > 0, location + '.anchor');
            const token = 'note-' + notes.size;
            const binding = anchor.binding === undefined ? undefined : fileIdentity(anchor.binding, location + '.anchor.binding');
            if (binding) check(binding.path === noteAnchor.anchorPath(id), location + '.anchor.binding.path');
            frozenNote = { id, version, sha256: sha256.toLowerCase(), file, line: anchor.line, binding };
            notes.set(token, frozenNote);
            reviewNote = { id, version, token };
        }
        const interfaces = rule.interfaces === undefined ? [] : indexed(rule.interfaces, key + '.interfaces', 24, (item, ikey) => {
            function endpoint(side, role) {
                return {
                    module: string(side?.module, ikey + '.' + role + '.module', 120),
                    expectation: string(side.expectation, ikey + '.' + role + '.expectation', 700),
                    refs: references(side.refs ?? [], ikey + '.' + role + '.refs'),
                };
            }
            check(interfaceStatuses.has(item.status), ikey + '.status');
            return {
                title: string(item.title, ikey + '.title', 120),
                from: endpoint(item.from, 'from'), to: endpoint(item.to, 'to'),
                status: item.status, rationale: string(item.rationale, ikey + '.rationale', 700),
            };
        }, 0);
        const interfaceIds = new Set(interfaces.map(item => item.id));
        const variants = indexed(rule.variants, key + '.variants', 4, (variant, vkey) => {
            const inputs = list(variant.inputs, vkey + '.inputs', 48).map(id => {
                check(files.has(id), vkey + '.inputs');
                return files.get(id);
            });
            const run = files.get(variant.run);
            if (variant.run !== undefined) {
                check(run && /\.json$/i.test(run.path) && !inputs.includes(run), vkey + '.run');
                check(new Set(inputs.map(file => file.path)).size === inputs.length, vkey + '.inputs');
            }
            return { label: string(variant.label, vkey + '.label', 100), inputs, run };
        });
        const events = indexed(rule.events, key + '.events', 20, (event, ekey) => {
            const expectedValues = event.expectedValues === undefined ? [] :
                indexed(event.expectedValues, ekey + '.expectedValues', 32, (item, vkey) => {
                    check(validExpectedValue(item.encoding, item.value), vkey + '.value');
                    return { label: string(item.label, vkey + '.label', 100), encoding: item.encoding, value: item.value };
                }, 0);
            const expectations = new Map(expectedValues.map(item => [item.id, item]));
            const activeInterfaces = list(event.interfaces ?? [], ekey + '.interfaces', interfaces.length, 0);
            check(activeInterfaces.every(id => interfaceIds.has(id)) && new Set(activeInterfaces).size === activeInterfaces.length,
                ekey + '.interfaces');
            const perVariant = new Set();
            const evidence = list(event.observations, ekey + '.observations', variants.length).map(obs => {
                const variant = variants.find(item => item.id === obs?.variant);
                check(variant && !perVariant.has(variant.id), ekey + '.observations.variant');
                perVariant.add(variant.id);
                check(statuses.has(obs.status), ekey + '.observations.status');
                const refs = references(obs.refs, ekey + '.observations.refs', expectations);
                check(refs.length > 0, ekey + '.observations.refs');
                const token = 'observation-' + observations.size;
                const evidenceFiles = refs.map(ref => links.get(ref.token).file);
                const observation = {
                    token,
                    files: [...new Set([...variant.inputs, ...evidenceFiles, ...(variant.run ? [variant.run] : []),
                        ...(frozenNote ? [frozenNote.file] : [])])],
                    run: variant.run && { file: variant.run, inputs: variant.inputs, evidenceFiles },
                    status: obs.status, text: string(obs.text, ekey + '.observations.text'), refs,
                    note: frozenNote,
                };
                observations.set(token, observation);
                for (const ref of refs) links.get(ref.token).observation = observation;
                return { token, variant: variant.id };
            });
            const flow = list(event.flow, ekey + '.flow', 8).map(item => ({
                label: string(item?.label, ekey + '.flow.label', 80),
                detail: string(item.detail, ekey + '.flow.detail', 200),
                active: item.active === true,
            }));
            return {
                title: string(event.title, ekey + '.title', 100), flow,
                expected: string(event.expected, ekey + '.expected'), expectedValues,
                refs: references(event.refs, ekey + '.refs'), evidence, interfaces: activeInterfaces,
            };
        });
        const eventIds = new Set(events.map(event => event.id));
        const changes = rule.changes === undefined ? [] : indexed(rule.changes, key + '.changes', 12, (item, ckey) => {
            const from = variants.find(variant => variant.id === item.from);
            const to = variants.find(variant => variant.id === item.to);
            check(from && to && from !== to, ckey + '.from/to');
            check(changeKinds.has(item.kind), ckey + '.kind');
            const affected = new Set();
            const impacts = list(item.impacts, ckey + '.impacts', events.length).map(entry => {
                check(eventIds.has(entry?.event) && !affected.has(entry.event), ckey + '.impacts.event');
                affected.add(entry.event);
                return { event: entry.event, note: string(entry.note, ckey + '.impacts.note', 500) };
            });
            const sourceDiffs = list(item.sourceDiffs ?? [], ckey + '.sourceDiffs', 6, 0).map((entry, index) => {
                const location = ckey + '.sourceDiffs[' + index + ']';
                const before = files.get(entry?.before), after = files.get(entry?.after);
                check(before && after && before.sha256 !== after.sha256, location + '.before/after');
                check(from.inputs.includes(before) && to.inputs.includes(after), location + '.inputs');
                const label = string(entry.label, location + '.label', 100);
                if (entry.afterLine !== undefined)
                    check(Number.isSafeInteger(entry.afterLine) && entry.afterLine > 0, location + '.afterLine');
                const token = 'diff-' + diffs.size;
                diffs.set(token, { before, after, afterLine: entry.afterLine, title: from.label + ' → ' + to.label + ' · ' + label });
                return { token, label };
            });
            return {
                title: string(item.title, ckey + '.title', 120), kind: item.kind, from: from.label, to: to.label,
                before: string(item.before, ckey + '.before', 800), after: string(item.after, ckey + '.after', 800),
                impacts, sourceDiffs,
            };
        }, 0);
        return {
            title: string(rule.title, key + '.title', 120), module: string(rule.module, key + '.module', 100),
            group: rule.group === undefined ? undefined : string(rule.group, key + '.group', 100),
            contract: string(rule.contract, key + '.contract'), mechanism: string(rule.mechanism, key + '.mechanism'),
            stimulus: string(rule.stimulus, key + '.stimulus'), checker: string(rule.checker, key + '.checker'),
            variants: variants.map(({ id, label }) => ({ id, label })), events, interfaces, changes, note: reviewNote,
        };
    });
    return { snapshot: { title, rules }, links, observations, diffs, notes };
}

async function loadReview(root) {
    return parseReview(await json(root, MANIFEST, MAX_MANIFEST));
}

async function verifiedFile(root, file) {
    const match = await fingerprint(root, file.path, MAX_ARTIFACT);
    if (match.sha256 !== file.sha256) {
        const error = new Error('文件与讲解快照不一致：' + file.path);
        error.code = 'REVIEW_CHANGED';
        throw error;
    }
    return safePath(root, file.path);
}

async function verifiedNote(root, note) {
    const saved = await history.readRevision(root, note.id, note.version);
    if (saved.sha256 !== note.sha256) throw new Error('Note 内容与定版记录不一致');
    return saved;
}

async function readReviewRun(root, runFile) {
    const record = await json(root, runFile.path, MAX_MANIFEST);
    await verifiedFile(root, runFile);
    check(record?.schemaVersion === 1, '仿真运行记录.schemaVersion');
    function readFiles(key, max) {
        const location = '仿真运行记录.' + key;
        const paths = new Set();
        return list(record[key], location, max).map((file, index) => {
            const identity = fileIdentity(file, location + '[' + index + ']');
            const fileKey = process.platform === 'win32' ? identity.path.toLowerCase() : identity.path;
            check(!paths.has(fileKey), location + '.重复路径');
            paths.add(fileKey);
            return { ...file, ...identity };
        });
    }
    return { ...record, inputs: readFiles('inputs', 48), artifacts: readFiles('artifacts', 80) };
}

async function runIssues(root, run) {
    const runFile = run.file;
    try {
        const record = await readReviewRun(root, runFile);
        const inputs = new Map(record.inputs.map(file => [file.path, file.sha256]));
        const artifacts = new Map(record.artifacts.map(file => [file.path, file.sha256]));
        const issues = run.inputs.filter(file => inputs.get(file.path) !== file.sha256)
            .map(file => ({ label: file.label, path: file.path, reason: 'run-input' }));
        if (inputs.size !== run.inputs.length)
            issues.push({ label: runFile.label, path: runFile.path, reason: 'run-input' });
        for (const file of new Set(run.evidenceFiles)) {
            const expected = /\.(?:vcd|fst)$/i.test(file.path) ? artifacts.get(file.path) : artifacts.get(file.path) ?? inputs.get(file.path);
            if (file !== runFile && expected !== file.sha256)
                issues.push({ label: file.label, path: file.path, reason: 'run-artifact' });
        }
        return issues;
    } catch {
        return [{ label: runFile.label, path: runFile.path, reason: 'unavailable' }];
    }
}

async function observationIssues(root, observation) {
    const issues = [];
    const { note, run } = observation;
    let anchorPath;
    let runMatches = false;
    for (const file of observation.files) {
        try {
            const verified = await verifiedFile(root, file);
            if (file === note?.file) anchorPath = verified;
            if (file === run?.file) runMatches = true;
        } catch (error) {
            const reason = error.code === 'REVIEW_CHANGED' ? 'changed' :
                error.code === 'ENOENT' ? 'missing' : 'unavailable';
            issues.push({ label: file.label, path: file.path, reason });
        }
    }
    if (runMatches) issues.push(...await runIssues(root, run));
    if (note) {
        try { await verifiedNote(root, note); }
        catch { issues.push({ label: '定版 Note', path: note.id, reason: 'unavailable' }); }
        if (anchorPath) {
            try {
                await fingerprint(root, note.file.path, MAX_TEXT);
                const text = await fs.readFile(anchorPath, 'utf8');
                await verifiedFile(root, note.file);
                let matched;
                if (note.binding) {
                    await verifiedFile(root, note.binding);
                    const metadata = await noteAnchor.readAnchor(root, note.id);
                    matched = metadata && noteAnchor.findIn(text, metadata).some(item => item.line === note.line);
                } else matched = readAnchors(text).markers.get(note.line - 1)?.id === note.id;
                if (!matched)
                    issues.push({ label: 'RTL 锚点', path: note.file.path, reason: 'anchor' });
            } catch { issues.push({ label: 'RTL 锚点', path: note.file.path, reason: 'unavailable' }); }
        }
    }
    return issues;
}

async function revealObservation(root, observation) {
    const issues = await observationIssues(root, observation);
    if (issues.length) return { status: 'unavailable', text: '以下定版输入或产物需重新核对。', refs: [], issues };
    const { status, text, refs } = observation;
    return { status, text, refs };
}

async function verifyObservationLink(root, link) {
    if (!link.observation) return;
    const issues = await observationIssues(root, link.observation);
    if (!issues.length) return;
    const error = new Error('定版材料需重新核对：' + issues.map(issue => issue.label).join('、'));
    error.issues = issues;
    throw error;
}

async function loadReviewSample(root, link) {
    await verifyObservationLink(root, link);
    const file = await verifiedFile(root, link.file);
    const { at, signals, bindings } = link.sample;
    const { data } = await require('../agent/wave').values({
        workspace: root, file, at, exactSignals: signals, asyncOpen: true,
    });
    await verifiedFile(root, link.file);
    await verifyObservationLink(root, link);
    return { time: data.timeText, values: data.values, checks: compareReviewSample(data.values, bindings) };
}

module.exports = { MANIFEST, MAX_MANIFEST, loadReview, parseReview, readReviewRun, verifiedFile, verifiedNote,
    verifyObservationLink, revealObservation, loadReviewSample };
