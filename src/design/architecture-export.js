'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assertBookCurrent } = require('./architecture-model');
const { layoutDiagram, renderDiagram } = require('./architecture-diagram');
const { escape, code, pageName, sourceLink, portTable, interfaceDetails, signalEnds, backgroundSignals } = require('./architecture-details');
const { printPdf } = require('./note-export');
const { create } = require('./workflow-files');

async function renderArchitectureBook(book) {
    const byId = new Map(book.pages.map(page => [page.id, page]));
    const css = await fs.readFile(path.join(__dirname, 'architecture.css'), 'utf8');
    const chapters = [];
    for (const [index, page] of book.pages.entries()) {
        const diagram = renderDiagram(await layoutDiagram(page, page.auto), page, false);
        const nodes = new Map(page.nodes.map(node => [node.id, node]));
        const instances = page.nodes.filter(node => node.kind === 'instance');
        const instanceTable = instances.length ? `<h3>子模块</h3><table><thead><tr><th scope="col">实例</th><th scope="col">模块</th><th scope="col">源码</th></tr></thead><tbody>${instances.map(node =>
            `<tr><th scope="row">${code(node.name)}</th><td>${node.chapter ? `<a href="#${node.chapter}">${escape(pageName(byId.get(node.chapter)))}</a>` : `${code(node.type)} · 未解析`}${node.implementation === 'stub' ? ' · 实现桩' : ''}</td><td>${sourceLink(node.source, false)}</td></tr>`).join('')}</tbody></table>` : '';
        const interfaces = page.links.filter(link => link.kind === 'interface');
        const signals = page.links.filter(link => link.kind === 'signal' && (page.auto === 'detailed' || !link.labeled));
        const signalTable = signals.length ? `<h3>普通信号</h3><table><thead><tr><th scope="col">信号</th><th scope="col">端点</th><th scope="col">位宽</th></tr></thead><tbody>${signals.map(link =>
            `<tr id="${link.id}"><th scope="row">${code(link.name)}</th><td>${signalEnds(link, nodes)}</td><td>${link.width ?? '—'}</td></tr>`).join('')}</tbody></table>` : '';
        const rootNote = index === 0 ? '<p class="subtle">源级结构快照。方向来自可解析的端口和 modport 声明，适用于架构复核。功能、时序及握手行为需要通过编译和仿真验证。</p>' : '';
        const diagnostics = [...(index === 0 ? [...book.diagnostics, ...book.issues] : []), ...page.checks];
        chapters.push(`<section class="chapter" id="${page.id}"><header><a href="#contents">目录</a>${index ? ` <a href="#${book.pages[0].id}">顶层</a>` : ''}
            <h2>${index + 1}. ${escape(pageName(page))}</h2>${page.title ? `<p class="module-title">${escape(page.title)}</p>` : ''}${rootNote}
            <p class="subtle">${sourceLink(page.source, false)}${page.empty ? ' · 实现桩' : ''}</p></header>
            ${diagram ? `<div class="diagram-print">${diagram}</div>` : ''}${backgroundSignals(page, false)}
            <h3>模块端口</h3>${portTable(page.ports, false)}${instanceTable}
            ${interfaces.length ? `<h3>接口目录</h3><ul class="interface-index">${interfaces.map(link => `<li><a href="#${link.id}">${escape(link.name)} · ${escape(link.type)}</a></li>`).join('')}</ul>` : ''}
            ${signalTable}
            ${interfaces.map(link => `<section class="interface-section" id="${link.id}"><h3>${escape(link.name)}</h3>${interfaceDetails(link, nodes, false)}</section>`).join('')}
            ${diagnostics.length ? `<h3>静态诊断</h3><ul>${diagnostics.map(item => `<li>${escape(item.message || item)}</li>`).join('')}</ul>` : ''}</section>`);
    }
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escape(book.top)} · 架构设计</title><style>${css}</style></head>
        <body class="architecture-book"><main id="contents"><h1>${escape(book.top)} · 架构设计</h1><p class="subtle">结构快照 ${escape(book.revision.slice(0, 12))}</p>
        <nav aria-label="章节目录"><ol>${book.pages.map(page => `<li><a href="#${page.id}">${escape(pageName(page))}</a>${page.title ? ` <span>${escape(page.title)}</span>` : ''}</li>`).join('')}</ol></nav>
        ${chapters.join('')}</main></body></html>`;
}

async function exportArchitecture(loaded, format, { out, browser } = {}) {
    if (format !== 'html' && format !== 'pdf') throw new Error('架构导出格式必须为 HTML 或 PDF。');
    await assertBookCurrent(loaded);
    const html = await renderArchitectureBook(loaded.book);
    let content = html;
    if (format === 'pdf') {
        const temp = await fs.realpath(os.tmpdir());
        const staging = await fs.mkdtemp(path.join(temp, 'svtools-architecture-'));
        try {
            await fs.writeFile(path.join(staging, 'architecture.html'), html, { flag: 'wx' });
            await printPdf(staging, browser, 'architecture');
            content = await fs.readFile(path.join(staging, 'architecture.pdf'));
        } finally {
            const actual = await fs.realpath(staging).catch(() => null);
            if (actual === staging && path.dirname(actual) === temp) await fs.rm(actual, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
        }
    }
    await assertBookCurrent(loaded);
    const destination = out || `.svtools/agent/architecture/${loaded.book.revision.slice(0, 12)}-${randomUUID().slice(0, 8)}/architecture.${format}`;
    return create(loaded.snapshot.context.workspace, destination, content);
}

module.exports = { exportArchitecture, renderArchitectureBook };
