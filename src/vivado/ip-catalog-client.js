/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), $ = id => document.getElementById('catalog-' + id);
    const pageSize = 80;
    let items = [], selected, page = 0, busy = true;
    const text = (id, value) => { $(id).textContent = value || ''; };
    const vendor = item => item.value.split(':')[0];
    function renderDetail() {
        text('name', selected?.label || '选择一个 IP');
        text('vlnv', selected?.value);
        text('description', selected?.detail);
        text('taxonomy', selected?.categories.join(' · '));
        $('create').disabled = busy || !selected;
    }
    function renderList() {
        const words = $('search').value.toLowerCase().trim().split(/\s+/u);
        const category = $('category').value, manufacturer = $('vendor').value;
        const found = items.filter(item => (!category || item.categories.includes(category)) && (!manufacturer || vendor(item) === manufacturer) &&
            words.every(word => `${item.label} ${item.value} ${item.detail}`.toLowerCase().includes(word)));
        const pages = Math.max(1, Math.ceil(found.length / pageSize));
        page = Math.min(page, pages - 1);
        const rows = found.slice(page * pageSize, (page + 1) * pageSize).map(item => {
            const row = document.createElement('button'), name = document.createElement('span'), ref = document.createElement('small');
            row.className = 'member';
            row.setAttribute('aria-current', String(item === selected));
            name.textContent = item.label;
            ref.textContent = item.value;
            row.append(name, ref);
            row.onclick = () => {
                $('items').querySelector('[aria-current=true]')?.setAttribute('aria-current', 'false');
                row.setAttribute('aria-current', 'true');
                selected = item;
                renderDetail();
            };
            return row;
        });
        $('items').replaceChildren(...rows);
        $('items').scrollTop = 0;
        text('count', found.length ? `${found.length} 条定义` : items.length ? '没有匹配的 IP' : '');
        text('page', found.length ? `${page + 1} / ${pages}` : '');
        $('prev').disabled = !page;
        $('next').disabled = page + 1 >= pages;
    }
    function filters(id, label, values) {
        const control = $(id), old = control.value;
        const entries = [...new Set(values)].sort((a, b) => a.localeCompare(b));
        control.replaceChildren(new Option(label, ''), ...entries.map(value => new Option(value, value)));
        if (entries.includes(old)) control.value = old;
    }
    for (const id of ['search', 'category', 'vendor']) $(id).oninput = () => { page = 0; renderList(); };
    $('prev').onclick = () => { page--; renderList(); };
    $('next').onclick = () => { page++; renderList(); };
    $('refresh').onclick = () => vscode.postMessage({ action: 'refresh' });
    $('create').onclick = () => { if (selected && !busy) vscode.postMessage({ action: 'create', vlnv: selected.value }); };
    window.addEventListener('message', ({ data }) => {
        if (data.type !== 'catalog') return;
        busy = data.busy;
        $('refresh').disabled = busy;
        text('project', data.data ? `${data.data.part} · Vivado ${data.data.version}` : data.xpr);
        $('project').title = data.xpr;
        text('status', data.status);
        const next = data.data?.items || [];
        const value = selected?.value;
        items = next;
        selected = next.find(item => item.value === value);
        filters('category', '全部分类', next.flatMap(item => item.categories));
        filters('vendor', '全部厂商', next.map(vendor));
        renderList();
        renderDetail();
    });
    renderList();
    vscode.postMessage({ action: 'ready' });
})();
