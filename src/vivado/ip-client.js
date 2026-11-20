/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    let state = { members: [], busy: true }, activeGroup = '';
    const drafts = new Map();
    const groups = [
        ['interface', '接口与协议', /(?:^|_)(?:axi\w*|apb\w*|avalon\w*|interface|protocol|busif|handshake)(?:_|$)/u],
        ['clock', '时钟与复位', /(?:^|_)(?:clk\w*|clock\w*|freq\w*|rst\w*|reset\w*|mmcm|pll|phase\w*)(?:_|$)/u],
        ['storage', '数据与存储', /(?:^|_)(?:width\w*|depth\w*|data\w*|fifo\w*|memory\w*|ram\w*|addr\w*|read\w*|write\w*)(?:_|$)/u],
        ['timing', '时序与资源', /(?:^|_)(?:latency\w*|pipeline\w*|register\w*|timing|optimization|area|throughput)(?:_|$)/u],
        ['general', '常规']
    ];
    const groupOf = key => groups.find(([, , match]) => match?.test(key.slice(7).toLowerCase()))?.[0] || 'general';
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
    function draft() {
        const found = drafts.get(state.selected);
        if (found && found.version === state.info?.version) return found.edits;
        const edits = new Map();
        if (state.info) drafts.set(state.selected, { version: state.info.version, edits });
        return edits;
    }
    function updateButtons() {
        const count = state.info ? draft().size : 0;
        text('ip-changes', count ? `${count} 项待应用` : '');
        $('ip-apply').disabled = state.busy || !count || state.info.locked;
        $('ip-revert').disabled = state.busy || !count;
        for (const control of document.querySelectorAll('[data-command], [data-member], [data-ip-action]')) control.disabled = state.busy;
        for (const field of document.querySelectorAll('[data-parameter]')) field.disabled = state.busy || state.info?.locked;
        document.body.setAttribute('aria-busy', String(state.busy));
    }
    function renderMembers() {
        const filter = $('ip-search').value.trim().toLowerCase();
        const members = state.members.filter(item => `${item.label} ${item.description} ${item.detail}`.toLowerCase().includes(filter));
        const elements = members.map(item => {
            const row = button(undefined, () => send('select', { id: item.id }), { member: item.id });
            row.className = 'member';
            row.setAttribute('aria-current', item.id === state.selected ? 'true' : 'false');
            row.title = item.detail;
            const edits = drafts.get(item.id)?.edits.size;
            row.append(element('span', item.label), element('small', item.description + (edits ? ` · ${edits} 项待应用` : '')));
            return row;
        });
        if (!elements.length) elements.push(element('p', filter ? '没有匹配的 IP。' : '工程中暂无已有 IP。', 'empty'));
        $('ip-members').replaceChildren(...elements);
        text('ip-count', filter ? `${members.length}/${state.members.length}` : state.members.length);
    }
    function parameterRow(parameter, edits) {
        const value = edits.get(parameter.key) ?? parameter.value;
        const key = element('code', parameter.key.slice(7));
        key.title = parameter.key;
        const label = element('label', undefined, 'parameter');
        const controlArea = element('span', undefined, 'parameter-value');
        const options = [...new Set([parameter.value, ...parameter.choices])];
        const toggle = options.length === 2 && options.some(item => /^true$/iu.test(item)) && options.some(item => /^false$/iu.test(item));
        let control;
        let readValue;
        if (toggle) {
            control = element('input');
            control.type = 'checkbox';
            control.checked = /^true$/iu.test(value);
            readValue = () => options.find(option => /^true$/iu.test(option) === control.checked);
        } else if (parameter.choices.length) {
            control = element('select');
            for (const item of options) {
                const option = element('option', item || '(空)');
                option.value = item;
                control.append(option);
            }
            control.value = value;
            readValue = () => control.value;
        } else {
            control = element(value.includes('\n') ? 'textarea' : 'input');
            control.spellcheck = false;
            if (/^-?\d+(?:\.\d+)?$/u.test(parameter.value)) control.inputMode = 'decimal';
            control.value = value;
            readValue = () => control.value;
        }
        control.dataset.parameter = parameter.key;
        const original = element('small');
        function mark() {
            const changed = edits.has(parameter.key);
            label.classList.toggle('edited', changed);
            original.hidden = !changed;
            original.textContent = changed ? '原值 ' + (parameter.value || '(空)') : '';
        }
        control.oninput = () => {
            const next = readValue();
            const wasEdited = edits.has(parameter.key);
            if (next === parameter.value) edits.delete(parameter.key);
            else edits.set(parameter.key, next);
            mark();
            if (wasEdited !== edits.has(parameter.key)) renderMembers();
            updateButtons();
        };
        controlArea.append(control, original);
        label.append(key, controlArea);
        mark();
        return label;
    }
    function renderParameters() {
        if (!state.info) return;
        const filter = $('parameter-search').value.trim().toLowerCase(), edits = draft();
        const sections = new Map(groups.map(([id]) => [id, []]));
        for (const param of state.info.parameters) {
            if (`${param.key} ${edits.get(param.key) ?? param.value}`.toLowerCase().includes(filter)) {
                sections.get(groupOf(param.key)).push(param);
            }
        }
        const visible = groups.filter(([id]) => sections.get(id).length);
        if (!visible.some(([id]) => id === activeGroup)) activeGroup = '';
        const tabs = visible.length < 2 ? [] : [['', '全部'], ...visible];
        $('parameter-groups').replaceChildren(...tabs.map(([id, title]) => {
            const control = button(title, () => { activeGroup = id; renderParameters(); });
            control.setAttribute('aria-pressed', String(id === activeGroup));
            return control;
        }));
        const panels = visible.filter(([id]) => !activeGroup || activeGroup === id).map(([id, title]) => {
            const section = element('section', undefined, 'parameter-group');
            section.append(element('h3', title), ...sections.get(id).map(parameter => parameterRow(parameter, edits)));
            return section;
        });
        if (!panels.length) panels.push(element('p', filter ? '没有匹配的参数。' : 'Vivado 没有为此 IP 返回可配置参数。', 'empty'));
        $('ip-parameters').replaceChildren(...panels);
        updateButtons();
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
            $('ip-locked').hidden = !info.locked;
            $('ip-upgrade').hidden = !info.upgrade;
            text('ip-upgrade', info.upgrade ? '可用升级 ' + info.upgrade : '');
            $('ip-operations').replaceChildren(...info.actions.map(action =>
                button(action.label, () => send(action.id, target()), { ipAction: action.id })));
            renderParameters();
        } else {
            text('ip-placeholder', state.selected ? '等待读取所选 IP 的参数。' : '可从 IP Catalog 创建 IP，或添加已有 IP 文件。');
        }
        text('ip-message', state.status);
        updateButtons();
    }
    for (const control of document.querySelectorAll('[data-command]')) control.onclick = () => send(control.dataset.command);
    $('ip-search').oninput = () => { renderMembers(); updateButtons(); };
    $('parameter-search').oninput = renderParameters;
    $('ip-revert').onclick = () => {
        draft().clear();
        renderMembers();
        renderParameters();
    };
    $('ip-apply').onclick = () => send('apply', { ...target(), edits: [...draft()].map(([key, value]) => ({ key, value })) });
    window.addEventListener('message', ({ data }) => {
        if (data.type === 'snapshot') {
            if (state.selected !== data.selected) { activeGroup = ''; $('parameter-search').value = ''; }
            state = data;
            const ids = new Set(data.members.map(item => item.id));
            for (const id of drafts.keys()) if (!ids.has(id)) drafts.delete(id);
            if (data.info && drafts.get(data.selected)?.version !== data.info.version) drafts.delete(data.selected);
            render();
        } else if (data.type === 'activity') {
            state.busy = data.busy;
            text('ip-message', data.status);
            updateButtons();
        }
    });
    vscode.postMessage({ action: 'ready' });
})();
