'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

function createBlockDesignCache(directory, kind, limit) {
    // 坐标契约或快照字段变化时更新版本。内容过大的条目留在内存中。
    const filename = directory && path.join(directory, `block-design-${kind}.v1.json`);
    const entries = new Map(), saved = new Map();
    const budget = 2 * 1024 * 1024;
    let bytes = 0;
    let reading, writing = Promise.resolve();
    const warn = error => console.warn(`SV Tools 无法访问 Block Design ${kind}缓存`, error.message);
    function load() {
        return reading ||= (async () => {
            if (!filename) return;
            try {
                const stat = await fs.stat(filename);
                if (stat.size > budget + limit + 2) return;
                const data = JSON.parse(await fs.readFile(filename, 'utf8'));
                if (!Array.isArray(data)) return;
                for (const item of data.slice(-limit)) {
                    if (!Array.isArray(item) || typeof item[0] !== 'string' || !item[1] || entries.has(item[0])) continue;
                    const [id, value] = item, size = Buffer.byteLength(JSON.stringify(item));
                    entries.set(id, value);
                    saved.set(id, size);
                    bytes += size;
                }
            } catch (error) { if (error.code !== 'ENOENT') warn(error); }
        })();
    }
    return {
        async get(id) { await load(); return entries.get(id); },
        async set(id, value) {
            await load();
            entries.delete(id);
            entries.set(id, value);
            bytes -= saved.get(id) || 0;
            saved.delete(id);
            const size = Buffer.byteLength(JSON.stringify([id, value]));
            if (size <= budget) {
                bytes += size;
                saved.set(id, size);
            }
            while (entries.size > limit) {
                const old = entries.keys().next().value;
                entries.delete(old);
                bytes -= saved.get(old) || 0;
                saved.delete(old);
            }
            while (bytes > budget) {
                const old = saved.keys().next().value;
                bytes -= saved.get(old);
                saved.delete(old);
            }
            if (!filename) return;
            const contents = JSON.stringify([...saved.keys()].map(id => [id, entries.get(id)]));
            writing = writing.then(async () => {
                await fs.mkdir(directory, { recursive: true });
                const temp = `${filename}.${randomUUID()}.tmp`;
                try {
                    await fs.writeFile(temp, contents, { flag: 'wx' });
                    await fs.rename(temp, filename);
                } catch (error) {
                    await fs.unlink(temp).catch(ignored => { if (ignored.code !== 'ENOENT') warn(ignored); });
                    throw error;
                }
            }).catch(warn);
            await writing;
        }
    };
}

module.exports = { createBlockDesignCache, digest };
