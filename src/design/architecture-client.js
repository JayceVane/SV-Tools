/* global acquireVsCodeApi, ArchitectureDetails, ArchitectureHover */
(function () {
    'use strict';

    const api = acquireVsCodeApi();
    const { escape, code, pageName, parameterText, sourceLink, portTable, renderModuleSymbol, portDescription,
        interfaceDetails, signalEnds, backgroundSignals, connectionPreview } = ArchitectureDetails;
    const $ = id => document.getElementById(id);
    const action = (field, id, label) => `<button class="text-action" type="button" data-${field}="${escape(id)}">${escape(label)}</button>`;
    const post = (type, fields = {}) => api.postMessage({ type, revision: book?.revision, ...fields });
    const status = value => { $('status').textContent = value; $('status').hidden = !value; };
    const graph = $('graph');
    const inspector = $('inspector');
    let book, page, mode, request = 0, layout, selected = null, selectedEdge = null, selectedPort = null;
    let reviewFocus;
    let chapters, nodes, links, exportBusy = false, ancestors = [], pendingFocus, fitPreference;
    const preview = ArchitectureHover.attach(document, target => {
        const link = links?.get(target.dataset.previewLink);
        return link ? connectionPreview(link, { node: target.dataset.previewNode, port: target.dataset.previewPort }) : '';
    });

    function site(label, module) { return sourceLink(module.source, true, label); }
    function exportButtons() {
        for (const id of ['export-html', 'export-pdf']) $(id).disabled = !book || exportBusy;
    }

    function diagnosticMarkup(page) {
        const all = [...page.checks, ...(page === book.pages[0] ? [...book.diagnostics, ...book.issues] : [])];
        if (!all.length) return '';
        return `<details class="page-diagnostics"><summary>静态诊断 <span>${all.length}</span></summary><ul>${all.map(item =>
            `<li>${escape(item.message || item)}${item.source?.path || item.source?.file ? ` <small>${escape(item.source.path || item.source.file)}:${item.source.line || 1}</small>` : ''}</li>`).join('')}</ul></details>`;
    }

    function chapterNavigation(parent = null) {
        return book.pages.filter(module => (module.parent || null) === parent).map(module => {
            const children = chapterNavigation(module.id);
            return `<button type="button" data-chapter="${module.id}"${module.id === page.id ? ' aria-current="page"' : ''}>${module.title ? `<span>${escape(module.title)}</span>` : ''}${code((module.number || String(book.pages.indexOf(module) + 1).padStart(2, '0')) + ' · ' + pageName(module))}</button>${children ? `<div class="chapter-nav-children">${children}</div>` : ''}`;
        }).join('');
    }

    function showChapter(id, path) {
        page = chapters.get(id);
        if (!page) return;
        preview.hide();
        if (!path) {
            path = [];
            for (let parent = chapters.get(page.parent); parent; parent = chapters.get(parent.parent)) path.unshift(parent.id);
        }
        // 章节按模块定义组织，递归实例会回到同一章节：截断到首次出现，路径中不保留重复章节。
        const at = path.indexOf(id);
        ancestors = (at < 0 ? path : path.slice(0, at)).filter((item, index, all) => all.indexOf(item) === index);
        mode = api.getState()?.modes?.[id] || page.auto;
        nodes = new Map(page.nodes.map(node => [node.id, node]));
        links = new Map(page.links.map(link => [link.id, link]));
        layout = undefined;
        selected = null;
        selectedEdge = null;
        selectedPort = null;
        reviewFocus = undefined;
        pendingFocus = undefined;
        $('graph-content').hidden = false;
        $('interface-view').hidden = true;
        $('breadcrumbs').innerHTML = [...ancestors.map(parent => action('chapter', parent, chapters.get(parent).name)),
            `<span aria-current="page">${escape(page.name)}</span>`].join('<span aria-hidden="true" class="separator">›</span>');
        $('chapters').innerHTML = `<h2>模块章节</h2>${chapterNavigation()}`;
        $('page-title').textContent = page.title || page.name;
        $('page-meta').innerHTML = [page.title ? code(pageName(page)) : parameterText(page.parameters) && code(parameterText(page.parameters)),
            page.empty && '实现桩', site('', page)].filter(Boolean).join(' · ');
        $('labels').innerHTML = backgroundSignals(page, true);
        $('page-checks').innerHTML = diagnosticMarkup(page);
        $('graph-tools').hidden = !page.hasStructure;
        inspector.classList.toggle('symbol-only', !page.hasStructure);
        $('graph-legend').hidden = true;
        updateInspector();
        graph.hidden = !page.hasStructure;
        if (page.hasStructure) draw();
        else graph.replaceChildren();
        api.setState({ ...api.getState(), revision: book.revision, page: id, ancestors });
    }

    function draw() {
        for (const id of ['overview', 'detailed']) $(id).setAttribute('aria-pressed', String(mode === id));
        graph.textContent = '正在布局…';
        graph.hidden = false;
        $('graph-legend').hidden = true;
        post('layout', { page: page.id, mode, request: ++request });
    }

    function linkList(items) {
        if (!items.length) return '';
        return `<ul class="link-list">${items.map(link => `<li>${action('link', link.id, link.name)}<small>${escape(link.kind === 'interface'
            ? `${link.type}${link.handshake ? ' · 双向握手' : ''}` : `${link.width ?? '—'} 位`)}</small></li>`).join('')}</ul>`;
    }

    function neighbors(id) {
        const upstream = new Set(), downstream = new Set(), shared = new Set();
        const tags = new Map();
        for (const link of page.links) {
            if (!link.endpoints.some(endpoint => endpoint.node === id)) continue;
            let before = false, after = false;
            for (const route of link.routes) {
                const from = link.endpoints[route.source].node, to = link.endpoints[route.target].node;
                if (from === id && to !== id) { downstream.add(to); after = true; }
                if (to === id && from !== id) { upstream.add(from); before = true; }
            }
            if (!before && !after) for (const endpoint of link.endpoints) if (endpoint.node !== id) shared.add(endpoint.node);
            tags.set(link.id, before && after ? 'both' : before ? 'upstream' : after ? 'downstream' : 'related');
        }
        return { upstream, downstream, shared, tags };
    }

    function applyHighlight() {
        if (!layout) return;
        const selection = selected ? neighbors(selected) : null;
        const reviewNodes = new Set(reviewFocus?.nodes), reviewLinks = new Set(reviewFocus?.links);
        for (const element of graph.querySelectorAll('[data-node]')) {
            const id = element.dataset.node;
            const state = id === selected ? 'selected' : selection?.upstream.has(id) && selection.downstream.has(id) ? 'both'
                : selection?.upstream.has(id) ? 'upstream' : selection?.downstream.has(id) ? 'downstream'
                : selection?.shared.has(id) ? 'related' : selection ? 'dimmed' : 'normal';
            element.dataset.state = reviewNodes.has(id) ? 'selected' : state;
            element.setAttribute('aria-pressed', String(id === selected));
        }
        const edges = new Map(layout.edges.map(edge => [edge.id, edge]));
        const cards = new Map(layout.cards.map(card => [card.id, card]));
        for (const element of graph.querySelectorAll('[data-edge]')) {
            const edge = edges.get(element.dataset.edge);
            const roles = new Set(edge.links.map(link => selection?.tags.get(link)).filter(Boolean));
            const includes = card => cards.get(card)?.nodes.includes(selected);
            const incident = includes(edge.from) || includes(edge.to) || cards.get(edge.from)?.link || cards.get(edge.to)?.link;
            element.dataset.state = selectedEdge === edge.id || edge.links.some(id => reviewLinks.has(id)) ? 'selected' : !selection ? 'normal' : !roles.size || !incident ? 'dimmed'
                : roles.has('both') || roles.has('upstream') && roles.has('downstream') ? 'both'
                : roles.has('upstream') ? 'upstream' : roles.has('downstream') ? 'downstream' : 'related';
        }
    }

    function setFit(fitted) {
        graph.classList.toggle('fitted', fitted);
        $('fit').setAttribute('aria-pressed', String(fitted));
    }

    function centerSelected() {
        if (graph.classList.contains('fitted')) return;
        const target = [...graph.querySelectorAll('[data-node]')].find(element => element.dataset.node === selected);
        if (!target) return;
        const viewport = graph.getBoundingClientRect(), bounds = target.getBoundingClientRect();
        if (bounds.left < viewport.left || bounds.right > viewport.right) {
            graph.scrollLeft += (bounds.left + bounds.right - viewport.left - viewport.right) / 2;
        }
    }

    function portConnections(port, node) {
        const owner = node?.id || `boundary:${port}`;
        return page.links.filter(link => link.endpoints.some(endpoint => endpoint.node === owner && endpoint.port === port));
    }

    function pinInspector(module) {
        const current = module.ports.find(port => port.name === selectedPort);
        const targets = new Map(module.ports.flatMap(port => {
            const attached = portConnections(port.name, module === page ? null : module);
            return attached.length === 1 ? [[port.name, attached[0].id]] : [];
        }));
        const symbol = renderModuleSymbol(pageName(module), module.ports, { interactive: true, selected: selectedPort, targets,
            owner: module === page ? undefined : module.id });
        const table = module.ports.length ? `<details class="port-details"><summary>端口明细表</summary>${portTable(module.ports, true)}</details>` : '';
        const details = current ? `<section><h4>${code(current.name)}</h4><p class="subtle">${escape(portDescription(current))} ${sourceLink(current.declaration, true, '端口声明')}</p>
            ${linkList(portConnections(current.name, module === page ? null : module)) || '<p class="subtle">当前快照无可定位的连接。</p>'}</section>` : '';
        return { symbol: symbol + table, details };
    }

    function updateInspector() {
        const connected = selected ? page.links.filter(link => link.endpoints.some(endpoint => endpoint.node === selected)) : [];
        const node = nodes.get(selected);
        if (node) {
            const relations = neighbors(node.id);
            const summary = [['上游', relations.upstream, 'forward'], ['下游', relations.downstream, 'reverse'], ['共享 / 待确认', relations.shared, '']]
                .filter(([, group]) => group.size).map(([title, group, className]) => `<div class="${className}"><strong>${title}</strong><div>${[...group].map(id => action('node', id, nodes.get(id)?.name || id)).join(' ')}</div></div>`).join('');
            const specialization = parameterText(node.parameters);
            const pins = pinInspector(node);
            const chapter = chapters.get(node.chapter);
            inspector.innerHTML = `<header class="page-header"><div><h3>${escape(node.name)}</h3><p class="subtle">${node.type ? code(node.type) : '模块边界'}${specialization ? ' · ' + code(specialization) : ''}${node.implementation === 'stub' ? ' · 实现桩' : node.implementation === 'unresolved' ? ' · 未解析' : ''} ${site('源码', node)}</p></div><div class="tools">${chapter ? action('child', chapter.id, chapter.hasStructure ? '展开内部结构' : '查看模块') : ''}${node.kind === 'instance' ? action('review-node', node.id, '查看相关讲解') : ''}<button type="button" data-clear="true">清除选中</button></div></header>
                ${summary ? `<div class="neighbors">${summary}</div>` : ''}<div class="inspector-grid"><section><h4>端口图</h4>${pins.symbol}</section>${pins.details || `<section><h4>连接</h4>${linkList(connected) || '<p class="subtle">当前结构没有已解析的连接。</p>'}</section>`}</div>`;
        } else if (selectedEdge) {
            const edge = layout?.edges.find(edge => edge.id === selectedEdge);
            inspector.innerHTML = `<header class="page-header"><h3>连线 · ${edge?.links.length || 0} 条连接</h3><button type="button" data-clear="true">清除选中</button></header>${linkList(edge?.links.map(id => links.get(id)) || [])}`;
        } else {
            const interfaces = page.links.filter(link => link.kind === 'interface');
            const instances = page.nodes.filter(node => node.kind === 'instance');
            const pins = pinInspector(page);
            inspector.innerHTML = `<div class="inspector-grid"><section><h3>模块端口图</h3>${pins.symbol}</section>${pins.details || `<section>${interfaces.length ? `<h3>接口</h3>${linkList(interfaces)}` : ''}
                ${instances.length ? `<h3>实例</h3><ul class="instance-list">${instances.map(node => `<li>${action('node', node.id, node.name)}</li>`).join('')}</ul>` : ''}</section>`}</div>`;
        }
        applyHighlight();
    }

    function showLink(id, origin) {
        const link = links.get(id);
        if (!link) return;
        preview.hide();
        pendingFocus = origin;
        $('graph-content').hidden = true;
        $('interface-view').hidden = false;
        $('back').textContent = page.hasStructure ? '返回架构图' : '返回端口图';
        $('connection-title').textContent = link.name;
        $('connection-body').innerHTML = link.kind === 'interface' ? interfaceDetails(link, nodes, true)
            : `<h3>端点</h3><p>${signalEnds(link, nodes)}</p><p class="subtle">位宽 ${link.width ?? '待确认'}${link.labeled ? ' · 标签网络' : ''}</p>`;
        $('connection-body').insertAdjacentHTML('beforeend', action('review-link', id, '查看相关讲解'));
        $('connection-title').focus();
    }

    function hideLink() {
        $('interface-view').hidden = true;
        $('graph-content').hidden = false;
        if (pendingFocus?.isConnected) pendingFocus.focus();
        else graph.focus();
        pendingFocus = undefined;
    }

    $('viewer').addEventListener('click', event => {
        const target = event.target.closest('[data-node],[data-edge],[data-link],[data-port],[data-child],[data-chapter],[data-source],[data-clear],[data-review-node],[data-review-link]');
        if (!target || !page) return;
        const data = target.dataset;
        if (data.reviewNode || data.reviewLink) post('review', { page: page.id, node: data.reviewNode, link: data.reviewLink });
        else if (data.source) post('source', { source: data.source });
        else if (data.link) showLink(data.link, target);
        else if (data.port !== undefined) {
            const owner = nodes.get(selected);
            const attached = portConnections(data.port, owner);
            if (attached.length === 1 && attached[0].kind === 'interface') showLink(attached[0].id, target);
            else {
                selectedPort = selectedPort === data.port ? null : data.port;
                updateInspector();
                [...inspector.querySelectorAll('[data-port]')].find(pin => pin.dataset.port === data.port)?.focus();
            }
        }
        else if (data.child) showChapter(data.child, [...ancestors, page.id]);
        else if (data.chapter) {
            const index = ancestors.indexOf(data.chapter);
            showChapter(data.chapter, index < 0 ? undefined : ancestors.slice(0, index));
        } else if (data.edge) {
            const edge = layout?.edges.find(edge => edge.id === data.edge);
            if (edge?.links.length === 1) showLink(edge.links[0], target);
            else { selected = null; selectedPort = null; selectedEdge = data.edge; updateInspector(); }
        } else if (data.node) {
            reviewFocus = undefined;
            selectedEdge = null;
            selectedPort = null;
            selected = selected === data.node ? null : data.node;
            updateInspector();
            if (!graph.contains(target) && selected) centerSelected();
        } else if (data.clear) {
            reviewFocus = undefined;
            selected = null;
            selectedEdge = null;
            selectedPort = null;
            updateInspector();
        }
    });
    graph.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key) || !event.target.matches('[role=button]')) return;
        event.preventDefault();
        event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    for (const id of ['overview', 'detailed']) $(id).onclick = () => {
        if (mode === id) return;
        mode = id;
        selectedEdge = null;
        const previous = api.getState();
        api.setState({ ...previous, modes: { ...previous?.modes, [page.id]: id } });
        updateInspector();
        draw();
    };
    $('fit').onclick = () => {
        fitPreference = !graph.classList.contains('fitted');
        setFit(fitPreference);
        centerSelected();
    };
    $('back').onclick = hideLink;
    $('refresh').onclick = () => post('refresh');
    $('export-html').onclick = () => post('export', { format: 'html', modes: api.getState()?.modes || {} });
    $('export-pdf').onclick = () => post('export', { format: 'pdf', modes: api.getState()?.modes || {} });
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'book') {
            book = message.book;
            chapters = new Map(book.pages.map(page => [page.id, page]));
            const previous = api.getState(), same = previous?.revision === book.revision;
            if (!same) api.setState({ revision: book.revision });
            $('snapshot').textContent = `${book.top} · 源级结构快照 ${book.revision.slice(0, 12)}`;
            $('viewer').hidden = false;
            exportButtons();
            status('');
            showChapter(same && chapters.has(previous.page) ? previous.page : book.pages[0].id, same ? previous.ancestors || [] : []);
        } else if (message.type === 'review-focus' && message.revision === book?.revision) {
            const focus = message.focus;
            if (focus && (page.id !== focus.page || !$('interface-view').hidden)) showChapter(focus.page, focus.ancestors);
            reviewFocus = focus;
            if (focus) {
                selected = null;
                selectedEdge = null;
                selectedPort = null;
                if (mode === 'overview' && focus.links.some(id => links.get(id)?.labeled)) {
                    mode = 'detailed';
                    draw();
                }
            }
            updateInspector();
        } else if (message.type === 'layout' && message.revision === book?.revision && message.request === request && message.page === page?.id) {
            layout = message;
            graph.innerHTML = message.html;
            graph.hidden = !message.html;
            $('graph-legend').hidden = !message.html;
            $('fit').disabled = !message.html;
            const width = graph.querySelector('svg')?.viewBox.baseVal.width;
            setFit(fitPreference ?? (!width || graph.clientWidth >= width * .77));
            applyHighlight();
            centerSelected();
        } else if (message.type === 'loading') {
            book = undefined;
            $('viewer').hidden = true;
            exportButtons();
            status('正在读取工程…');
        } else if (message.type === 'error' && (message.request === undefined || message.request === request)) {
            if (message.request !== undefined) { graph.hidden = true; $('graph-legend').hidden = true; }
            status(message.message);
        } else if (message.type === 'exporting') {
            exportBusy = message.busy;
            exportButtons();
            if (message.busy) status('正在导出架构章节…');
            else status('');
        }
    });
    post('ready');
})();
