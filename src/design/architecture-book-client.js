/* global ArchitectureHover */
'use strict';

(() => {
    const navigation = document.querySelector('.book-nav');
    const filter = document.getElementById('chapter-filter');
    const empty = document.getElementById('no-chapters');
    const links = [...navigation.querySelectorAll('ol a')];
    const chapterLinks = new Map(links.map(link => [link.getAttribute('href').slice(1), link]));
    let current, closedForPrint = [];
    ArchitectureHover.attach(document, target => {
        const { previewLink: link, previewNode: node, previewPort: port } = target.dataset;
        const endpoint = port ? `:${node || 'boundary:' + port}:${port}` : '';
        return (document.getElementById('preview-' + link + endpoint) || document.getElementById('preview-' + link))?.innerHTML || '';
    });

    filter.addEventListener('input', () => {
        const query = filter.value.trim().toLowerCase();
        let found = false;
        for (const link of links) {
            const matches = link.textContent.toLowerCase().includes(query);
            link.parentElement.hidden = !matches;
            found ||= matches;
        }
        for (const link of links) {
            if (link.parentElement.hidden) continue;
            for (let parent = link.parentElement.parentElement.closest('li'); parent; parent = parent.parentElement.closest('li')) parent.hidden = false;
        }
        empty.hidden = found;
    });

    function reveal(id) {
        const target = document.getElementById(id);
        for (let detail = target?.closest('details'); detail; detail = detail.parentElement.closest('details')) detail.open = true;
        const next = chapterLinks.get(target?.closest('.chapter')?.id);
        current?.removeAttribute('aria-current');
        next?.setAttribute('aria-current', 'location');
        current = next;
    }

    function toggleGroup(trigger) {
        const svg = trigger.closest('svg.architecture-svg');
        const panel = svg?.querySelector('.expand-panel[data-panel="' + trigger.getAttribute('data-expand') + '"]');
        if (!panel) return;
        const open = panel.classList.toggle('open');
        trigger.setAttribute('aria-expanded', String(open));
        for (const other of svg.querySelectorAll('.expand-panel.open')) if (other !== panel) other.classList.remove('open');
        for (const node of svg.querySelectorAll('[data-expand][aria-expanded=true]')) if (node !== trigger) node.setAttribute('aria-expanded', 'false');
    }

    document.addEventListener('click', event => {
        const expand = event.target.closest?.('[data-expand]');
        if (expand) {
            event.preventDefault();
            event.stopPropagation();
            toggleGroup(expand);
            return;
        }
        const link = event.target.closest?.('a[href^="#"]');
        if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) reveal(link.getAttribute('href').slice(1));
        const zoom = event.target.closest?.('[data-zoom]');
        if (zoom) {
            const fullSize = zoom.parentElement.nextElementSibling.classList.toggle('book-full-size');
            zoom.setAttribute('aria-pressed', String(fullSize));
            zoom.textContent = fullSize ? '适应宽度' : '原始尺寸';
        }
    });
    document.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        const expand = event.target.closest?.('[data-expand]');
        if (!expand) return;
        event.preventDefault();
        toggleGroup(expand);
    });
    window.addEventListener('hashchange', () => reveal(location.hash.slice(1)));
    reveal(location.hash.slice(1));

    window.addEventListener('beforeprint', () => {
        closedForPrint = [...document.querySelectorAll('details[data-print-open]:not([open]), details.named-connections:not([open])')];
        for (const detail of closedForPrint) detail.open = true;
    });
    window.addEventListener('afterprint', () => {
        for (const detail of closedForPrint) detail.open = false;
        closedForPrint = [];
    });
})();
