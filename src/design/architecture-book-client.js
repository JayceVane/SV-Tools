/* global ArchitectureHover */
'use strict';

(() => {
    const navigation = document.querySelector('.book-nav');
    const filter = document.getElementById('chapter-filter');
    const empty = document.getElementById('no-chapters');
    const links = [...navigation.querySelectorAll('ol a')];
    const chapterLinks = new Map(links.map(link => [link.getAttribute('href').slice(1), link]));
    const panel = document.querySelector('.connection-panel');
    const panelTitle = document.getElementById('connection-panel-title');
    const panelBody = panel.querySelector('.connection-panel-body');
    let current, selection, closedForPrint = [], hiddenForPrint = [];
    ArchitectureHover.attach(document, target => {
        const { previewLink: link, previewNode: node, previewPort: port } = target.dataset;
        const endpoint = port ? `:${node || 'boundary:' + port}:${port}` : '';
        return (document.getElementById('preview-' + link + endpoint) || document.getElementById('preview-' + link))?.innerHTML || '';
    });

    filter.addEventListener('input', () => {
        const query = filter.value.trim().toLowerCase();
        navigation.classList.toggle('toc-filtered', Boolean(query));
        let found = false;
        for (const link of links) {
            const matches = link.textContent.toLowerCase().includes(query);
            link.closest('li').hidden = !matches;
            found ||= matches;
        }
        for (const link of links) {
            if (link.closest('li').hidden) continue;
            for (let parent = link.closest('li').parentElement.closest('li'); parent; parent = parent.parentElement.closest('li')) parent.hidden = false;
        }
        empty.hidden = found;
    });

    document.addEventListener('input', event => {
        if (!event.target.matches('[data-interface-filter]')) return;
        const section = event.target.closest('[data-interfaces]');
        const query = event.target.value.trim().toLowerCase();
        const entries = [...section.querySelectorAll('.interface-section')];
        for (const entry of entries) entry.hidden = !entry.querySelector('summary').textContent.toLowerCase().includes(query);
        section.querySelector('[data-no-interfaces]').hidden = entries.some(entry => !entry.hidden);
    });

    function reveal(target) {
        for (let detail = target?.closest('details'); detail; detail = detail.parentElement.closest('details')) detail.open = true;
        const next = chapterLinks.get(target?.closest('.chapter')?.id);
        if (!next) return;
        current?.removeAttribute('aria-current');
        next.setAttribute('aria-current', 'location');
        for (let row = next.closest('li'); row; row = row.parentElement.closest('li')) {
            row.querySelector(':scope > .toc-row > .toc-toggle')?.setAttribute('aria-expanded', 'true');
        }
        current = next;
    }

    function highlight(chapter, linkIds, attribute) {
        const matches = new Set(linkIds);
        const graph = chapter.querySelector(':scope > .chapter-lead');
        for (const element of graph.querySelectorAll(`[${attribute}]`)) element.removeAttribute(attribute);
        if (!matches.size) return;
        for (const element of graph.querySelectorAll('[data-preview-link], [data-link]')) {
            if (!matches.has(element.dataset.previewLink || element.dataset.link)) continue;
            element.setAttribute(attribute, '');
            element.closest('.diagram-card')?.setAttribute(attribute, '');
        }
    }

    function activateStep(button) {
        const section = button.closest('.walkthrough');
        for (const step of section.querySelectorAll('[data-walkthrough-step]')) {
            const active = step === button;
            step.setAttribute('aria-pressed', String(active));
            document.getElementById(step.getAttribute('aria-controls')).hidden = !active;
        }
        highlight(section.closest('.chapter'), button.dataset.connections.split(' ').filter(Boolean), 'data-book-walkthrough');
    }

    function closePanel({ restore = false } = {}) {
        if (!selection) return;
        const { chapter, origin, graph } = selection;
        highlight(chapter, [], 'data-book-selected');
        graph?.removeAttribute('data-panel-docked');
        graph?.style.removeProperty('--undocked-height');
        panel.hidden = true;
        panelBody.replaceChildren();
        selection = undefined;
        if (restore) {
            history.replaceState(null, '', '#' + chapter.id);
            if (origin?.matches('a, button, summary, [tabindex]')) origin.focus({ preventScroll: true });
            else chapterLinks.get(chapter.id)?.focus({ preventScroll: true });
        }
    }

    function openPanel(entry, origin) {
        closePanel();
        const chapter = entry.closest('.chapter');
        reveal(chapter);
        const graph = chapter.querySelector(':scope > .chapter-lead .diagram-print');
        selection = { chapter, origin, graph };
        panelTitle.textContent = entry.querySelector('summary strong').textContent;
        panelBody.replaceChildren(entry.querySelector('.interface-body').cloneNode(true));
        panelBody.scrollTop = 0;
        panel.hidden = false;
        if (graph) {
            graph.style.setProperty('--undocked-height', graph.offsetHeight + 'px');
            graph.setAttribute('data-panel-docked', '');
        }
        highlight(chapter, [entry.id], 'data-book-selected');
        if (origin) panelTitle.focus({ preventScroll: true });
    }

    function syncLocation() {
        const target = document.getElementById(location.hash.slice(1));
        if (target?.matches('.interface-section')) {
            const chapter = target.closest('.chapter');
            const alreadyThere = selection?.chapter === chapter;
            openPanel(target);
            if (!alreadyThere) chapter.scrollIntoView({ block: 'start' });
        } else {
            closePanel();
            reveal(target || document.querySelector('.chapter'));
        }
    }

    function toggleGroup(trigger) {
        const svg = trigger.closest('svg.architecture-svg');
        const id = trigger.getAttribute('data-expand') || trigger.getAttribute('data-members');
        const panel = svg?.querySelector('.expand-panel[data-panel="' + id + '"]');
        if (!panel) return;
        const open = panel.classList.toggle('open');
        trigger.setAttribute('aria-expanded', String(open));
        for (const other of svg.querySelectorAll('.expand-panel.open')) if (other !== panel) other.classList.remove('open');
        for (const node of svg.querySelectorAll('[data-expand][aria-expanded=true]')) if (node !== trigger) node.setAttribute('aria-expanded', 'false');
    }

    document.addEventListener('click', event => {
        const step = event.target.closest?.('[data-walkthrough-step]');
        if (step) {
            activateStep(step);
            return;
        }
        const tocToggle = event.target.closest?.('.toc-toggle');
        if (tocToggle) {
            tocToggle.setAttribute('aria-expanded', String(tocToggle.getAttribute('aria-expanded') !== 'true'));
            return;
        }
        if (event.target.closest?.('[data-close-connection]')) {
            closePanel({ restore: true });
            return;
        }
        const expand = event.target.closest?.('[data-expand],[data-members]');
        if (expand) {
            event.preventDefault();
            event.stopPropagation();
            toggleGroup(expand);
            return;
        }
        // 优先打开引脚对应的接口，卡片外层链接仍可进入子章节。
        const detail = event.target.closest?.('[data-link], .interface-section > summary, a[href^="#"]');
        if (detail && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
            const id = detail.dataset.link || detail.getAttribute('href')?.slice(1);
            const entry = detail.matches('summary') ? detail.parentElement : document.getElementById(id);
            if (entry?.matches('.interface-section')) {
                event.preventDefault();
                openPanel(entry, detail.closest('a') || detail);
                if (location.hash !== '#' + entry.id) history.pushState(null, '', '#' + entry.id);
                return;
            }
            if (detail.matches('a') && entry) reveal(entry);
        }
        const zoom = event.target.closest?.('[data-zoom]');
        if (zoom) {
            const fullSize = zoom.parentElement.nextElementSibling.classList.toggle('book-full-size');
            zoom.setAttribute('aria-pressed', String(fullSize));
            zoom.textContent = fullSize ? '适应宽度' : '原始尺寸';
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && selection) closePanel({ restore: true });
        if (!['Enter', ' '].includes(event.key)) return;
        const expand = event.target.closest?.('[data-expand],[data-members]');
        if (!expand) return;
        event.preventDefault();
        toggleGroup(expand);
    });
    window.addEventListener('hashchange', syncLocation);
    syncLocation();
    for (const firstStep of document.querySelectorAll('[data-walkthrough-step="0"]')) activateStep(firstStep);

    window.addEventListener('beforeprint', () => {
        closedForPrint = [...document.querySelectorAll('details[data-print-open]:not([open]), details.named-connections:not([open])')];
        for (const detail of closedForPrint) detail.open = true;
        hiddenForPrint = [...document.querySelectorAll('.interface-section[hidden], .walkthrough-detail[hidden], .book-nav li[hidden]')];
        for (const item of hiddenForPrint) item.hidden = false;
    });
    window.addEventListener('afterprint', () => {
        for (const detail of closedForPrint) detail.open = false;
        for (const item of hiddenForPrint) item.hidden = true;
        closedForPrint = [];
        hiddenForPrint = [];
    });
})();
