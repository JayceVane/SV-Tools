/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    // 参数编辑全部在定制对话框里完成；本面板只负责 IP 列表、状态和操作入口。
    let state = { members: [], busy: true };

    const text = (id, value) => { $(id).textContent = value ?? ''; };
    function element(tag, content, className) {
        const node = document.createElement(tag);
        if (content !== undefined) node.textContent = content;
        if (className) node.className = className;
        return node;
    }
    function button(label, action, attrs = {}) {
        const node = element('button', label);
        node.type = 'button';
        Object.assign(node.dataset, attrs);
        node.onclick = action;
        return node;
    }
    function send(action, payload = {}) {
        if (!state.busy) vscode.postMessage({ action, revision: state.revision, ...payload });
    }
    const target = () => ({ id: state.selected, version: state.info?.version });

    function updateButtons() {
        document.body.setAttribute('aria-busy', String(state.busy || state.loading));
        for (const control of document.querySelectorAll('[data-command], [data-member]')) control.disabled = state.busy;
        for (const control of document.querySelectorAll('[data-ip-action]')) {
            control.disabled = state.busy || state.loading || Boolean(state.info?.preview);
        }
    }

    function renderMembers() {
        const filter = $('ip-search').value.trim().toLowerCase();
        const members = state.members.filter(item =>
            `${item.label} ${item.description} ${item.detail}`.toLowerCase().includes(filter));
        const elements = members.map(item => {
            const row = button(undefined, () => send('select', { id: item.id }), { member: item.id });
            row.ondblclick = () => send('configure', { id: item.id });
            row.className = 'member';
            row.setAttribute('aria-current', item.id === state.selected ? 'true' : 'false');
            row.title = item.detail;
            row.append(element('span', item.label), element('small', item.description));
            return row;
        });
        if (!elements.length) {
            elements.push(element('p', filter ? '没有匹配的 IP。' : '工程中暂无已有 IP。', 'empty'));
        }
        $('ip-members').replaceChildren(...elements);
        text('ip-count', filter ? `${members.length}/${state.members.length}` : state.members.length);
    }

    function render() {
        text('ip-project', state.project);
        renderMembers();
        const { info } = state;
        $('ip-placeholder').hidden = Boolean(info);
        $('ip-detail').hidden = !info;
        if (info) {
            text('ip-name', info.name);
            text('ip-identity', info.vlnv);
            $('ip-locked').hidden = !info.locked && !info.preview;
            text('ip-locked', info.preview ? '已保存参数 · 预览' : '已锁定 · 只读');
            $('ip-upgrade').hidden = !info.upgrade;
            text('ip-upgrade', info.upgrade ? '可用升级 ' + info.upgrade : '');
            const configure = button('配置…', () => send('configure', target()), { ipAction: 'configure' });
            configure.title = '在独立对话框中按 Vivado 的分组配置参数';
            $('ip-operations').replaceChildren(configure, ...info.actions.map(action =>
                button(action.label, () => send(action.id, target()), { ipAction: action.id })));
        } else {
            text('ip-placeholder', state.selected ? '等待读取所选 IP 的信息。' : '可从 IP Catalog 创建 IP，或添加已有 IP 文件。');
        }
        text('ip-message', state.status);
        updateButtons();
    }

    for (const control of document.querySelectorAll('[data-command]')) {
        control.onclick = () => send(control.dataset.command);
    }
    $('ip-search').oninput = () => { renderMembers(); updateButtons(); };
    window.addEventListener('message', ({ data }) => {
        if (data.type === 'snapshot') {
            state = data;
            render();
        } else if (data.type === 'activity') {
            state.busy = data.busy;
            text('ip-message', data.status);
            updateButtons();
        }
    });
    vscode.postMessage({ action: 'ready' });
})();
