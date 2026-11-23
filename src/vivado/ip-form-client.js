/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), $ = id => document.getElementById(id);
    let state = { info: null, form: null, busy: true, status: '' }, draft = new Map(), activeGroup = '';
    let evaluateSeq = 0, evaluateTimer = null;
    // 表单只构建一次，之后的禁用/隐藏变化就地打补丁，避免重绘抢走输入焦点。
    const rowViews = new Map(), groupViews = new Map(), pageViews = new Map();
    let emptyNote = null;

    const hiddenSets = () => {
        const hidden = state.info?.hidden || {};
        return {
            pages: new Set((hidden.pages || []).map(item => String(item).toLowerCase())),
            groups: new Set((hidden.groups || []).map(item => String(item).toLowerCase())),
            params: new Set((hidden.params || []).map(item => String(item).toLowerCase()))
        };
    };
    // 修改后按草稿值回问 Vivado，刷新禁用与隐藏状态（防抖，只保留最后一次）。
    function scheduleEvaluate() {
        if (!state.info) return;
        clearTimeout(evaluateTimer);
        const seq = ++evaluateSeq;
        evaluateTimer = setTimeout(() => {
            const values = [...parameters()].map(([key, parameter]) => [key, draft.has(key) ? draft.get(key) : parameter.value]);
            vscode.postMessage({ action: 'evaluate', revision: state.revision, seq, values });
        }, 280);
    }

    const node = (tag, text, className) => {
        const item = document.createElement(tag);
        if (text !== undefined) item.textContent = text;
        if (className) item.className = className;
        return item;
    };
    const parameters = () => new Map((state.info?.parameters || []).map(parameter => [parameter.key, parameter]));
    const values = (fields = parameters()) => {
        const map = new Map();
        for (const [key, parameter] of fields) map.set(key, draft.has(key) ? draft.get(key) : parameter.value);
        return map;
    };
    const available = (parameter, current) => Boolean(parameter) && !parameter.readOnly && !parameter.disabled &&
        !parameter.dependency?.some(([key, allowed]) => !allowed.includes(current.get(key)));
    const editableFor = (parameter, current) => available(parameter, current) &&
        !state.info?.locked && !state.info?.preview && !state.busy;
    const noteFor = parameter => parameter.readOnly ? '只读参数'
        : parameter.dependency?.length ? '由 ' + parameter.dependency.map(([key]) => key.slice(7)).join('、') + ' 控制'
            : 'Vivado 按当前参数值禁用，应用后刷新';
    const matches = (parameter, current, query) => !query ||
        (parameter.key + ' ' + (parameter.label || '') + ' ' + (parameter.help || '') + ' ' + (current.get(parameter.key) ?? ''))
            .toLowerCase().includes(query);
    const editedValues = () => {
        const fields = parameters(), current = values(fields), result = [];
        for (const [key, value] of draft) {
            const parameter = fields.get(key);
            if (!parameter || value === parameter.value || !available(parameter, current)) continue;
            result.push({ key, value });
        }
        return result;
    };
    const isBoolean = parameter => {
        const options = [...new Set([parameter.value, ...(parameter.choices || [])])].filter(item => item !== '');
        return options.length === 2 && options.every(item => /^(0|1|true|false)$/iu.test(item));
    };
    const hasRange = parameter => parameter.format === 'long' &&
        (parameter.min !== undefined || parameter.max !== undefined);
    const widgetOf = parameter => {
        const widget = String(parameter.widget || '').toLowerCase();
        if (widget.includes('checkbox') || isBoolean(parameter)) return 'check';
        if ((parameter.choices || []).length) return 'combo';
        if (String(parameter.value || '').includes('\n')) return 'multiline';
        if (widget.includes('hex')) return 'hex';
        if (hasRange(parameter) || /^-?\d+$/u.test(String(parameter.value))) return 'number';
        return 'text';
    };

    function control(parameter, current) {
        const edited = draft.has(parameter.key);
        const value = edited ? draft.get(parameter.key) : parameter.value;
        const kind = widgetOf(parameter);
        const editable = available(parameter, current) && !state.info.locked && !state.info.preview && !state.busy;
        let field;
        const commit = next => {
            if (next === parameter.value) draft.delete(parameter.key);
            else draft.set(parameter.key, next);
            renderToolbar();
            applyVisibility();
            scheduleEvaluate();
        };
        if (kind === 'check') {
            field = node('input');
            field.type = 'checkbox';
            const truth = item => /^(1|true)$/iu.test(String(item));
            field.checked = truth(value);
            field.onchange = () => commit(field.checked ? (parameter.choices || []).find(truth) || '1'
                : (parameter.choices || []).find(item => !truth(item)) || '0');
        } else if (kind === 'combo') {
            field = node('select');
            const labels = new Map(parameter.optionLabels || []);
            for (const item of [...new Set([parameter.value, ...(parameter.choices || [])])]) {
                const option = node('option', labels.get(item) || item || '(空)');
                option.value = item;
                field.append(option);
            }
            field.value = value;
            field.onchange = () => commit(field.value);
        } else {
            const multiline = kind === 'multiline' || String(value || '').length > 60;
            field = node(multiline ? 'textarea' : 'input');
            if (!multiline) {
                field.type = kind === 'number' && hasRange(parameter) ? 'number' : 'text';
                if (kind === 'number' && hasRange(parameter)) {
                    if (parameter.min !== undefined && parameter.min !== '') field.min = parameter.min;
                    if (parameter.max !== undefined && parameter.max !== '') field.max = parameter.max;
                }
                if (kind === 'number' || kind === 'hex') field.inputMode = kind === 'hex' ? 'text' : 'decimal';
            }
            field.spellcheck = false;
            field.value = value ?? '';
            field.onchange = () => commit(field.value);
        }
        field.dataset.parameter = parameter.key;
        field.disabled = !editable;
        field.setAttribute('aria-label', parameter.label || parameter.key);
        return field;
    }

    function parameterRow(parameter, current, pagePath, groupPath) {
        const row = node('div', undefined, 'row');
        if (draft.has(parameter.key)) row.classList.add('edited');
        const caption = node('div', undefined, 'caption');
        const title = node('label', parameter.label || parameter.key.slice(7));
        title.title = parameter.key;
        title.htmlFor = 'field-' + parameter.key;
        caption.append(title);
        if (parameter.help) caption.append(node('small', parameter.help, 'help'));
        const controls = node('div', undefined, 'control');
        const field = control(parameter, current);
        field.id = 'field-' + parameter.key;
        const original = node('small', '原值 ' + (parameter.value || '(空)'), 'original');
        original.hidden = !draft.has(parameter.key);
        const note = node('small', undefined, 'condition');
        const editable = editableFor(parameter, current);
        note.hidden = editable;
        if (!editable) note.textContent = noteFor(parameter);
        controls.append(field, original, note);
        row.append(caption, controls);
        rowViews.set(parameter.key, { row, field, note, original, pagePath, groupPath });
        return row;
    }

    function renderTree() {
        const hidden = hiddenSets();
        const pages = (state.form?.pages || []).filter(page => !hidden.pages.has(String(page.path || page.title).toLowerCase()));
        const elements = pages.map(page => {
            const section = node('div', undefined, 'page');
            // 只有一组且与页面同名时不再重复标题。
            const shared = page.groups.every(group => group.title === page.title || group.title === '常规');
            if (!shared) section.append(node('h2', page.title));
            for (const group of page.groups.filter(item => !hidden.groups.has(String(item.path || '').toLowerCase()))) {
                const label = shared ? page.title : group.title;
                const item = node('button', label + ' (' + group.rows.length + ')', 'group-link');
                item.type = 'button';
                item.onclick = () => {
                    activeGroup = group.id;
                    document.getElementById('group-' + group.id)?.scrollIntoView({ block: 'start' });
                    renderTree();
                };
                item.setAttribute('aria-pressed', String(activeGroup === group.id));
                section.append(item);
            }
            return section;
        });
        $('pages').replaceChildren(...elements);
    }

    function renderForm() {
        rowViews.clear(); groupViews.clear(); pageViews.clear();
        const current = values();
        const sections = [];
        for (const page of state.form?.pages || []) {
            const pagePath = String(page.path || page.title).toLowerCase();
            const section = node('div', undefined, 'page-form');
            for (const group of page.groups) {
                const groupPath = String(group.path || '').toLowerCase();
                const fieldset = node('fieldset', undefined, 'group');
                fieldset.id = 'group-' + group.id;
                fieldset.append(node('legend', group.title));
                for (const note of group.notes) fieldset.append(node('p', note, 'note'));
                for (const parameter of group.rows) fieldset.append(parameterRow(parameter, current, pagePath, groupPath));
                groupViews.set(groupPath, { element: fieldset, pagePath });
                section.append(fieldset);
            }
            pageViews.set(pagePath, { element: section, page });
            sections.push(section);
        }
        emptyNote = node('p', '', 'empty');
        sections.push(emptyNote);
        $('form').replaceChildren(...sections);
        applyVisibility();
    }

    function renderToolbar() {
        const info = state.info, edits = editedValues();
        $('changed').textContent = edits.length ? edits.length + ' 项待应用' : '';
        $('apply').disabled = !edits.length || state.busy || !info || info.locked || info.preview;
        $('refresh').disabled = state.busy;
        $('revert').disabled = !draft.size || state.busy;
    }

    // 只改隐藏/禁用/提示，不动已经渲染的控件，输入焦点保持不变。
    function applyVisibility() {
        const fields = parameters(), current = values(fields), hidden = hiddenSets();
        const query = $('search').value.trim().toLowerCase();
        let visible = 0;
        for (const [path, view] of pageViews) view.element.hidden = hidden.pages.has(path);
        for (const [path, view] of groupViews) view.element.hidden = hidden.groups.has(path);
        for (const [key, view] of rowViews) {
            const parameter = fields.get(key);
            const pageHidden = hidden.pages.has(view.pagePath);
            const groupHidden = pageHidden || hidden.groups.has(view.groupPath);
            const hide = groupHidden || hidden.params.has(key.slice(7).toLowerCase()) ||
                !matches(parameter, current, query);
            view.row.hidden = hide;
            if (!hide) visible += 1;
            const editable = editableFor(parameter, current);
            view.field.disabled = !editable;
            view.note.hidden = editable;
            view.note.textContent = editable ? '' : noteFor(parameter);
            view.original.hidden = !draft.has(key);
            view.row.classList.toggle('edited', draft.has(key));
        }
        if (emptyNote) {
            emptyNote.hidden = visible > 0;
            emptyNote.textContent = query ? '没有匹配的参数。' : 'Vivado 没有为此 IP 返回可配置参数。';
        }
    }

    function render() {
        const info = state.info;
        document.body.setAttribute('aria-busy', String(state.busy));
        $('name').textContent = info?.name || 'IP 配置';
        // 名称是这段配置实际作用的 IP 实例；副标题保留类型信息。
        $('subtitle').textContent = [info?.name ? 'IP 配置' : '', info?.vlnv, info?.locked ? '已锁定 · 只读' : '',
            info?.preview ? '预览' : ''].filter(Boolean).join(' · ');
        $('status').textContent = state.status || (state.busy ? '正在处理…' : '');
        renderToolbar();
        if (info) { renderTree(); renderForm(); }
    }

    $('search').oninput = applyVisibility;
    $('revert').onclick = () => { draft.clear(); render(); scheduleEvaluate(); };
    $('refresh').onclick = () => vscode.postMessage({ action: 'refresh' });
    $('apply').onclick = () => {
        const edits = editedValues();
        if (!edits.length) return;
        vscode.postMessage({ action: 'apply', revision: state.revision, edits });
    };
    $('close').onclick = () => vscode.postMessage({ action: 'close' });
    window.addEventListener('message', ({ data }) => {
        if (data?.type === 'resetDraft') {
            draft.clear();
            clearTimeout(evaluateTimer);
            ++evaluateSeq;
            return;
        }
        if (data?.type === 'state') {
            if (data.seq && data.seq < evaluateSeq) return;
            const off = new Set((data.disabled || []).map(name => String(name).toLowerCase()));
            for (const parameter of state.info?.parameters || []) {
                const name = parameter.key.startsWith('CONFIG.') ? parameter.key.slice(7).toLowerCase() : '';
                parameter.disabled = off.has(name) ? true : undefined;
            }
            if (state.info) state.info.hidden = data.hidden || { pages: [], groups: [], params: [] };
            applyVisibility();
            renderTree();
            renderToolbar();
            return;
        }
        if (data?.type !== 'form') return;
        state = data;
        render();
    });
    vscode.postMessage({ action: 'ready' });
})();
