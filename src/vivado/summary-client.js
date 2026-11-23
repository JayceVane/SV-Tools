/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), $ = id => document.getElementById(id);
    const strings = JSON.parse($('summary-strings').textContent);
    const phrase = (key, ...values) => strings[key].replace(/\{(\d+)\}/gu, (_, index) => values[index]);
    const countText = new Intl.NumberFormat(strings.locale, { maximumFractionDigits: 2 });
    const powerText = new Intl.NumberFormat(strings.locale, { minimumFractionDigits: 3, maximumFractionDigits: 6 });
    let signature, auto = vscode.getState()?.auto !== false;

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

    function drawTiming(run) {
        const { wns, tns, whs, ths } = run?.timing || {};
        const items = [['WNS', wns], ['TNS', tns], ['WHS', whs], ['THS', ths]];
        const hasResults = items.some(([, value]) => Number.isFinite(value));
        $('timing-source').textContent = hasResults ? [run.id, run.needsRefresh && strings.stale].filter(Boolean).join(' · ') : '';
        if (!hasResults) {
            $('timing').replaceChildren(node('p', strings.emptyTiming, 'empty'));
            return;
        }
        const metrics = node('dl', undefined, 'metrics');
        for (const [label, value] of items) {
            const item = node('div', undefined, 'metric');
            const display = numberText(value);
            item.append(node('dt', label), node('dd', display === '—' ? display : display + ' ns', value < 0 ? 'negative' : ''));
            metrics.append(item);
        }
        $('timing').replaceChildren(metrics);
    }

    function drawMessages(messages = {}) {
        const items = [[strings.errors, messages.errors || 0, 'negative'], [strings.warnings, messages.warnings || 0, 'warning']];
        $('messages').replaceChildren(...items.map(([label, count, kind]) => {
            const item = node('div');
            item.append(node('dt', label), node('dd', String(count), count ? kind : ''));
            return item;
        }));
    }

    function reportSource(kind, result) {
        const source = node('div', undefined, 'report-source');
        source.append(node('span', [result.run, strings.phases[result.phase], result.stale && strings.stale].filter(Boolean).join(' · ')));
        if (result.file) {
            const button = node('button', strings.report, 'link-button');
            button.type = 'button';
            button.setAttribute('aria-label', phrase('reportFor', strings[kind]));
            button.onclick = () => vscode.postMessage({ action: 'openReport', kind });
            source.append(button);
        }
        return source;
    }

    function utilizationView(resources) {
        const list = node('dl', undefined, 'resource-list');
        for (const { resource, used, available } of resources) {
            const name = strings.resources[resource] || resource;
            const value = available > 0 ? used / available * 100 : null;
            const item = node('div', undefined, 'resource-item');
            const counts = node('dd', countText.format(used) + ' / ' + countText.format(available), 'numbers');
            counts.title = phrase('used', countText.format(used), countText.format(available));
            item.append(node('dt', name), counts);
            const meter = node('div', undefined, 'resource-meter');
            if (value !== null) {
                const bar = node('progress', undefined, 'bar');
                bar.max = 100;
                bar.value = Math.min(100, value);
                bar.setAttribute('aria-label', name);
                const percent = value > 0 && value < 0.01 ? '<0.01%' : countText.format(value) + '%';
                meter.append(bar, node('span', percent, 'percentage'));
            }
            item.append(meter);
            list.append(item);
        }
        return list;
    }

    function powerView(data) {
        const values = node('dl', undefined, 'power-values');
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
        return values;
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
        const cards = [['utilization', 'noUtilization', utilizationView], ['power', 'noPower', powerView], ['drc', 'noDrc', drcView]];
        for (const [kind, empty, renderCard] of cards) {
            const result = analysis?.results?.[kind];
            $(kind).replaceChildren(...(result ? [reportSource(kind, result), renderCard(result.data)] : [node('p', strings[empty], 'empty')]));
        }
        $('generate').hidden = !analysis?.generation;
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
            drawTiming(implementation || synthesis);
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
        vscode.setState({ auto });
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
