'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { resolveContext, buildArchitectureBook, assertBookCurrent } = require('./architecture-model');
const { hash } = require('../agent/context');
const { fail, result } = require('../agent/protocol');
const { layoutDiagram, renderDiagram } = require('./architecture-diagram');
const { renderGroupDiagrams } = require('./architecture-group');
const { escape, code, pageName, chapterNumber, sourceLink, portTable, renderModuleSymbol, interfaceDetails, signalEnds, connectionPreview } = require('./architecture-details');
const { walkthrough, clockNetworks } = require('./architecture-reading');
const { printPdf } = require('./note-export');
const { create } = require('./workflow-files');

const stubOutput = (page, item) => page.empty && item.code === 'UNDRIVEN_OUTPUT';
const diagnosticItems = items => items.map(item => `<li>${item.code ? code(item.code) + ' ' : ''}${escape(item.message || item)}</li>`).join('');
const pad = value => String(value).padStart(2, '0');
const section = (title, body, count) => body
    ? `<section class="chapter-section"><h3 class="section-title"><span>${title}</span>${count === undefined ? '' : `<span class="section-count">${count}</span>`}</h3>${body}</section>`
    : '';

async function renderArchitectureBook(book, modes, { print = false } = {}) {
    const byId = new Map(book.pages.map(page => [page.id, page]));
    const [sharedCss, diagramCss, symbolCss, bookCss, hoverScript, groupScript, script] = await Promise.all([
        fs.readFile(path.join(__dirname, 'architecture.css'), 'utf8'),
        fs.readFile(path.join(__dirname, 'architecture-diagram.css'), 'utf8'),
        fs.readFile(path.join(__dirname, 'architecture-symbol.css'), 'utf8'),
        fs.readFile(path.join(__dirname, 'architecture-book.css'), 'utf8'),
        fs.readFile(path.join(__dirname, 'architecture-hover.js'), 'utf8'),
        fs.readFile(path.join(__dirname, 'architecture-group-popup.js'), 'utf8'),
        fs.readFile(path.join(__dirname, 'architecture-book-client.js'), 'utf8')
    ]);
    const opened = print ? ' open' : '';
    const review = book.pages.flatMap(page => page.checks.filter(item => !stubOutput(page, item)));
    const stubCount = book.pages.reduce((total, page) => total + page.checks.filter(item => stubOutput(page, item)).length, 0);
    const interfaceCount = book.pages.reduce((total, page) => total + page.links.filter(link => link.kind === 'interface').length, 0);
    const chapterHtml = new Map();
    const children = new Map();
    for (const page of book.pages) {
        const parent = byId.has(page.parent) ? page.parent : null;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(page);
    }
    const previews = [];
    for (const [index, page] of book.pages.entries()) {
        const mode = ['overview', 'detailed'].includes(modes?.[page.id]) ? modes[page.id] : page.auto;
        const layout = await layoutDiagram(page, mode);
        const diagram = renderDiagram(layout, page, false, { groupActions: !print });
        if (!print) for (const [id, group] of Object.entries(await renderGroupDiagrams(layout, page, false))) {
            previews.push(`<template id="group-${page.id}-${id}" data-title="${escape(group.title)}" data-instances="${group.instances}" data-connections="${group.connections}">${group.html}</template>`);
        }
        const diagramDescription = mode === 'detailed' ? '完整连线，落到具体引脚'
            : layout.wrapped ? '简图：分行展示，沿箭头追踪跨行接口' : '简图：功能分组，边界端口独立成列';
        const nodes = new Map(page.nodes.map(node => [node.id, node]));
        if (!print) for (const link of page.links) {
            previews.push(`<template id="preview-${link.id}">${connectionPreview(link)}</template>`);
            for (const endpoint of link.endpoints) {
                const id = `${link.id}:${endpoint.node}:${endpoint.port}`;
                previews.push(`<template id="preview-${escape(id)}">${connectionPreview(link, { node: endpoint.node, port: endpoint.port })}</template>`);
            }
        }
        const instances = page.nodes.filter(node => node.kind === 'instance');
        const instanceTable = instances.length ? `<div class="table-scroll"><table><thead><tr><th scope="col">实例</th><th scope="col">模块</th><th scope="col">源码</th></tr></thead><tbody>${instances.map(node =>
            `<tr><th scope="row">${code(node.name)}</th><td>${node.chapter ? `<a href="#${node.chapter}">${escape(pageName(byId.get(node.chapter)))}</a>` : `${code(node.type)} · 未解析`}${node.implementation === 'stub' ? ' · 实现桩' : ''}</td><td>${sourceLink(node.source, false)}</td></tr>`).join('')}</tbody></table></div>` : '';
        const interfaces = page.links.filter(link => link.kind === 'interface');
        const targets = new Map(interfaces.flatMap(link => link.endpoints.filter(endpoint => endpoint.boundary).map(endpoint => [endpoint.port, link.id])));
        const signals = page.links.filter(link => link.kind === 'signal' && (mode === 'detailed' || !link.labeled));
        const signalTable = signals.length ? `<div class="table-scroll"><table><thead><tr><th scope="col">信号</th><th scope="col">端点</th><th scope="col">位宽</th></tr></thead><tbody>${signals.map(link =>
            `<tr id="${link.id}"><th scope="row">${code(link.name)}</th><td>${signalEnds(link, nodes)}</td><td>${link.width ?? '—'}</td></tr>`).join('')}</tbody></table></div>` : '';
        const diagnostics = page.checks.filter(item => !stubOutput(page, item));
        const stubs = page.checks.filter(item => stubOutput(page, item));
        const root = index === 0;
        const checksId = page.id + '-checks';
        const checksTitle = `待复核 · ${diagnostics.length}`;
        const checkList = diagnostics.length ? `<ul>${diagnosticItems(diagnostics)}</ul>` : '';
        const checks = checkList && (print
            ? `<aside class="book-review" id="${checksId}"><h3>${checksTitle}</h3>${checkList}</aside>`
            : `<details class="book-detail book-review" id="${checksId}" data-print-open><summary>${checksTitle}</summary>${checkList}</details>`);
        const clocks = clockNetworks(page, nodes, print);
        const figure = page.hasStructure
            ? `<figure class="diagram-figure">
                <div class="diagram-toolbar book-diagram-tools">${print ? '' : `${clocks ? `<a href="#${page.id}-clocks">时钟与复位</a>` : ''}<button type="button" data-zoom aria-pressed="false">原始尺寸</button>`}</div>
                <div class="diagram-print" tabindex="0" aria-label="架构图">${diagram}</div>
                <figcaption class="diagram-caption">图 ${pad(index + 1)} · 结构连线（${diagramDescription}）</figcaption>
            </figure>`
            : '';
        const symbol = page.ports.length ? section('模块端口图', renderModuleSymbol(pageName(page), page.ports, { targets }), page.ports.length + ' 个端口') : '';
        const interfaceEntries = interfaces.map(link => `<details class="interface-section book-detail" data-print-open id="${link.id}"${opened}><summary><strong>${escape(link.name)}</strong> <span>${escape(link.type)} · ${link.members.length} 个成员</span></summary><div class="interface-body">${interfaceDetails(link, nodes, false, { chapterLinks: !print })}</div></details>`).join('');
        const interfaceSection = interfaces.length ? `<details class="book-detail chapter-reference" data-interfaces data-print-open${opened}>
            <summary>接口 · ${interfaces.length}</summary>
            ${print ? '' : '<label class="book-search">筛选接口<input type="search" data-interface-filter placeholder="接口名或类型"></label><p data-no-interfaces hidden role="status">没有匹配的接口</p>'}
            ${interfaceEntries}</details>` : '';
        const counts = [page.ports.length ? page.ports.length + ' 个端口' : '', instances.length ? instances.length + ' 个子模块' : '', interfaces.length ? interfaces.length + ' 个接口' : '']
            .filter(Boolean).join(' · ');
        const heading = 'h' + Math.min(6, (page.depth || 0) + 2);
        const parent = byId.get(page.parent);
        chapterHtml.set(page.id, `<section class="chapter" id="${page.id}">
            <div class="chapter-lead">
                <header class="chapter-header${root ? ' chapter-header-root' : ''}">
                    <div class="chapter-crumbs"><span class="chapter-index">${chapterNumber(page, index)}</span><span class="chapter-nav"><a href="#contents">目录</a>${parent ? ` · <a href="#${parent.id}">返回 ${escape(parent.name)}</a>` : ''}</span></div>
                    ${root && !print ? '' : `<${heading} class="chapter-heading">${escape(page.title || pageName(page))}</${heading}>`}
                    ${page.title && (!root || print) ? `<p class="chapter-title">${code(pageName(page))}</p>` : ''}
                    <p class="chapter-meta">${sourceLink(page.source, false)}${page.empty ? ' · 实现桩' : ''}${counts ? ' · ' + counts : ''}${checkList && !print ? ` · <a class="review-count" href="#${checksId}">${checksTitle}</a>` : ''}</p>
                </header>
                ${print ? checks : ''}
                ${print ? '' : walkthrough(page, false)}
                ${figure || symbol || '<p class="subtle">没有已解析的端口或子实例。</p>'}
            </div>
            ${print ? walkthrough(page, true) : ''}
            ${section('子模块', instanceTable, instances.length)}
            ${interfaceSection}
            ${page.ports.length ? `<details class="book-detail chapter-reference" data-print-open${opened}><summary>模块边界 · ${page.ports.length} 个端口</summary>${figure ? symbol : ''}${portTable(page.ports, false)}</details>` : ''}
            ${clocks}
            ${signals.length ? `<details class="book-detail chapter-reference" data-print-open${opened}><summary>普通信号 · ${signals.length}</summary>${signalTable}</details>` : ''}
            ${print ? '' : checks}
            ${stubs.length ? `<details class="book-detail book-stubs" data-print-open${opened}><summary>实现桩待实现输出 · ${stubs.length}</summary><ul>${diagnosticItems(stubs)}</ul></details>` : ''}
            <!--chapter-children-->
        </section>`);
    }
    const summary = [
        [book.pages.length, '模块章节'], [interfaceCount, '接口条目'],
        [book.diagnostics.length + review.length, '条待复核'], [stubCount, '个实现桩输出'], [book.issues.length, '条解析限制']
    ];
    const highlights = book.pages.filter(page => page.checks.some(item => !stubOutput(page, item)));
    const overview = highlights.length || book.diagnostics.length || book.issues.length
        ? `<details class="book-detail book-review book-review-index" id="review-index" data-print-open${opened}><summary>复核索引</summary>
            <ul>${diagnosticItems([...book.diagnostics, ...book.issues])}${highlights.map(page => `<li><a href="#${page.id}-checks">${escape(pageName(page))}</a> · ${page.checks.filter(item => !stubOutput(page, item)).length} 条待复核</li>`).join('')}</ul></details>` : '';
    const title = book.pages[0].title || book.top;
    function chapterContent(page) {
        const descendants = (children.get(page.id) || []).map(chapterContent).join('');
        return chapterHtml.get(page.id).replace('<!--chapter-children-->', descendants ? `<div class="chapter-children">${descendants}</div>` : '');
    }
    function chapterNav(page) {
        const descendants = (children.get(page.id) || []).map(chapterNav).join('');
        const toggle = descendants && !print ? `<button class="toc-toggle" type="button" aria-label="${escape(page.name)} 子章节" aria-expanded="${!page.parent}" aria-controls="toc-${page.id}"></button>` : '';
        return `<li><div class="toc-row">${toggle}<a href="#${page.id}"><span class="toc-index">${chapterNumber(page, book.pages.indexOf(page))}</span><span class="toc-title">${escape(page.title || pageName(page))}</span>${page.title ? `<span class="toc-module">${code(pageName(page))}</span>` : ''}</a></div>${descendants ? `<ol id="toc-${page.id}">${descendants}</ol>` : ''}</li>`;
    }
    const roots = children.get(null) || [];
    const nav = roots.map(chapterNav).join('');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escape(title)} · 架构设计</title><style>${sharedCss}\n${diagramCss}\n${symbolCss}\n${bookCss}</style></head>
        <body class="architecture-book${print ? '' : ' reading-book'}"><header class="book-header" id="contents">
        <p class="book-eyebrow">架构设计 · Architecture</p>
        <h1>${escape(title)}</h1>
        <p class="book-meta"><span>${code(book.top)}</span><span>结构快照 ${escape(book.revision.slice(0, 12))}</span><span>源级投影</span></p>
        <ul class="book-summary" aria-label="报告概况">${summary.filter(([count]) => print || count).map(([count, label]) => `<li><strong>${count}</strong><span>${label}</span></li>`).join('')}${!print && overview ? '<li><a href="#review-index">复核索引</a></li>' : ''}</ul>
        ${print ? '<p class="book-note">方向来自伪 SystemVerilog 端口和 modport 声明。功能、时序与握手行为需结合验证结果。</p>' + overview : ''}</header>
        <div class="book-layout"><nav class="book-nav" aria-label="章节目录"><h2>模块章节</h2>
        ${print ? '' : '<label class="book-search">筛选章节<input type="search" id="chapter-filter" placeholder="模块名或职责"></label><p id="no-chapters" hidden role="status">没有匹配的章节</p>'}
        <ol>${nav}</ol></nav>
        <main class="book-content">${roots.map(chapterContent).join('')}${print ? '' : overview}</main></div>
        ${print ? '' : `<aside class="connection-panel" aria-labelledby="connection-panel-title" hidden>
            <header><h2 id="connection-panel-title" tabindex="-1"></h2><button type="button" data-close-connection aria-label="关闭接口详情">关闭</button></header>
            <div class="connection-panel-body"></div></aside>${previews.join('')}<script>${hoverScript}</script><script>${groupScript}</script><script>${script}</script>`}</body></html>`;
}

async function exportArchitecture(loaded, format, { out, browser, modes } = {}) {
    if (format !== 'html' && format !== 'pdf') throw new Error('架构导出格式必须为 HTML 或 PDF。');
    await assertBookCurrent(loaded);
    const html = await renderArchitectureBook(loaded.book, modes, { print: format === 'pdf' });
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

async function exportFromCli(input) {
    const format = input.imageFormat ?? 'html';
    if (!input.workspace || !input.top) fail('INVALID_ARGUMENT', 'design export 需要伪 SystemVerilog 的 --workspace 和 --top');
    if (!['html', 'pdf'].includes(format)) fail('INVALID_ARGUMENT', 'design export 的 --format 需要 html 或 pdf');
    if (input.out !== undefined && path.extname(input.out).toLowerCase() !== '.' + format) {
        fail('INVALID_ARGUMENT', 'design export 的 --out 必须是扩展名为 .' + format + ' 的文件路径');
    }
    if (input.engine !== undefined && input.engine !== 'struct') fail('INVALID_ARGUMENT', 'design export 使用 struct 结构前端');

    const snapshot = await resolveContext(input, { requireVirtualWorkspace: true });
    const loaded = await buildArchitectureBook(snapshot);
    const file = await exportArchitecture(loaded, format, { out: input.out, browser: input.browser });
    const content = await fs.readFile(file);
    const artifact = { kind: 'document', format, path: file, sha256: hash(content), bytes: content.length };
    const { book } = loaded;
    const diagnostics = [...book.diagnostics, ...book.pages.flatMap(page => page.checks.map(check => ({ ...check, chapter: page.id })))];
    return result('design.export', {
        top: book.top, revision: book.revision, chapterCount: book.pages.length,
        interfaceCount: book.pages.reduce((count, page) => count + page.links.filter(link => link.kind === 'interface').length, 0),
        sourceFiles: snapshot.context.files.map(({ path: file, sha256 }) => ({ path: path.relative(snapshot.context.workspace, file).split(path.sep).join('/'), sha256 })),
        limitations: book.issues, ...artifact
    }, snapshot.context, diagnostics, [artifact]);
}

module.exports = { exportArchitecture, renderArchitectureBook, exportFromCli };
