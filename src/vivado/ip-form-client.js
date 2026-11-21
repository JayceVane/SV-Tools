/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), $ = id => document.getElementById(id);
    let state = { info: null, form: null, busy: true, status: '' }, draft = new Map(), activeGroup = '';

    const node = (tag, text, className) => {
        const item = document.createElement(tag);
        if (text !== undefined) item.textContent = text;
        if (className) item.className = className;
        return item;
    };
    const parameters = () => new Map((state.info?.parameters || []).map(parameter => [parameter.key, parameter]));
    const values = () => {
        const map = new Map();
        for (const [key, parameter] of parameters()) map.set(key, draft.has(key) ? draft.get(key) : parameter.value);
        return map;
    };
    const available = (parameter, current) => Boolean(parameter) && !parameter.readOnly &&
        !parameter.dependency?.some(([key, allowed]) => !allowed.includes(current.get(key)));
    const editedValues = () => {
        const current = values(), result = [];
        for (const [key, value] of draft) {
            const parameter = parameters().get(key);
            if (!parameter || value === parameter.value || !available(parameter, current)) continue;
            result.push({ key, value });
        }
        return result;
    };
    const isBoolean = parameter => {
        const options = [...new Set([parameter.value, ...(parameter.choices || [])])].filter(item => item !== '');
        return options.length === 2 && options.every(item => /^(0|1|true|false)$/iu.test(item));
    };
    const widgetOf = parameter => {
        const widget = String(parameter.widget || '').toLowerCase();
        if (widget.includes('checkbox') || isBoolean(parameter)) return 'check';
        if ((parameter.choices || []).length) return 'combo';
        if (String(parameter.value || '').includes('\n')) return 'multiline';
        if (widget.includes('hex')) return 'hex';
        if (/^-?\d+$/u.test(String(parameter.value))) return 'number';
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
            render();
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
                field.type = 'text';
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

    function parameterRow(parameter, current) {
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
        controls.append(field);
        if (draft.has(parameter.key)) {
            controls.append(node('small', '原值 ' + (parameter.value || '(空)'), 'original'));
        }
        const note = node('small', undefined, 'condition');
        const editable = available(parameter, current);
        note.hidden = editable || !parameter.dependency?.length;
        if (!editable) note.textContent = parameter.readOnly ? '只读参数' : '由 ' + parameter.dependency.map(([key]) => key.slice(7)).join('、') + ' 控制';
        controls.append(note);
        row.append(caption, controls);
        return row;
    }

    function renderTree() {
        const pages = state.form?.pages || [];
        const elements = pages.map(page => {
            const section = node('div', undefined, 'page');
            section.append(node('h2', page.title));
            for (const group of page.groups) {
                const item = node('button', group.title + ' (' + group.rows.length + ')', 'group-link');
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
        const query = $('search').value.trim().toLowerCase();
        const current = values();
        const sections = [];
        for (const page of state.form?.pages || []) {
            for (const group of page.groups) {
                const rows = group.rows.filter(parameter => {
                    const value = current.get(parameter.key) ?? '';
                    return !query || (parameter.key + ' ' + (parameter.label || '') + ' ' + (parameter.help || '') + ' ' + value).toLowerCase().includes(query);
                });
                if (!rows.length) continue;
                const fieldset = node('fieldset', undefined, 'group');
                fieldset.id = 'group-' + group.id;
                const legend = node('legend', group.title);
                fieldset.append(legend);
                for (const note of group.notes) fieldset.append(node('p', note, 'note'));
                for (const parameter of rows) fieldset.append(parameterRow(parameter, current));
                sections.push(fieldset);
            }
        }
        if (!sections.length) sections.push(node('p', query ? '没有匹配的参数。' : 'Vivado 没有为此 IP 返回可配置参数。', 'empty'));
        $('form').replaceChildren(...sections);
    }

    function render() {
        const info = state.info;
        document.body.setAttribute('aria-busy', String(state.busy));
        $('name').textContent = info?.name || 'IP 定制';
        $('subtitle').textContent = [info?.vlnv, info?.locked ? '已锁定 · 只读' : '', info?.preview ? '预览' : ''].filter(Boolean).join(' · ');
        $('status').textContent = state.status || (state.busy ? '正在处理…' : '');
        const edits = editedValues();
        $('changed').textContent = edits.length ? edits.length + ' 项待应用' : '';
        $('apply').disabled = !edits.length || state.busy || !info || info.locked || info.preview;
        $('revert').disabled = !draft.size || state.busy;
        if (info) { renderTree(); renderForm(); }
    }

    $('search').oninput = renderForm;
    $('revert').onclick = () => { draft.clear(); render(); };
    $('apply').onclick = () => {
        const edits = editedValues();
        if (!edits.length) return;
        vscode.postMessage({ action: 'apply', revision: state.revision, edits });
    };
    $('close').onclick = () => vscode.postMessage({ action: 'close' });
    window.addEventListener('message', ({ data }) => {
        if (data?.type === 'applied') { draft.clear(); return; }
        if (data?.type !== 'form') return;
        state = data;
        render();
    });
    vscode.postMessage({ action: 'ready' });
})();
