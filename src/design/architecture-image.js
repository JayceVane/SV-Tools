'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildArchitectureBook, assertBookCurrent } = require('./architecture-model');
const { layoutDiagram, renderDiagram } = require('./architecture-diagram');
const { svgDocument } = require('../graphics/image-export');
const { escape } = require('./architecture-details');

/**
 * 独立文档图（document 主题）的灰阶调色板。
 * HTML/PDF 报告沿用查看器的彩色令牌；一旦落到可插入文档的独立 SVG/PNG，
 * 必须回到 R=G=B，保证打印、贴图与既有交付件一致。
 * 接口束与普通信号在灰阶下靠线宽（2.2 / 1.1）和端头形状区分，不靠颜色。
 */
const MONO_TOKENS = {
    page: '#fbfbfb', panel: '#ffffff', sunk: '#f5f5f5', 'sunk-2': '#efefef',
    ink: '#1a1a1a', 'ink-2': '#3a3a3a', muted: '#666666', faint: '#8f8f8f',
    divider: '#e3e3e3', line: '#e3e3e3', 'line-2': '#cbcbcb',
    focus: '#2b2b2b', accent: '#2b2b2b', action: '#2b2b2b',
    bus: '#3c3c3c', wire: '#8f8f8f',
    up: '#333333', down: '#4d4d4d', weak: '#6a6a6a', warn: '#7a7a7a', bad: '#242424',
};

/** 独立图的文字颜色也要是灰阶，不能沿用页面上的蓝灰墨色。 */
const MONO_INK = '#1a1a1a';
const MONO_MUTED = '#666666';

function resolveStyles(shared, diagram, overrides) {
    const tokens = new Map();
    const root = /:root\s*\{([^}]+)\}/u.exec(shared)[1];
    for (const [, name, original] of root.matchAll(/--([\w-]+):\s*([^;]+);/gu)) {
        const value = original.trim().replace(/^var\(--vscode[^,]+,\s*(.*)\)$/u, '$1')
            .replace(/^#([\da-f])([\da-f])([\da-f])$/iu, '#$1$1$2$2$3$3');
        tokens.set(name, value.replace(/var\(--([\w-]+)\)/gu, (_, reference) => tokens.get(reference) || ''));
    }
    for (const [name, value] of Object.entries(overrides || {})) tokens.set(name, value);
    const resolved = diagram.replace(/var\(--([\w-]+)\)/gu, (_, name) => tokens.get(name) || tokens.get('focus'))
        .replace(/color-mix\(in srgb,\s*#([\da-f]{6})\s+(\d+)%,\s*#([\da-f]{6})\)/giu, (_, first, amount, second) => {
            const ratio = Number(amount) / 100;
            return '#' + [0, 2, 4].map(offset => Math.round(parseInt(first.slice(offset, offset + 2), 16) * ratio
                + parseInt(second.slice(offset, offset + 2), 16) * (1 - ratio)).toString(16).padStart(2, '0')).join('');
        });
    if (/var\(--|color-mix\(/u.test(resolved)) {
        throw new Error('独立架构图仍有未解析的主题令牌，PNG 栅格化会与浏览器不一致。');
    }
    return resolved;
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
    const evidence = { ...image.evidence, layout: {
        ...image.evidence.layout, renderer: 'block-design', theme: 'mono', revision: loaded.book.revision,
    }, export: { ...image.evidence.export, width, height } };
    const title = evidence.export.title;
    const drawing = renderDiagram(layout, display, false).replace(/<a\b[^>]*>|<\/a>/gu, '');
    const body = `<metadata id="svtools-evidence">${escape(JSON.stringify(evidence))}</metadata>
        <style>${resolveStyles(shared, diagram, MONO_TOKENS)}</style>
        <text x="16" y="26" fill="${MONO_INK}" font-family="Segoe UI, Microsoft YaHei UI, sans-serif" font-size="17">${escape(title)}</text>
        <text x="16" y="46" fill="${MONO_MUTED}" font-family="Consolas, monospace" font-size="11">${escape(page.name)} · ${escape(arch.contextRevision.slice(0, 12))}</text>
        <g transform="translate(16,64)">${drawing}</g>`;
    const svg = svgDocument({ width, height, title, detail: 'Block Design · 源级结构（灰阶）', body, background: '#ffffff' });
    await assertBookCurrent(loaded);
    return { ...image, svg, evidence, width, height, bytes: Buffer.byteLength(svg, 'utf8'), sha256: createHash('sha256').update(svg).digest('hex') };
}

module.exports = { blockDesignImage, resolveStyles, MONO_TOKENS };
