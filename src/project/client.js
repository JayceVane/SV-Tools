/* global acquireVsCodeApi, SVToolsProjectIcons */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), saved = vscode.getState() || {}, tree = document.getElementById('tree'), menu = document.getElementById('menu');
    let snapshot = { nodes: [], revision: 0 }, state = saved, focusId, menuAnchor;
    const send = (action, extra = {}) => vscode.postMessage({ action, revision: snapshot.revision, ...extra });
    const currentState = () => state[snapshot.project?.id] || (state[snapshot.project?.id] = { expanded: (snapshot.nodes || []).map(node => node.id), projection: 'files' });
    const remember = () => vscode.setState(state);
    const text = (id, value) => {
        document.getElementById(id).textContent = value || '';
    };
    const icon = name => SVToolsProjectIcons.icon(document, name);
    for (const element of document.querySelectorAll('[data-icon]')) {
        element.append(icon(element.dataset.icon));
    }
    function renderTools(local) {
        const isVivado = snapshot.project?.kind === 'vivado';
        document.getElementById('add').hidden = isVivado;
        document.getElementById('vivadoTools').hidden = !isVivado;
        document.getElementById('tools').hidden = !isVivado;
        const expanded = local.toolsExpanded !== false;
        document.getElementById('toggleTools').setAttribute('aria-expanded', String(expanded));
        document.getElementById('toolBody').hidden = !expanded;
        const actions = document.getElementById('toolActions');
        actions.replaceChildren();
        if (!isVivado) return;
        for (const action of snapshot.toolActions || []) {
            if (action.group !== 'build') continue;
            const button = document.createElement('button'), label = document.createElement('span');
            button.type = 'button';
            button.dataset.command = action.id;
            label.textContent = action.label;
            button.append(icon(action.icon), label);
            button.addEventListener('click', () => send('command', { command: action.id }));
            actions.append(button);
        }
    }
    function render() {
        const focusedId = document.activeElement?.dataset?.nodeId;
        const project = snapshot.project, local = currentState();
        tree.replaceChildren();
        if (snapshot.tracing && local.traceId !== snapshot.traceId) {
            function reveal(nodes) {
                let related = false;
                for (const node of nodes) {
                    const child = reveal(node.children);
                    if (child || node.flags.length) {
                        related = true;
                        if (node.children.length && !local.expanded.includes(node.id)) {
                            local.expanded.push(node.id);
                        }
                    }
                }
                return related;
            }
            reveal(snapshot.nodes || []);
            local.traceId = snapshot.traceId;
            remember();
        }
        text('projectName', project?.name || '选择或创建工程');
        text('projectKind', project?.kind === 'vivado' ? 'Vivado' : project ? 'SV Tools' : '');
        document.getElementById('trace').hidden = !snapshot.tracing;
        text('traceRoot', snapshot.traceRoot || '追踪编辑器所选信号');
        document.getElementById('traceRoot').title = snapshot.traceRoot || '';
        document.getElementById('pin').setAttribute('aria-pressed', String(!!snapshot.pinned));
        text('pin', snapshot.pinned ? '已固定' : '固定');
        text('message', snapshot.message);
        text('issues', (snapshot.issues || []).join('\n'));
        document.getElementById('diagnostics').hidden = !local.diagnostics || !snapshot.issues?.length;
        renderTools(local);
        for (const mode of ['files', 'instances'])
            document.getElementById(mode).setAttribute('aria-pressed', String(snapshot.projection === mode));
        let count = 0;
        function append(nodes, depth) {
            for (const node of nodes) {
                if (++count > 1500) {
                    const note = document.createElement('div');
                    note.className = 'empty';
                    note.textContent = '可见节点达到1500项，请收起部分目录';
                    tree.append(note);
                    return;
                }
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'row';
                row.dataset.nodeId = node.id;
                row.dataset.kind = node.kind;
                row.setAttribute('role', 'treeitem');
                row.setAttribute('aria-level', String(depth + 1));
                row.setAttribute('aria-selected', String(focusId === node.id));
                const expanded = local.expanded.includes(node.id), chevron = document.createElement('span');
                chevron.className = 'chevron';
                if (node.children.length) chevron.append(icon('chevron'));
                const padding = document.createElement('span');
                padding.className = 'indent';
                padding.style.width = Math.min(depth, 32) * 14 + 'px';
                const symbol = document.createElement('span');
                symbol.className = 'symbol';
                symbol.append(icon(node.kind === 'set' ? 'fileset' : node.kind === 'folder' ? (expanded ? 'folderOpen' : 'folder') : node.kind === 'instance' ? 'instance' : /\.xdc$/i.test(node.file || '') ? 'constraint' : 'file'));
                const label = document.createElement('span');
                label.className = 'label';
                label.textContent = node.label;
                const flags = document.createElement('span');
                flags.className = 'flags';
                for (const flag of node.flags) {
                    const item = document.createElement('span');
                    item.className = 'flag';
                    item.append(icon(flag.role));
                    item.setAttribute('aria-label', ({ internal: '内部声明', input: '输入', output: '输出', inout: '双向', unknown: '未知' })[flag.role]);
                    item.title = item.getAttribute('aria-label');
                    flags.append(item);
                }
                row.title = [node.file, node.tooltip].filter(Boolean).join('\n');
                row.append(padding, chevron, symbol, label, flags);
                if (node.children.length) {
                    row.setAttribute('aria-expanded', String(expanded));
                }
                row.addEventListener('click', event => {
                    focusId = node.id;
                    if (node.children.length && (node.kind === 'folder' || node.kind === 'set' || !node.file || chevron.contains(event.target))) {
                        local.expanded = expanded ? local.expanded.filter(id => id !== node.id) : [...local.expanded, node.id];
                        remember();
                        render();
                    }
                    else {
                        send('open', { nodeId: node.id });
                        render();
                    }
                });
                row.addEventListener('contextmenu', event => {
                    event.preventDefault();
                    showMenu(node, undefined, row);
                });
                row.addEventListener('keydown', event => {
                    if (event.key === 'ArrowRight' && node.children.length && !expanded) {
                        local.expanded.push(node.id);
                        remember();
                        render();
                    }
                    if (event.key === 'ArrowLeft' && expanded) {
                        local.expanded = local.expanded.filter(id => id !== node.id);
                        remember();
                        render();
                    }
                });
                tree.append(row);
                if (expanded) {
                    append(node.children, depth + 1);
                }
                if (count > 1500) {
                    return;
                }
            }
        }
        append(snapshot.nodes || [], 0);
        if (focusedId && tree.querySelectorAll) {
            for (const row of tree.querySelectorAll('.row')) if (row.dataset.nodeId === focusedId) {row.focus();break;}
        }
        if (!project) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '创建 SV Tools 工程，或打开已有 Vivado 工程。\n文件和文件夹可从资源管理器右键加入。';
            tree.append(empty);
        }
    }
    function showMenu(node, commandList, anchor = document.getElementById('actions')) {
        menuAnchor = anchor;
        menu.replaceChildren();
        const commands = commandList || (node ? node.actions : [...(snapshot.actions || []), ...(snapshot.issues?.length ? [{ id: 'diagnostics', label: currentState().diagnostics ? '收起分析提示' : '查看分析提示' }] : [])]);
        for (const action of commands || []) {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            button.textContent = action.label;
            button.addEventListener('click', () => {
                menu.hidden = true;
                if (action.id === 'diagnostics') {
                    currentState().diagnostics = !currentState().diagnostics;
                    document.getElementById('diagnostics').open = true;
                    remember();
                    render();
                    return;
                }
                send('command', { command: action.id, nodeId: node?.id });
            });
            menu.append(button);
        }
        menu.hidden = !menu.childElementCount;
        if (!menu.hidden && menu.getBoundingClientRect) {
            const bounds = menu.getBoundingClientRect(), origin = anchor.getBoundingClientRect();
            const top = origin.bottom + 4 + bounds.height <= window.innerHeight - 8 ? origin.bottom + 4 : origin.top - bounds.height - 4;
            menu.style.left = Math.max(8, Math.min(origin.left, window.innerWidth - bounds.width - 8)) + 'px';
            menu.style.top = Math.max(8, top) + 'px';
            menu.children[0]?.focus();
        }
    }
    for (const id of ['choose', 'add', 'refresh', 'pin', 'clear'])
        document.getElementById(id).addEventListener('click', () => send(id));
    document.getElementById('actions').addEventListener('click', () => showMenu());
    document.getElementById('addVivado').addEventListener('click', () => send('add'));
    document.getElementById('toggleTools').addEventListener('click', () => {
        currentState().toolsExpanded = currentState().toolsExpanded === false;
        remember();
        render();
    });
    document.getElementById('vivadoTools').addEventListener('click', () => {
        currentState().toolsExpanded = true;
        remember();
        render();
    });
    document.getElementById('toolReports').addEventListener('click', () => showMenu(null, (snapshot.toolActions || []).filter(action => action.group === 'reports'), document.getElementById('toolReports')));
    for (const projection of ['files', 'instances'])
        document.getElementById(projection).addEventListener('click', () => {
            currentState().projection = projection;
            remember();
            send('projection', { projection });
        });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            menu.hidden = true;
            menuAnchor?.focus?.();
        }
    });
    document.addEventListener('pointerdown', event => {
        if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
    });
    menu.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = [...menu.children], current = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
    });
    window.addEventListener('message', event => {
        if (event.data?.type === 'expansion') {
            const local = currentState(), expanded = [];
            function collect(nodes) { for (const node of nodes) { if (node.children.length && expanded.length < 1500) {expanded.push(node.id); collect(node.children);} } }
            if (event.data.expand) collect(snapshot.nodes || []);
            local.expanded = expanded; remember(); render(); return;
        }
        if (event.data?.type !== 'snapshot') {
            return;
        }
        snapshot = event.data;
        menu.hidden = true;
        render();
    });
    send('ready', { state });
})();
