/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), $ = id => document.getElementById(id);
    const strings = JSON.parse($('summary-strings').textContent);
    const phrase = (key, ...values) => strings[key].replace(/\{(\d+)\}/gu, (_, index) => values[index]);
    const countText = new Intl.NumberFormat(strings.locale, { maximumFractionDigits: 2 });
    const powerText = new Intl.NumberFormat(strings.locale, { minimumFractionDigits: 3, maximumFractionDigits: 6 });
    const preferences = vscode.getState() || {};
    let signature, auto = preferences.auto !== false, powerMode = preferences.powerMode === 'pie' ? 'pie' : 'details';
    const remember = () => vscode.setState({ auto, powerMode });

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

    function drawCards(synthesis, implementation) {
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
            card.append(details, progressMeter(run));
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
        $('runs').replaceChildren(...runs.map(run => {
            const row = node('tr');
            const identity = node('th');
            identity.scope = 'row';
            identity.append(node('span', run.id, 'run-name'));
            const detail = [run.implementation ? strings.implementation : strings.synthesis, primary.includes(run.id) ? strings.current : '', run.strategy].filter(Boolean);
            identity.append(node('span', detail.join(' · '), 'run-detail'));
            const state = node('td', undefined, 'run-state');
            state.append(statusBadge(run));
            if (run.needsRefresh) state.append(staleBadge());
            if (run.step) state.append(node('span', run.step, 'run-detail'));
            const progress = node('td', undefined, 'progress-cell');
            progress.append(progressMeter(run));
            if (run.elapsed) progress.append(node('span', run.elapsed, 'run-detail'));
            const actions = node('td', undefined, 'run-actions');
            const output = paths && Object.hasOwn(paths, run.id) ? paths[run.id] : null;
            if (output?.log) actions.append(runAction(run, 'log', strings.log));
            if (output?.directory) actions.append(runAction(run, 'directory', strings.directory));
            if (!actions.children.length) actions.textContent = '—';
            row.append(identity, state, progress, actions);
            return row;
        }));
        $('run-count').textContent = runs.length ? phrase('runCount', runs.length) : '';
        $('run-table').hidden = !runs.length;
        $('runs-empty').hidden = Boolean(runs.length);
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

    function drawMessages(messages = {}) {
        const items = [[strings.errors, messages.errors || 0, 'negative'], [strings.warnings, messages.warnings || 0, 'warning']];
        $('messages').replaceChildren(...items.map(([label, count, kind]) => {
            const item = node('div');
            item.append(node('dt', label), node('dd', String(count), count ? kind : ''));
            return item;
        }));
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

    function drawUtilization(data = {}) {
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

    function powerSlices(data) {
        const hasValues = items => items.filter(item => Number.isFinite(item.watts) && item.watts > 0);
        const components = hasValues(data.components || []);
        let slices = components.map(item => ({ label: componentName(item.label), watts: item.watts }));
        if (!slices.length || (data.dynamic > 0 && data.static > 0 && components.every(item => /^static power$/iu.test(item.label)))) slices = hasValues([
            { label: strings.dynamic, watts: data.dynamic }, { label: strings.static, watts: data.static }
        ]);
        if (!slices.length || !(data.total > 0)) return [];
        const known = slices.reduce((total, item) => total + item.watts, 0);
        if (data.total - known > 1e-9) slices.push({ label: strings.unallocated, watts: data.total - known, color: '#7c8794' });
        return slices.map((item, index) => ({ ...item, color: item.color || powerColors[index % powerColors.length] }));
    }

    function powerPie(slices, total) {
        const body = node('div', undefined, 'power-chart');
        const pie = node('div', undefined, 'power-pie');
        pie.setAttribute('aria-hidden', 'true');
        const legend = node('ul', undefined, 'power-legend');
        legend.setAttribute('aria-label', strings.components);
        const sum = slices.reduce((amount, item) => amount + item.watts, 0);
        let angle = 0;
        const stops = slices.map(({ label, watts, color }, index) => {
            const start = angle;
            angle = index === slices.length - 1 ? 100 : angle + watts / sum * 100;
            const item = node('li');
            const swatch = node('span', undefined, 'power-swatch');
            swatch.style.backgroundColor = color;
            swatch.setAttribute('aria-hidden', 'true');
            item.append(swatch, node('span', label), node('span', powerText.format(watts) + ' W · ' + percentText(watts / sum * 100), 'numbers'));
            legend.append(item);
            return color + ' ' + start + '% ' + angle + '%';
        });
        pie.style.background = 'conic-gradient(' + stops.join(', ') + ')';
        body.append(pie, legend);
        if (sum - total > 1e-9) body.append(node('p', strings.roundedShares, 'muted power-note'));
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
        const slices = powerSlices(data), components = data.components || [];
        if (!slices.length) {
            if (components.length) content.append(powerComponents(components));
            return content;
        }
        const controls = node('div', undefined, 'power-controls');
        controls.setAttribute('role', 'group');
        controls.setAttribute('aria-label', strings.powerDisplay);
        const detail = node('button', strings.powerDetails), chart = node('button', strings.pie);
        detail.type = chart.type = 'button';
        controls.append(detail, chart);
        const display = node('div');
        const update = () => {
            detail.setAttribute('aria-pressed', String(powerMode === 'details'));
            chart.setAttribute('aria-pressed', String(powerMode === 'pie'));
            if (powerMode === 'pie') display.replaceChildren(powerPie(slices, data.total));
            else display.replaceChildren(...(components.length ? [powerComponents(components)] : []));
        };
        detail.onclick = () => { powerMode = 'details'; remember(); update(); };
        chart.onclick = () => { powerMode = 'pie'; remember(); update(); };
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
        drawUtilization(analysis?.results?.utilization);
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
            drawCards(synthesis, implementation);
            drawAnalysis(next.analysis);
            drawMessages(next.messages);
            drawRuns(runs, next.paths, [synthesis?.id, implementation?.id]);
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
    window.addEventListener('message', ({ data: message }) => {
        if (message?.type === 'summary') render(message.data, message.at);
        else if (message?.type === 'loading') status(strings.refreshing, '', true);
        else if (message?.type === 'generating') status(strings.generating, '', true);
        else if (message?.type === 'error') status(message.message, message.busy ? 'warning' : 'negative');
        else if (message?.type === 'reset') {
            signature = undefined;
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
