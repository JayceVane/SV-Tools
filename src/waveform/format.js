'use strict';
const fs = require('node:fs/promises');

/** 仅读文件头，按实际内容区分 Icarus 等工具写出的 VCD、FST 和其它格式。 */
async function waveformFormat(file) {
    const handle = await fs.open(file, 'r');
    try {
        const head = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        if (bytesRead >= 9 && (head[0] === 254 || (head[0] === 0 && head.readBigUInt64BE(1) === 329n))) return 'fst';
        const text = head.toString('utf8', 0, bytesRead);
        if (/^\s*\$(?:comment|date|version|timescale|scope|upscope|var|enddefinitions)(?=\s|$)/.test(text)) return 'vcd';
    } finally { await handle.close(); }
}

module.exports = { waveformFormat };
