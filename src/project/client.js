/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), saved = vscode.getState() || {}, tree = document.getElementById('tree'), menu = document.getElementById('menu');
    let snapshot = { nodes: [], revision: 0 }, state = saved, focusId;
    const send = (action, extra = {}) => vscode.postMessage({ action, revision: snapshot.revision, ...extra });
    const currentState = () => state[snapshot.project?.id] || (state[snapshot.project?.id] = { expanded: (snapshot.nodes || []).map(node => node.id), projection: 'files' });
    const remember = () => vscode.setState(state);
    const text = (id, value) => {
        document.getElementById(id).textContent = value || '';
    };
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
        document.getElementById('pin').setAttribute('aria-pressed', String(!!snapshot.pinned));
        text('pin', snapshot.pinned ? '已固定' : '固定');
        text('message', snapshot.message);
        text('issues', (snapshot.issues || []).join('\n'));
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
                row.setAttribute('role', 'treeitem');
                row.setAttribute('aria-level', String(depth + 1));
                row.setAttribute('aria-selected', String(focusId === node.id));
                const expanded = local.expanded.includes(node.id), chevron = document.createElement('span');
                chevron.className = 'chevron';
                chevron.textContent = node.children.length ? (expanded ? '⌄' : '›') : '';
                const padding = document.createElement('span');
                padding.textContent = '\u00a0'.repeat(Math.min(depth, 32) * 2);
                const icon = document.createElement('span');
                icon.className = 'symbol';
                icon.textContent = node.kind === 'folder' || node.kind === 'set' ? '▱' : node.kind === 'instance' ? '◇' : '▤';
                const label = document.createElement('span');
                label.className = 'label';
                label.textContent = node.label;
                const flags = document.createElement('span');
                flags.className = 'flags';
                for (const flag of node.flags) {
                    const item = document.createElement('span');
                    item.textContent = flag.symbol;
                    item.setAttribute('aria-label', ({ internal: '内部声明', input: '输入', output: '输出', inout: '双向', unknown: '未知' })[flag.role]);
                    flags.append(item);
                }
                row.title = [node.file, node.tooltip].filter(Boolean).join('\n');
                row.append(padding, chevron, icon, label, flags);
                if (node.children.length) {
                    row.setAttribute('aria-expanded', String(expanded));
                }
                row.addEventListener('click', event => {
                    focusId = node.id;
                    if (node.children.length && (!node.file || event.target === chevron)) {
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
                    showMenu(node);
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
    function showMenu(node) {
        menu.replaceChildren();
        const commands = node ? node.actions : snapshot.actions;
        for (const action of commands || []) {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            button.textContent = action.label;
            button.addEventListener('click', () => {
                menu.hidden = true;
                send('command', { command: action.id, nodeId: node?.id });
            });
            menu.append(button);
        }
        menu.hidden = !menu.childElementCount;
    }
    for (const id of ['choose', 'add', 'refresh', 'pin', 'clear'])
        document.getElementById(id).addEventListener('click', () => send(id));
    document.getElementById('actions').addEventListener('click', () => showMenu());
    for (const projection of ['files', 'instances'])
        document.getElementById(projection).addEventListener('click', () => {
            currentState().projection = projection;
            remember();
            send('projection', { projection });
        });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            menu.hidden = true;
        }
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
