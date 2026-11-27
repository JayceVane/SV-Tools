'use strict';

(() => {
    const vscode = acquireVsCodeApi();
    const byId = id => document.getElementById(id);
    const elements = Object.fromEntries(['workspace', 'status', 'refresh', 'search', 'module', 'results', 'notes',
        'note-title', 'anchors', 'current', 'checkpoint', 'history-status', 'comparison', 'compare-to',
        'diff', 'preview', 'restore', 'restore-prompt', 'confirm-restore', 'cancel-restore', 'versions'].map(id => [id, byId(id)]));
    const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false });
    const ordering = new Intl.Collator(undefined, { numeric: true });
    const saved = vscode.getState() || {};
    let notes = [], note, versions = [], selected, invalid = [], baseline = '', waiting = false;
    let firstCatalog = true;

    function showRestorePrompt(visible) {
        elements['restore-prompt'].hidden = !visible;
        elements.restore.setAttribute('aria-expanded', String(visible));
    }

    function send(type, extra = {}) {
        vscode.postMessage({ type, id: note?.id, ...extra });
    }

    function persist() {
        vscode.setState({ noteId: note?.id, search: elements.search.value, module: elements.module.value });
    }

    function option(value, label) {
        const node = document.createElement('option');
        node.value = value;
        node.textContent = label;
        return node;
    }

    function row(label, detail, active, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'list-row';
        button.setAttribute('aria-pressed', String(active));
        const title = document.createElement('span');
        title.className = 'row-title';
        title.textContent = label;
        const subtitle = document.createElement('span');
        subtitle.className = 'row-detail';
        subtitle.textContent = detail;
        button.append(title, subtitle);
        button.addEventListener('click', action);
        return button;
    }

    function moduleOptions(value) {
        const modules = [...new Set(notes.flatMap(item => item.modules))].sort(ordering.compare);
        const options = [option('', '全部模块'), ...modules.map(module => option(module, module))];
        if (notes.some(item => !item.modules.length)) options.push(option('?', '未关联模块'));
        elements.module.replaceChildren(...options);
        elements.module.value = options.some(item => item.value === value) ? value : '';
    }

    function matchingNotes() {
        const query = elements.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const module = elements.module.value;
        return notes.filter(item => {
            if (module === '?' ? item.modules.length : module && !item.modules.includes(module)) return false;
            const searchable = [item.title, item.id, ...item.modules, ...item.anchors.map(anchor => anchor.file)].join(' ').toLowerCase();
            return query.every(term => searchable.includes(term));
        });
    }

    function renderNotes(matches = matchingNotes()) {
        elements.results.textContent = matches.length ? matches.length + ' 篇文档' : (notes.length ? '没有匹配的文档' : '工作区暂无设计笔记');
        elements.notes.replaceChildren(...matches.map(item => row(item.title, [
            item.modules.join('、') || item.anchors[0]?.file || item.id,
            item.exists ? '' : '当前稿已删除'
        ].filter(Boolean).join(' · '), item.id === note?.id, event => selectNote(item, event.currentTarget))));
    }

    function selectNote(item, trigger) {
        note = item;
        versions = [];
        selected = undefined;
        invalid = [];
        baseline = '';
        waiting = Boolean(note);
        showRestorePrompt(false);
        renderNotes();
        if (trigger) elements.notes.querySelector('[aria-pressed="true"]')?.focus();
        renderVersions();
        persist();
        if (note) send('select');
    }

    function versionLabel(entry) {
        return entry.label || (entry.kind === 'checkpoint' ? '检查点' : entry.kind === 'restore-backup' ? '恢复前' : '编辑器保存');
    }

    function renderVersions() {
        elements['note-title'].textContent = note?.title || '选择一篇文档';
        elements.anchors.textContent = note ? note.anchors.map(anchor => anchor.file + ':' + anchor.line).join(' · ') : '';
        elements.current.disabled = !note?.exists;
        elements.checkpoint.disabled = !note?.exists;
        const warning = invalid.length ? '。' + invalid.length + ' 条历史无法校验' : '';
        if (invalid.length) elements['history-status'].title = invalid.map(entry => entry.message).join('\n');
        else elements['history-status'].removeAttribute('title');
        elements['history-status'].textContent = note ? waiting ? '正在读取版本…' : versions.length ?
            versions.length + ' 个版本' + warning : '保存笔记或创建检查点后，版本会显示在这里' + warning : '';
        elements.comparison.hidden = !selected;
        elements.preview.disabled = !selected;
        elements.restore.disabled = !selected;
        const targets = [];
        if (note?.exists) targets.push(option('current', '当前稿'));
        const previous = versions[versions.indexOf(selected) + 1];
        if (selected && previous) targets.push(option(previous.version, '前一版 · ' + versionLabel(previous)));
        for (const entry of versions) {
            if (entry !== selected && entry !== previous) targets.push(option(entry.version, versionLabel(entry) + ' · ' + date.format(entry.time)));
        }
        elements['compare-to'].replaceChildren(...targets);
        baseline = targets.some(item => item.value === baseline) ? baseline : targets[0]?.value || '';
        elements['compare-to'].value = baseline;
        elements['compare-to'].disabled = !targets.length;
        elements.diff.disabled = !selected || !baseline;
        elements.versions.replaceChildren(...versions.map(entry => row(versionLabel(entry), date.format(entry.time),
            entry.version === selected?.version, () => {
                selected = entry;
                showRestorePrompt(false);
                renderVersions();
                elements.versions.querySelector('[aria-pressed="true"]')?.focus();
            })));
    }

    function filter() {
        const matches = matchingNotes();
        if (!matches.some(item => item.id === note?.id)) selectNote(matches[0]);
        else { renderNotes(matches); persist(); }
    }

    elements.search.value = saved.search || '';
    elements.search.addEventListener('input', filter);
    elements.module.addEventListener('change', filter);
    elements.refresh.addEventListener('click', () => send('refresh'));
    elements.current.addEventListener('click', () => send('current'));
    elements.checkpoint.addEventListener('click', () => send('checkpoint'));
    elements.preview.addEventListener('click', () => send('preview', { version: selected.version }));
    elements.restore.setAttribute('aria-controls', 'restore-prompt');
    showRestorePrompt(false);
    elements.restore.addEventListener('click', () => {
        showRestorePrompt(true);
        elements['confirm-restore'].focus();
    });
    elements['confirm-restore'].addEventListener('click', () => {
        showRestorePrompt(false);
        if (selected) send('restore', { version: selected.version });
    });
    elements['cancel-restore'].addEventListener('click', () => {
        showRestorePrompt(false);
        elements.restore.focus();
    });
    elements.diff.addEventListener('click', () => send('diff', { version: selected.version, base: baseline }));
    elements['compare-to'].addEventListener('change', () => { baseline = elements['compare-to'].value; });

    window.addEventListener('message', event => {
        const data = event.data;
        if (data.type === 'loading') {
            elements.refresh.disabled = true;
            elements.status.textContent = '正在读取工作区文档与模块…';
        } else if (data.type === 'catalog') {
            notes = data.notes;
            elements.workspace.textContent = data.workspace;
            elements.status.textContent = data.incomplete ? '部分源码未能扫描，可按笔记标题或 ID 查找。' : '';
            elements.refresh.disabled = false;
            moduleOptions(firstCatalog ? saved.module || '' : elements.module.value);
            firstCatalog = false;
            const focus = notes.find(item => item.id === (data.focusId || data.selectionId || saved.noteId));
            let matches = matchingNotes();
            if (focus && data.focusId && !matches.some(item => item.id === focus.id)) {
                elements.search.value = '';
                elements.module.value = '';
                matches = matchingNotes();
            }
            selectNote(matches.find(item => item.id === focus?.id) || matches[0]);
        } else if (data.type === 'versions' && data.id === note?.id) {
            const previous = selected?.version;
            const isNewest = !previous || previous === versions[0]?.version;
            versions = data.revisions;
            invalid = data.invalid;
            selected = isNewest ? versions[0] : versions.find(item => item.version === previous) || versions[0];
            if (selected?.version !== previous) showRestorePrompt(false);
            waiting = false;
            renderVersions();
        } else if (data.type === 'error' || data.type === 'action-error') {
            elements.refresh.disabled = false;
            elements.status.textContent = data.message;
            waiting = false;
            renderVersions();
        }
    });
    send('ready');
})();
