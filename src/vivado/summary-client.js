/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), $ = id => document.getElementById(id);
    const strings = JSON.parse($('summary-strings').textContent);
    const phrase = (key, ...values) => strings[key].replace(/\{(\d+)\}/gu, (_, index) => values[index]);
    const countText = new Intl.NumberFormat(strings.locale, { maximumFractionDigits: 2 });
    const powerText = new Intl.NumberFormat(strings.locale, { minimumFractionDigits: 3, maximumFractionDigits: 6 });
    const preferences = vscode.getState() || {};
    let signature, auto = preferences.auto !== false, powerMode = preferences.powerMode === 'details' ? 'details' : 'distribution';
    let messageRequest = 0, groupRequest = 0, messagePage, messageTimer, messageQuery, runOptionsKey;
    const expandedRuns = new Set();
    const visibleGroups = new Map(), expandedMessageGroups = new Map();
    const remember = () => vscode.setState({ auto, powerMode });
    const severityLabels = { errors: strings.errors, criticalWarnings: strings.criticalWarnings,
        warnings: strings.warnings, info: strings.info, status: strings.messageStatus };

    function node(tag, text, className) {
        const item = document.createElement(tag);
        if (text !== undefined) item.textContent = text;
        if (className) item.className = className;
        return item;
    }

    const progressValue = progress => {
        const match = /^(\d+(?:\.\d+)?)\s*%$/u.exec(String(progress || '').trim());
        return match ? Math.min(100, Number(match[1])) : null;
    };
    const numberText = value => Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 1000 ? 0 : 3) : '—';

    function statusOf(run) {
        if (!run) return ['idle', strings.none];
        const status = run.status || '';
        if (/fail|error/i.test(status)) return ['bad', strings.failed];
        if (/cancel|abort|stopped/i.test(status)) return ['bad', strings.stopped];
        if (/queued/i.test(status)) return ['busy', strings.queued];
        if (/running|in progress/i.test(status) || /running/i.test(run.progress)) return ['busy', strings.active];
        if (/complete|finished/i.test(status)) return ['ok', strings.complete];
        if (/not started/i.test(status)) return ['idle', strings.notStarted];
        return ['idle', status && status !== 'Unknown' ? status : strings.unknown];
    }

    function statusBadge(run) {
        const [kind, label] = statusOf(run);
        const badge = node('span', label, 'chip ' + kind);
        badge.title = run?.status || '';
        return badge;
    }

    function staleBadge() {
        return node('span', strings.stale, 'chip warn');
    }

    function progressMeter(run) {
        const value = progressValue(run?.progress);
        const result = node('div', undefined, 'run-progress');
        if (value !== null) {
            const bar = node('progress', undefined, 'bar ' + statusOf(run)[0]);
            bar.max = 100;
            bar.value = value;
            bar.setAttribute('aria-label', strings.progress);
            result.append(bar, node('span', value + '%', 'percentage'));
        } else {
            result.append(node('span', statusOf(run)[0] === 'busy' ? strings.waiting : run?.progress || '—', 'muted'));
        }
        return result;
    }

    function drawProject(project) {
        $('project').textContent = project.name || strings.title;
        const directory = $('directory');
        directory.textContent = directory.title = project.directory || '';
        directory.hidden = !project.directory;
        const facts = [[strings.part, project.part], [strings.top, project.top]];
        if (project.board) facts.push([strings.board, project.board]);
        $('meta').replaceChildren(...facts.map(([label, value]) => {
            const item = node('div', undefined, 'fact');
            item.append(node('dt', label), node('dd', value || '—'));
            return item;
        }));
    }

    function currentRun(runs, id, implementation) {
        const group = runs.filter(run => Boolean(run.implementation) === implementation);
        return group.find(run => run.id === id) || group.find(run => run.id === (implementation ? 'impl_1' : 'synth_1'));
    }

    function drawCards(synthesis, implementation, messages = {}) {
        const stages = [[strings.synthesis, synthesis], [strings.implementation, implementation]];
        $('cards').replaceChildren(...stages.map(([label, run]) => {
            const card = node('article', undefined, 'card ' + statusOf(run)[0]);
            const head = node('header', undefined, 'card-heading');
            head.append(node('h2', label), statusBadge(run));
            card.append(head);
            if (!run) return card;
            const details = node('div', undefined, 'card-details');
            details.append(node('span', run.id, 'run-name'));
            if (run.needsRefresh) details.append(staleBadge());
            const meta = [run.step, run.elapsed].filter(Boolean).join(' · ');
            if (meta) details.append(node('span', meta, 'muted'));
            const counts = Object.hasOwn(messages, run.id) ? messages[run.id] : null;
            const notices = node('div', undefined, 'run-notices');
            for (const level of ['warnings', 'criticalWarnings']) {
                const count = counts?.counts[level];
                const text = Number.isFinite(count) ? (counts.countsPartial ? '≥' : '') + countText.format(count) : '—';
                const button = node('button', severityLabels[level] + ' · ' + text, 'run-notice ' + (count ? level : 'muted'));
                button.type = 'button';
                button.disabled = !counts;
                if (!counts) button.title = strings.noLogs;
                button.onclick = () => showRunMessages(run.id, level);
                notices.append(button);
            }
            card.append(details, progressMeter(run), notices);
            return card;
        }));
    }

    function runAction(run, kind, label) {
        const action = node('button', label, 'link-button');
        action.type = 'button';
        action.setAttribute('aria-label', phrase('openArtifact', label, run.id));
        action.onclick = () => vscode.postMessage({ action: 'openRun', run: run.id, kind });
        return action;
    }

    function drawRuns(runs, paths, primary) {
        const list = $('runs');
        list.replaceChildren(...runs.map(run => {
            const row = node('details', undefined, 'run-record');
            row.dataset.run = run.id;
            row.open = expandedRuns.has(run.id);
            const title = node('summary', undefined, 'run-summary');
            title.append(node('span', run.id, 'run-name'));
            const state = node('span', undefined, 'run-state');
            state.append(statusBadge(run));
            if (run.needsRefresh) state.append(staleBadge());
            title.append(state, progressMeter(run));
            const body = node('div', undefined, 'run-record-body');
            const detail = [run.implementation ? strings.implementation : strings.synthesis, primary.includes(run.id) ? strings.current : ''].filter(Boolean);
            body.append(node('p', detail.join(' · '), 'run-detail'));
            const facts = node('dl', undefined, 'run-facts');
            for (const [label, value] of [[strings.step, run.step], [strings.elapsed, run.elapsed], [strings.strategy, run.strategy]]) {
                if (!value) continue;
                const fact = node('div');
                fact.append(node('dt', label), node('dd', value));
                facts.append(fact);
            }
            if (facts.children.length) body.append(facts);
            const actions = node('div', undefined, 'run-actions');
            const output = paths && Object.hasOwn(paths, run.id) ? paths[run.id] : null;
            if (output?.log) actions.append(runAction(run, 'log', strings.log));
            if (output?.directory) actions.append(runAction(run, 'directory', strings.directory));
            if (output?.log) {
                const button = node('button', strings.messages, 'link-button');
                button.type = 'button';
                button.onclick = () => showRunMessages(run.id, '');
                actions.append(button);
            }
            if (actions.children.length) body.append(actions);
            row.ontoggle = () => {
                if (row.parentElement !== list) return;
                if (row.open) expandedRuns.add(run.id);
                else expandedRuns.delete(run.id);
                updateRunsToggle();
            };
            row.append(title, body);
            return row;
        }));
        $('run-count').textContent = runs.length ? phrase('runCount', runs.length) : '';
        updateRunsToggle();
        $('runs-empty').hidden = Boolean(runs.length);
    }

    function updateRunsToggle() {
        const rows = [...$('runs').children];
        $('toggle-runs').hidden = !rows.length;
        const open = rows.some(row => row.open);
        $('toggle-runs').textContent = open ? strings.collapseRuns : strings.expandRuns;
        $('toggle-runs').onclick = () => {
            expandedRuns.clear();
            for (const row of rows) {
                row.open = !open;
                if (row.open) expandedRuns.add(row.dataset.run);
            }
            updateRunsToggle();
        };
    }

    function drawTiming(result) {
        const data = result?.data || {};
        $('timing-source').replaceChildren(...(result ? [reportSource('timing', result)] : []));
        const groups = [['setup', 'wns', 'tns'], ['hold', 'whs', 'ths'], ['pulse', 'wpws', 'tpws']];
        const cards = groups.map(([group, worst, total]) => {
            const card = node('div', undefined, 'timing-group');
            const metrics = node('dl', undefined, 'metrics');
            for (const key of [worst, total]) {
                const value = data[key], item = node('div', undefined, 'metric');
                item.append(node('dt', key.toUpperCase()), node('dd', Number.isFinite(value) ? numberText(value) + ' ns' : '—',
                    value < 0 ? 'negative' : ''));
                metrics.append(item);
            }
            const failing = data[group + 'Failing'], endpoints = data[group + 'Total'];
            const endpointText = value => Number.isFinite(value) ? countText.format(value) : '—';
            const counts = node('div', undefined, 'metric endpoints');
            counts.append(node('dt', strings.endpoints), node('dd', endpointText(failing) + ' / ' + endpointText(endpoints),
                failing > 0 ? 'negative' : ''));
            metrics.append(counts);
            card.append(node('h4', strings[group]), metrics);
            return card;
        });
        if (!result) cards.unshift(node('p', strings.emptyTiming, 'timing-empty muted'));
        $('timing').replaceChildren(...cards);
    }

    function option(label, value) {
        const item = node('option', label);
        item.value = value;
        return item;
    }

    function syncMessageRuns(runs) {
        const key = JSON.stringify(runs.map(run => run.id));
        if (key === runOptionsKey) return;
        runOptionsKey = key;
        const control = $('message-run'), selected = control.value;
        control.replaceChildren(option(strings.allRuns, ''), ...runs.map(run => option(run.id, run.id)));
        control.value = runs.some(run => run.id === selected) ? selected : '';
    }

    function listMessages(offset = 0, loading = false) {
        clearTimeout(messageTimer);
        messageQuery = $('message-search').value;
        if (loading) $('message-status').textContent = strings.messagesLoading;
        vscode.postMessage({ action: 'listMessages', request: ++messageRequest, run: $('message-run').value,
            level: $('message-level').value, search: messageQuery, offset });
    }

    function showRunMessages(run, level) {
        $('message-run').value = run;
        $('message-level').value = level;
        $('message-search').value = '';
        listMessages(0, true);
        const heading = $('messages-title');
        heading.focus();
        heading.scrollIntoView({ block: 'start' });
    }

    function drawMessage(message, grouped = false) {
        const item = node('li'), heading = node('div', undefined, 'message-heading');
        if (!grouped) {
            heading.append(node('span', severityLabels[message.level], 'severity ' + message.level));
            if (message.id) heading.append(node('code', message.id));
        }
        heading.append(node('span', [grouped ? '' : message.run, message.step].filter(Boolean).join(' · '), 'muted'));
        const button = node('button', phrase('logLine', message.line), 'link-button');
        button.type = 'button';
        button.onclick = () => vscode.postMessage({ action: 'openMessage', run: message.run, line: message.line });
        heading.append(button);
        item.append(heading, node('p', message.text, 'message-text'));
        return item;
    }

    const messageGroupKey = ({ run, level, id }) => JSON.stringify([run, level, id]);
    function messageRange(page) {
        const range = [page.offset + 1, page.offset + page.items.length, page.total].map(value => countText.format(value));
        return page.messageCount > page.total ? phrase('messageGroupRange', ...range, countText.format(page.messageCount)) : phrase('messageRange', ...range);
    }

    function syncMessageGroupToggle() {
        const toggle = $('toggle-message-groups'), groups = [...visibleGroups.values()];
        toggle.hidden = !groups.length;
        toggle.textContent = groups.every(group => group.details.open) ? strings.collapseMessageGroups : strings.expandMessageGroups;
    }

    function drawMessageGroup(message, pageRequest) {
        const { run, level, id } = message;
        const key = messageGroupKey(message), item = node('li'), details = node('details', undefined, 'message-group');
        const summary = node('summary'), heading = node('span', undefined, 'message-group-heading');
        heading.append(node('span', severityLabels[level], 'severity ' + level), node('code', id), node('span', run, 'muted'),
            node('span', phrase('messageOccurrences', countText.format(message.count)), 'message-occurrences'));
        summary.append(heading, node('span', message.text.split('\n', 1)[0], 'message-preview'));

        const status = node('p', undefined, 'muted'), list = node('ol', undefined, 'message-group-list');
        status.setAttribute('role', 'status');
        const controls = node('div', undefined, 'message-pages');
        controls.hidden = true;
        const previous = node('button', strings.previous), next = node('button', strings.next);
        previous.type = next.type = 'button';
        controls.append(previous, next);
        details.append(summary, status, list, controls);
        item.append(details);
        let pending;
        function load(offset) {
            if (pageRequest !== messageRequest) return;
            expandedMessageGroups.set(key, offset);
            status.textContent = strings.messagesLoading;
            status.hidden = false;
            previous.disabled = next.disabled = true;
            pending = ++groupRequest;
            vscode.postMessage({ action: 'listMessageGroup', request: pending, run, level, id, search: messageQuery, offset });
        }
        const group = { details, receive(result) {
            if (!details.open || result.request !== pending || pageRequest !== messageRequest) return;
            if (result.offset && result.offset >= result.total) { load(0); return; }
            list.replaceChildren(...result.items.map(entry => drawMessage(entry, true)));
            status.textContent = !result.total ? strings.noMessages : result.total > result.items.length ? messageRange(result) : '';
            status.hidden = !status.textContent;
            controls.hidden = !result.offset && result.items.length >= result.total;
            previous.disabled = !result.offset;
            next.disabled = result.offset + result.items.length >= result.total;
            previous.onclick = () => load(Math.max(0, result.offset - result.size));
            next.onclick = () => load(result.offset + result.items.length);
        } };
        visibleGroups.set(key, group);
        details.ontoggle = () => {
            if (visibleGroups.get(key) !== group) return;
            if (details.open) load(expandedMessageGroups.get(key) || 0);
            else expandedMessageGroups.delete(key);
            syncMessageGroupToggle();
        };
        details.open = expandedMessageGroups.has(key);
        return item;
    }

    function drawMessages(page) {
        if (page.offset && page.offset >= page.total) { listMessages(); return; }
        messagePage = page;
        visibleGroups.clear();
        $('messages').replaceChildren(...page.items.map(message =>
            message.count > 1 ? drawMessageGroup(message, page.request) : drawMessage(message)));
        syncMessageGroupToggle();
        const caption = !page.available ? strings.noLogs : !page.total ? strings.noMessages : messageRange(page);
        $('message-status').textContent = [caption, page.truncated && strings.truncatedMessages].filter(Boolean).join(' · ');
        $('message-pages').hidden = !page.offset && page.items.length >= page.total;
        $('message-prev').disabled = page.offset === 0;
        $('message-next').disabled = page.offset + page.items.length >= page.total;
    }

    function reportSource(kind, result, stage) {
        const source = node('div', undefined, 'report-source');
        source.append(node('span', [result.run, strings.phases[result.phase], result.stale && strings.stale].filter(Boolean).join(' · ')));
        if (result.file) {
            const button = node('button', strings.report, 'link-button');
            button.type = 'button';
            button.setAttribute('aria-label', phrase('reportFor', stage ? strings[stage] + ' · ' + strings[kind] : strings[kind]));
            button.onclick = () => vscode.postMessage(stage ? { action: 'openReport', kind, stage } : { action: 'openReport', kind });
            source.append(button);
        }
        return source;
    }

    const percentText = value => value > 0 && value < 0.01 ? '<0.01%' : countText.format(value) + '%';

    function resourceCell(resource, name, other) {
        const cell = node('td');
        if (!resource) { cell.textContent = '—'; return cell; }
        const { used, available } = resource;
        const counts = node('span', countText.format(used) + ' / ' + countText.format(available), 'numbers');
        counts.title = phrase('used', countText.format(used), countText.format(available));
        cell.append(counts);
        if (other && other.available === available && other.used !== used) {
            const delta = used - other.used;
            const change = node('span', (delta > 0 ? '+' : '−') + countText.format(Math.abs(delta)), 'resource-delta numbers');
            change.title = strings.delta;
            cell.append(change);
        }
        if (available > 0) {
            const value = used / available * 100;
            const bar = node('progress', undefined, 'bar');
            bar.max = 100;
            bar.value = Math.max(0, Math.min(100, value));
            bar.setAttribute('aria-label', name);
            const meter = node('div', undefined, 'resource-meter');
            meter.append(bar, node('span', percentText(value), 'percentage'));
            cell.append(meter);
        }
        return cell;
    }

    function drawUtilization(data = {}, details = {}) {
        const table = node('table', undefined, 'utilization-comparison');
        const thead = node('thead'), header = node('tr'), tbody = node('tbody');
        const resourceColumn = node('th', strings.resource);
        resourceColumn.scope = 'col';
        header.append(resourceColumn);
        for (const stage of ['synthesis', 'implementation']) {
            const cell = node('th', strings[stage]);
            cell.scope = 'col';
            const result = data[stage];
            cell.append(result ? reportSource('utilization', result, stage) : node('span', strings.noUtilization, 'missing-report'));
            if (details[stage]) {
                const actions = node('div', undefined, 'report-detail-actions');
                for (const [kind, detail] of Object.entries(details[stage])) {
                    const button = node('button', strings[kind], 'link-button');
                    button.type = 'button';
                    const label = strings[kind] + ' · ' + detail.request.run;
                    button.title = phrase(detail.file ? 'reportFor' : 'generateFor', label);
                    button.setAttribute('aria-label', button.title);
                    button.onclick = () => vscode.postMessage({ action: 'openDetail', kind, stage });
                    actions.append(button);
                }
                cell.append(actions);
            }
            header.append(cell);
        }
        const synth = new Map((data.synthesis?.data || []).map(row => [row.resource, row]));
        const impl = new Map((data.implementation?.data || []).map(row => [row.resource, row]));
        for (const [key, name] of Object.entries(strings.resources)) {
            if (!synth.has(key) && !impl.has(key)) continue;
            const row = node('tr'), label = node('th', name);
            label.scope = 'row';
            row.append(label, resourceCell(synth.get(key), strings.synthesis + ' · ' + name),
                resourceCell(impl.get(key), strings.implementation + ' · ' + name, synth.get(key)));
            tbody.append(row);
        }
        thead.append(header);
        table.append(thead, tbody);
        $('utilization').replaceChildren(table);
    }

    const powerColors = ['#559bdb', '#40a68e', '#c88bc3', '#db9b56', '#7c90df', '#84ae5c', '#d47b76', '#59a9bb',
        '#b09472', '#b0aa62', '#ac78d0', '#588bc2', '#d9978a', '#83a98a'];
    const componentName = label => strings.componentNames[label.toLowerCase()] || label;

    const positivePower = items => items.filter(item => Number.isFinite(item.watts) && item.watts > 0);

    function powerGroups(data) {
        if (!(data.total > 0)) return [];
        const components = positivePower(data.components || []);
        const staticComponent = item => /\bstatic\b/iu.test(item.label);
        const dynamic = { label: strings.dynamic, watts: data.dynamic, color: '#559bdb' };
        const staticPower = { label: strings.static, watts: data.static, color: '#40a68e' };
        const totals = positivePower([dynamic, staticPower]);
        const componentsFor = items => items.map(({ label, watts }) => ({ label: componentName(label), watts }));
        if (!totals.length) return components.length ? [{ label: strings.components, total: data.total, items: componentsFor(components) }] : [];
        const explicitOther = components.filter(item => /^GT(?:X|H|Y|M|P)\b/iu.test(item.label));
        const remainder = data.total - (data.dynamic || 0) - (data.static || 0);
        const outside = remainder > 0 && explicitOther.reduce((sum, item) => sum + item.watts, 0) <= remainder + 1e-9 ? explicitOther : [];
        const groups = [{ label: strings.totalPower, total: data.total, items: [...componentsFor(outside), ...totals] }];
        const dynamicParts = components.filter(item => !staticComponent(item) && !outside.includes(item) && !/^dynamic(?: power)?$/iu.test(item.label));
        const staticParts = components.filter(item => staticComponent(item) && !/^(?:device )?static(?: power)?$/iu.test(item.label));
        if (data.dynamic > 0 && dynamicParts.length) groups.push({ label: strings.dynamic, total: data.dynamic, items: componentsFor(dynamicParts) });
        if (data.static > 0 && staticParts.length) groups.push({ label: strings.static, total: data.static, items: componentsFor(staticParts) });
        return groups;
    }

    function powerBar({ label, total, items }) {
        const body = node('div', undefined, 'power-breakdown');
        const bar = node('div', undefined, 'power-stack');
        bar.setAttribute('aria-hidden', 'true');
        const legend = node('ul', undefined, 'power-legend');
        legend.setAttribute('aria-label', label);
        const known = items.reduce((sum, item) => sum + item.watts, 0);
        const segments = total - known > 1e-9 ? [...items, { label: strings.unallocated, watts: total - known, color: '#7c8794' }] : items;
        for (const [index, entry] of segments.entries()) {
            const { label, watts, color = powerColors[index % powerColors.length] } = entry;
            const text = powerText.format(watts) + ' W · ' + percentText(watts / Math.max(known, total) * 100);
            const segment = node('span');
            segment.style.flexGrow = watts / Math.max(known, total) * 100;
            segment.style.backgroundColor = color;
            segment.title = label + ' · ' + text;
            bar.append(segment);
            const item = node('li');
            const swatch = node('span', undefined, 'power-swatch');
            swatch.style.backgroundColor = color;
            swatch.setAttribute('aria-hidden', 'true');
            item.append(swatch, node('span', label), node('span', text, 'numbers'));
            legend.append(item);
        }
        body.append(node('h4', label), bar, legend);
        if (known - total > 1e-9) body.append(node('p', strings.roundedShares, 'muted power-note'));
        return body;
    }

    function powerComponents(components) {
        const list = node('dl', undefined, 'power-components');
        list.setAttribute('aria-label', strings.components);
        for (const { label, watts, below } of components) {
            const item = node('div');
            const value = Number.isFinite(watts) ? powerText.format(watts) : '<' + powerText.format(below);
            item.append(node('dt', componentName(label)), node('dd', value + ' W', 'numbers'));
            list.append(item);
        }
        return list;
    }

    function powerView(data) {
        const content = node('div'), values = node('dl', undefined, 'power-values');
        const fields = [['totalPower', data.total], ['dynamic', data.dynamic], ['static', data.static]];
        for (const [key, value] of fields) {
            if (!Number.isFinite(value)) continue;
            const item = node('div', undefined, key === 'totalPower' ? 'metric-key' : '');
            item.append(node('dt', strings[key]), node('dd', powerText.format(value) + ' W', 'numbers'));
            values.append(item);
        }
        if (data.confidence) {
            const item = node('div');
            item.append(node('dt', strings.confidence), node('dd', strings.confidenceLevels[data.confidence.toLowerCase()] || data.confidence));
            values.append(item);
        }
        content.append(values);
        const groups = powerGroups(data), components = data.components || [];
        if (!groups.length) {
            if (components.length) content.append(powerComponents(components));
            return content;
        }
        const controls = node('div', undefined, 'power-controls');
        controls.setAttribute('role', 'group');
        controls.setAttribute('aria-label', strings.powerDisplay);
        const detail = node('button', strings.powerDetails), chart = node('button', strings.distribution);
        detail.type = chart.type = 'button';
        controls.append(detail, chart);
        const display = node('div');
        const update = () => {
            detail.setAttribute('aria-pressed', String(powerMode === 'details'));
            chart.setAttribute('aria-pressed', String(powerMode === 'distribution'));
            if (powerMode === 'distribution') display.replaceChildren(...groups.map(powerBar));
            else display.replaceChildren(...(components.length ? [powerComponents(components)] : []));
        };
        detail.onclick = () => { powerMode = 'details'; remember(); update(); };
        chart.onclick = () => { powerMode = 'distribution'; remember(); update(); };
        update();
        content.append(controls, display);
        return content;
    }

    function drcView({ total, counts, rules }) {
        const body = node('div', undefined, 'drc-results');
        const heading = node('div', undefined, 'drc-count');
        const severity = counts.errors || counts.criticalWarnings ? 'negative' : total ? 'warning' : 'positive';
        heading.append(node('strong', countText.format(total), 'drc-total ' + severity), node('span', strings.violations, 'muted'));
        body.append(heading);
        if (!total) {
            body.append(node('p', strings.noViolations, 'muted'));
            return body;
        }
        const severities = node('dl', undefined, 'drc-severities');
        for (const key of Object.keys(strings.severities)) {
            if (!counts[key] && (key === 'advisories' || key === 'other')) continue;
            const item = node('div');
            item.append(node('dt', strings.severities[key]), node('dd', countText.format(counts[key] || 0), 'numbers'));
            severities.append(item);
        }
        body.append(severities);
        if (rules.length) {
            const list = node('ul', undefined, 'drc-rules');
            for (const { rule, level, count } of rules) {
                const item = node('li');
                item.append(node('code', rule), node('span', strings.severities[level], 'muted'), node('strong', countText.format(count), 'numbers'));
                list.append(item);
            }
            body.append(list);
        }
        return body;
    }

    function drawAnalysis(analysis) {
        drawUtilization(analysis?.results?.utilization, analysis?.details);
        drawTiming(analysis?.results?.timing);
        const cards = [['power', 'noPower', powerView], ['drc', 'noDrc', drcView]];
        for (const [kind, empty, renderCard] of cards) {
            const result = analysis?.results?.[kind];
            $(kind).replaceChildren(...(result ? [reportSource(kind, result), renderCard(result.data)] : [node('p', strings[empty], 'empty')]));
        }
        $('generate').hidden = !analysis?.generation;
        $('generate').title = analysis?.generation ? phrase('generateFor', analysis.generation.run) : '';
    }

    function status(text, kind = '', busy = false) {
        const notice = $('status');
        if (notice.textContent !== text) notice.textContent = text;
        notice.className = kind;
        $('refresh').disabled = busy;
        $('generate').disabled = busy;
    }

    function render(next, at) {
        const snapshot = JSON.stringify(next);
        if (snapshot !== signature) {
            signature = snapshot;
            const runs = next.runs || [];
            const synthesis = currentRun(runs, next.currentRuns?.synthesis, false);
            const implementation = currentRun(runs, next.currentRuns?.implementation, true);
            drawProject(next.project || {});
            drawCards(synthesis, implementation, next.runMessages);
            drawAnalysis(next.analysis);
            drawRuns(runs, next.paths, [synthesis?.id, implementation?.id]);
            syncMessageRuns(runs);
            listMessages(messagePage?.offset || 0);
        }
        $('content').hidden = false;
        $('updated').textContent = phrase('updated', new Date(at).toLocaleTimeString(strings.locale, { hour12: false }));
        status('');
    }

    $('auto').checked = auto;
    $('auto').onchange = () => {
        auto = $('auto').checked;
        remember();
        vscode.postMessage({ action: 'auto', enabled: auto });
    };
    $('refresh').onclick = () => vscode.postMessage({ action: 'refresh' });
    $('generate').onclick = () => vscode.postMessage({ action: 'generate' });
    $('folder').onclick = () => vscode.postMessage({ action: 'openFolder' });
    $('message-run').onchange = $('message-level').onchange = () => listMessages(0, true);
    $('message-level').replaceChildren(option(strings.allSeverities, ''), ...Object.entries(severityLabels).map(([id, label]) => option(label, id)));
    $('message-search').oninput = () => {
        clearTimeout(messageTimer);
        messageTimer = setTimeout(() => listMessages(0, true), 160);
    };
    $('message-prev').onclick = () => { if (messagePage) listMessages(Math.max(0, messagePage.offset - messagePage.size)); };
    $('message-next').onclick = () => { if (messagePage) listMessages(messagePage.offset + messagePage.items.length); };
    $('toggle-message-groups').onclick = () => {
        const groups = [...visibleGroups.values()];
        const expand = groups.some(group => !group.details.open);
        for (const { details } of groups) details.open = expand;
        syncMessageGroupToggle();
    };
    window.addEventListener('message', ({ data: message }) => {
        if (message?.type === 'summary') render(message.data, message.at);
        else if (message?.type === 'focusReport' && ['utilization', 'timing'].includes(message.section)) {
            const heading = $(message.section + '-title');
            heading.focus();
            heading.scrollIntoView({ block: 'start' });
        }
        else if (message?.type === 'runMessages' && message.request === messageRequest) drawMessages(message);
        else if (message?.type === 'messageGroup') visibleGroups.get(messageGroupKey(message))?.receive(message);
        else if (message?.type === 'loading') status(strings.refreshing, '', true);
        else if (message?.type === 'generating') status(strings.generating, '', true);
        else if (message?.type === 'error') status(message.message, message.busy ? 'warning' : 'negative');
        else if (message?.type === 'reset') {
            signature = undefined;
            clearTimeout(messageTimer);
            messageRequest++;
            messagePage = runOptionsKey = undefined;
            expandedRuns.clear();
            visibleGroups.clear();
            expandedMessageGroups.clear();
            syncMessageGroupToggle();
            $('message-run').value = $('message-level').value = $('message-search').value = '';
            $('messages').replaceChildren();
            $('message-status').textContent = '';
            $('message-pages').hidden = true;
            $('project').textContent = strings.title;
            $('directory').hidden = true;
            $('content').hidden = true;
            $('updated').textContent = '';
            status(strings.loading, '', true);
        }
    });
    status(strings.loading, '', true);
    vscode.postMessage({ action: 'ready', auto });
})();
