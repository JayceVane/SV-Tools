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
    const parameterValue = (parameter, edits) => edits.get(parameter.key) ?? parameter.value;
    const available = (parameter, values) => parameter && !parameter.readOnly &&
        !parameter.dependency?.some(([key, allowed]) => !allowed.includes(values.get(key)));
    function updateButtons() {
        const edits = draft(), count = edits.size;
        const parameters = new Map((state.info?.parameters || []).map(parameter => [parameter.key, parameter]));
        const values = new Map([...parameters].map(([key, parameter]) => [key, parameterValue(parameter, edits)]));
        const blocked = [...edits.keys()].some(key => !available(parameters.get(key), values));
        text('ip-changes', count ? `${count} 项待应用${blocked ? ' · 有参数受当前选项限制' : ''}` : '');
        $('ip-apply').disabled = state.busy || state.loading || !count || blocked || state.info.locked || state.info.preview;
        $('ip-revert').disabled = state.busy || !count;
        for (const control of document.querySelectorAll('[data-command], [data-member]')) control.disabled = state.busy;
        for (const control of document.querySelectorAll('[data-ip-action]')) control.disabled = state.busy || state.loading;
        for (const field of document.querySelectorAll('[data-parameter]')) {
            const parameter = parameters.get(field.dataset.parameter);
            if (!parameter) continue;
            const editable = available(parameter, values);
            field.disabled = state.busy || state.loading || state.info.locked || state.info.preview || !editable;
            const note = field.parentElement.querySelector('.parameter-condition');
            note.hidden = editable;
            note.textContent = parameter.readOnly ? '只读参数' : '由 ' + (parameter.dependency || [])
                .map(([key]) => parameters.get(key)?.label || key.slice(7)).join('、') + ' 控制';
        }
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
        const value = parameterValue(parameter, edits);
        const caption = element('span', undefined, 'parameter-caption');
        const key = element(parameter.label ? 'span' : 'code', parameter.label || parameter.key.slice(7));
        key.title = parameter.key;
        caption.append(key);
        if (parameter.help) caption.append(element('small', parameter.help));
        const label = element('label', undefined, 'parameter');
        const controlArea = element('span', undefined, 'parameter-value');
        const optionLabels = new Map(parameter.optionLabels || []);
        const choices = parameter.choices.length ? parameter.choices : [...optionLabels.keys()];
        const options = [...new Set([parameter.value, ...choices])];
        const truth = item => /^(1|true)$/iu.test(item);
        const boolean = options.length === 2 && options.every(item => /^(0|1|true|false)$/iu.test(item)) && options.some(truth) && options.some(item => !truth(item));
        const toggle = boolean && (parameter.widget?.toLowerCase() === 'checkbox' || parameter.format === 'bool' || options.every(item => /^(true|false)$/iu.test(item)));
        let control;
        let readValue;
        if (toggle) {
            control = element('input');
            control.type = 'checkbox';
            control.checked = truth(value);
            readValue = () => options.find(option => truth(option) === control.checked);
        } else if (choices.length) {
            control = element('select');
            for (const item of options) {
                const option = element('option', optionLabels.get(item) || item || '(空)');
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
        const range = [parameter.min, parameter.max].some(value => value !== undefined) && element('small',
            `范围 ${parameter.min ?? '不限'} ～ ${parameter.max ?? '不限'}`);
        const condition = element('small', undefined, 'parameter-condition');
        condition.hidden = true;
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
        if (range) controlArea.append(range);
        controlArea.append(condition);
        label.append(caption, controlArea);
        mark();
        return label;
    }
    function renderParameters() {
        if (!state.info) return;
        const filter = $('parameter-search').value.trim().toLowerCase(), edits = draft();
        const sections = new Map();
        for (const param of state.info.parameters) {
            if (!`${param.key} ${param.label || ''} ${param.help || ''} ${param.group || ''} ${parameterValue(param, edits)}`.toLowerCase().includes(filter)) continue;
            const [page, ...path] = param.group?.split(' / ') || [];
            const fallback = groups.find(([id]) => id === groupOf(param.key));
            const id = page ? 'xgui:' + page : fallback[0];
            if (!sections.has(id)) sections.set(id, { title: page || fallback[1], rows: [] });
            sections.get(id).rows.push({ param, section: path.join(' / ') });
        }
        const visible = [...sections].map(([id, group]) => [id, group.title]);
        if (!visible.some(([id]) => id === activeGroup)) activeGroup = '';
        const tabs = visible.length < 2 ? [] : [['', '全部'], ...visible];
        $('parameter-groups').replaceChildren(...tabs.map(([id, title]) => {
            const control = button(title, () => { activeGroup = id; renderParameters(); });
            control.setAttribute('aria-pressed', String(id === activeGroup));
            return control;
        }));
        const panels = visible.filter(([id]) => !activeGroup || activeGroup === id).map(([id, title]) => {
            const section = element('section', undefined, 'parameter-group');
            section.append(element('h3', title));
            let previous;
            for (const row of sections.get(id).rows) {
                if (row.section && row.section !== previous) section.append(element('h4', row.section));
                section.append(parameterRow(row.param, edits));
                previous = row.section;
            }
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
            $('ip-locked').hidden = !info.locked && !info.preview;
            text('ip-locked', info.preview ? '已保存参数 · 预览' : '已锁定 · 只读');
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
