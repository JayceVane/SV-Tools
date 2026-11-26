'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildArchitectureBook, assertBookCurrent } = require('./architecture-model');
const { layoutDiagram, renderDiagram } = require('./architecture-diagram');
const { svgDocument } = require('../graphics/image-export');
const { escape } = require('./architecture-details');

function resolveStyles(shared, diagram) {
    const tokens = new Map();
    const root = /:root\s*\{([^}]+)\}/u.exec(shared)[1];
    for (const [, name, original] of root.matchAll(/--([\w-]+):\s*([^;]+);/gu)) {
        const value = original.trim().replace(/^var\(--vscode[^,]+,\s*(.*)\)$/u, '$1')
            .replace(/^#([\da-f])([\da-f])([\da-f])$/iu, '#$1$1$2$2$3$3');
        tokens.set(name, value.replace(/var\(--([\w-]+)\)/gu, (_, reference) => tokens.get(reference) || ''));
    }
    return diagram.replace(/var\(--([\w-]+)\)/gu, (_, name) => tokens.get(name) || tokens.get('focus'))
        .replace(/color-mix\(in srgb,\s*#([\da-f]{6})\s+(\d+)%,\s*#([\da-f]{6})\)/giu, (_, first, amount, second) => {
            const ratio = Number(amount) / 100;
            return '#' + [0, 2, 4].map(offset => Math.round(parseInt(first.slice(offset, offset + 2), 16) * ratio
                + parseInt(second.slice(offset, offset + 2), 16) * (1 - ratio)).toString(16).padStart(2, '0')).join('');
        });
}

async function blockDesignImage(snapshot, arch, image, { style, detail, bundle }) {
    if (arch.engine !== 'struct' || style !== 'document' || detail !== 'interfaces' || bundle) return image;
    const loaded = await buildArchitectureBook(snapshot);
    const page = loaded.book.pages[0];
    const display = page.hasStructure ? page : { ...page, hasStructure: true, links: [], nodes: [{
        id: 'instance:' + page.name, name: page.name, type: page.name, kind: 'instance', ports: page.ports,
        implementation: page.empty ? 'stub' : 'defined',
    }] };
    const layout = await layoutDiagram(display, page.hasStructure ? page.auto : 'detailed');
    const [shared, diagram] = await Promise.all(['architecture.css', 'architecture-diagram.css']
        .map(file => fs.readFile(path.join(__dirname, file), 'utf8')));
    const width = Math.max(480, layout.width + 32), height = layout.height + 88;
    const evidence = { ...image.evidence, layout: { ...image.evidence.layout, renderer: 'block-design', revision: loaded.book.revision },
        export: { ...image.evidence.export, width, height } };
    const title = evidence.export.title;
    const drawing = renderDiagram(layout, display, false).replace(/<a\b[^>]*>|<\/a>/gu, '');
    const body = `<metadata id="svtools-evidence">${escape(JSON.stringify(evidence))}</metadata>
        <style>${resolveStyles(shared, diagram)}</style>
        <text x="16" y="26" fill="#16202c" font-family="Segoe UI, Microsoft YaHei UI, sans-serif" font-size="17">${escape(title)}</text>
        <text x="16" y="46" fill="#5c6b7a" font-family="Consolas, monospace" font-size="11">${escape(page.name)} · ${escape(arch.contextRevision.slice(0, 12))}</text>
        <g transform="translate(16,64)">${drawing}</g>`;
    const svg = svgDocument({ width, height, title, detail: 'Block Design · 源级结构', body, background: '#ffffff' });
    await assertBookCurrent(loaded);
    return { ...image, svg, evidence, width, height, bytes: Buffer.byteLength(svg, 'utf8'), sha256: createHash('sha256').update(svg).digest('hex') };
}

module.exports = { blockDesignImage };
