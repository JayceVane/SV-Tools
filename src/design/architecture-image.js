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
    // 交互态令牌在浏览器里由 [data-state] 规则就地定义；独立图没有状态，固定为灰阶焦点色。
    active: '#2b2b2b',
};

/** 独立图的文字颜色也要是灰阶，不能沿用页面上的蓝灰墨色。 */
const MONO_INK = '#1a1a1a';
const MONO_MUTED = '#666666';

/** 解析 :root 主题令牌：先登记原值，再递归求值；前向引用、循环引用和拼写错误都会显式失败。 */
function resolveTokens(shared, overrides) {
    const root = /:root\s*\{([^}]+)\}/u.exec(shared)?.[1];
    if (!root) throw new Error('架构样式缺少 :root 主题令牌。');
    const declared = new Map();
    for (const [, name, original] of root.matchAll(/--([\w-]+):\s*([^;]+);/gu)) {
        declared.set(name, original.trim().replace(/^#([\da-f])([\da-f])([\da-f])$/iu, '#$1$1$2$2$3$3'));
    }
    for (const [name, value] of Object.entries(overrides || {})) declared.set(name, value);
    const resolved = new Map();
    const resolve = (name, stack = []) => {
        if (resolved.has(name)) return resolved.get(name);
        if (!declared.has(name)) throw new Error('独立架构图引用了未知主题令牌 --' + name + '。');
        if (stack.includes(name)) throw new Error('主题令牌存在循环引用：' + [...stack, name].join(' → '));
        // 逐层剥掉 VS Code 变量：var(--vscode-x, fallback) 取 fallback，嵌套形式也能处理。
        let raw = declared.get(name);
        for (let next = raw.replace(/var\(--vscode[^,]+,\s*(.*)\)$/u, '$1'); next !== raw;
            next = raw.replace(/var\(--vscode[^,]+,\s*(.*)\)$/u, '$1')) raw = next;
        const value = raw.replace(/var\(--([\w-]+)\)/gu, (_, reference) => resolve(reference, [...stack, name]));
        resolved.set(name, value);
        return value;
    };
    for (const name of declared.keys()) resolve(name);
    return resolved;
}

function resolveStyles(shared, diagram, overrides) {
    const tokens = resolveTokens(shared, overrides);
    const resolved = diagram.replace(/var\(--([\w-]+)\)/gu, (_, name) => {
        if (!tokens.has(name)) throw new Error('独立架构图引用了未知主题令牌 --' + name + '。');
        return tokens.get(name);
    }).replace(/color-mix\(in srgb,\s*#([\da-f]{6})\s+(\d+)%,\s*#([\da-f]{6})\)/giu, (_, first, amount, second) => {
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
    const drawing = renderDiagram(layout, display, false, { groupActions: false }).replace(/<a\b[^>]*>|<\/a>/gu, '');
    const body = `<metadata id="svtools-evidence">${escape(JSON.stringify(evidence))}</metadata>
        <style>${resolveStyles(shared, diagram, MONO_TOKENS)}</style>
        <text x="16" y="26" fill="${MONO_INK}" font-family="Segoe UI, Microsoft YaHei UI, sans-serif" font-size="17">${escape(title)}</text>
        <text x="16" y="46" fill="${MONO_MUTED}" font-family="Consolas, monospace" font-size="11">${escape(page.name)} · ${escape(arch.contextRevision.slice(0, 12))}</text>
        <g transform="translate(16,64)">${drawing}</g>`;
    const svg = svgDocument({ width, height, title, detail: 'Block Design · 源级结构（灰阶）', body, background: '#ffffff' });
    await assertBookCurrent(loaded);
    return { ...image, svg, evidence, width, height, bytes: Buffer.byteLength(svg, 'utf8'), sha256: createHash('sha256').update(svg).digest('hex') };
}

module.exports = { blockDesignImage, resolveStyles, resolveTokens, MONO_TOKENS };
