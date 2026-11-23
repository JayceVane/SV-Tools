'use strict';

const fs = require('node:fs');
const { createInterface } = require('node:readline');

const LEVELS = ['errors', 'criticalWarnings', 'warnings', 'info', 'status'];
const LEVEL_BY_NAME = { ERROR: 'errors', 'CRITICAL WARNING': 'criticalWarnings', WARNING: 'warnings', INFO: 'info', STATUS: 'status' };
const SEVERITY = /^\s*(ERROR|CRITICAL WARNING|WARNING|INFO|STATUS):\s*(.*)$/iu;
const STEP = /^(?:Command:\s*|#\s*)(synth_design|opt_design|power_opt_design|place_design|phys_opt_design|route_design|write_bitstream)\b/iu;
const MAX_BYTES = 64 * 1024 * 1024;
const PAGE_SIZE = 50;
const entryLimit = level => level === 'info' || level === 'status' ? 5000 : 20000;

const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

async function readLog(file, size) {
    const counts = Object.fromEntries(LEVELS.map(level => [level, 0]));
    const entries = [];
    const countsPartial = size > MAX_BYTES;
    let lineNumber = 0, step = '', previous;
    if (!size) return { counts, entries, countsPartial, lineCount: 0 };
    const stream = fs.createReadStream(file, { end: Math.min(size, MAX_BYTES) - 1, encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
        lineNumber++;
        const match = SEVERITY.exec(line);
        if (match) {
            const level = LEVEL_BY_NAME[match[1].toUpperCase()];
            const [, id = '', text = match[2]] = /^(?:\[([^\]]+)\]\s*)?(.*)$/u.exec(match[2]) || [];
            counts[level]++;
            if (counts[level] > entryLimit(level)) { previous = null; continue; }
            previous = { level, id, text: text.slice(0, 4096), line: lineNumber, step };
            entries.push(previous);
            continue;
        }
        const command = STEP.exec(line);
        if (command) step = command[1].toLowerCase();
        if (!command && previous && /^(?:[ \t]+\S|Problem ports:)/iu.test(line) && previous.text.length < 4096) {
            previous.text = (previous.text + '\n' + line.trim()).slice(0, 4096);
        } else previous = null;
    }
    return { counts, entries, countsPartial, lineCount: lineNumber };
}

function createSummaryMessages() {
    const logs = new Map();

    async function read(file) {
        try {
            const stat = await fs.promises.stat(file);
            if (!stat.isFile()) return null;
            const key = stamp(stat);
            if (logs.get(file)?.stamp === key) return logs.get(file);
            const snapshot = await readLog(file, stat.size);
            const durable = await fs.promises.stat(file);
            const entry = { ...snapshot, stamp: stamp(durable) === key ? key : null };
            logs.set(file, entry);
            return entry;
        } catch {
            logs.delete(file);
            return null;
        }
    }

    return {
        async summarize(paths) {
            const files = new Set(Object.values(paths).map(output => output.log).filter(Boolean));
            for (const file of logs.keys()) if (!files.has(file)) logs.delete(file);
            const summary = [];
            const runs = Object.entries(paths).filter(([, output]) => output.log);
            for (let offset = 0; offset < runs.length; offset += 4) {
                const batch = await Promise.all(runs.slice(offset, offset + 4).map(async ([run, output]) => {
                    const data = await read(output.log);
                    return data && [run, { counts: data.counts, countsPartial: data.countsPartial, revision: data.stamp }];
                }));
                summary.push(...batch.filter(Boolean));
            }
            return Object.fromEntries(summary);
        },
        page(paths, { run, level, search, offset, limit = PAGE_SIZE }) {
            const query = typeof search === 'string' ? search.slice(0, 160).trim().toLowerCase() : '';
            const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
            const items = [];
            let total = 0, available = false, truncated = false;
            for (const [id, { log }] of Object.entries(paths)) {
                if (run && run !== id) continue;
                const snapshot = logs.get(log);
                if (!snapshot) continue;
                available = true;
                const levels = level ? [level] : LEVELS;
                truncated ||= snapshot.countsPartial || levels.some(key => snapshot.counts[key] > entryLimit(key));
                for (const entry of snapshot.entries) {
                    if (level && level !== entry.level) continue;
                    if (query && ![entry.id, entry.text, entry.step, id].join(' ').toLowerCase().includes(query)) continue;
                    if (total++ >= start && items.length < limit) items.push({ run: id, ...entry });
                }
            }
            return { items, total, available, truncated, offset: start, size: limit };
        },
        location(paths, run, line) {
            if (!Object.hasOwn(paths, run)) return undefined;
            const file = paths[run].log, snapshot = logs.get(file);
            if (snapshot && Number.isSafeInteger(line) && line >= 1 && line <= snapshot.lineCount) return { file, line };
        }
    };
}

module.exports = { createSummaryMessages, LEVELS };
