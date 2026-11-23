/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), $ = id => document.getElementById(id);
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
        if (!run) return ['idle', '无当前运行'];
        const status = run.status || '';
        if (/fail|error/i.test(status)) return ['bad', '失败'];
        if (/cancel|abort|stopped/i.test(status)) return ['bad', '已停止'];
        if (/queued/i.test(status)) return ['busy', '排队中'];
        if (/running|in progress/i.test(status) || /running/i.test(run.progress)) return ['busy', '运行中'];
        if (/complete|finished/i.test(status)) return ['ok', '已完成'];
        if (/not started/i.test(status)) return ['idle', '未开始'];
        return ['idle', status && status !== 'Unknown' ? status : '状态未知'];
    }

    function statusBadge(run) {
        const [kind, label] = statusOf(run);
        const badge = node('span', label, 'chip ' + kind);
        badge.title = run?.status || '';
        return badge;
    }

    function staleBadge() {
        return node('span', '待重跑', 'chip warn');
    }

    function progressMeter(run) {
        const value = progressValue(run?.progress);
        const result = node('div', undefined, 'run-progress');
        if (value !== null) {
            const bar = node('progress', undefined, 'bar ' + statusOf(run)[0]);
            bar.max = 100;
            bar.value = value;
            bar.setAttribute('aria-label', '运行进度');
            result.append(bar, node('span', value + '%', 'percentage'));
        } else {
            result.append(node('span', statusOf(run)[0] === 'busy' ? '等待进度' : run?.progress || '—', 'muted'));
        }
        return result;
    }

    function drawProject(project) {
        $('project').textContent = project.name || '工程概览';
        const directory = $('directory');
        directory.textContent = directory.title = project.directory || '';
        directory.hidden = !project.directory;
        const facts = [['器件', project.part], ['顶层模块', project.top]];
        if (project.board) facts.push(['板卡', project.board]);
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
        const stages = [['综合', synthesis], ['布局布线', implementation]];
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
        action.setAttribute('aria-label', '打开 ' + run.id + ' 的' + label);
        action.onclick = () => vscode.postMessage({ action: 'openRun', run: run.id, kind });
        return action;
    }

    function drawRuns(runs, paths, primary) {
        $('runs').replaceChildren(...runs.map(run => {
            const row = node('tr');
            const identity = node('th');
            identity.scope = 'row';
            identity.append(node('span', run.id, 'run-name'));
            const detail = [run.implementation ? '布局布线' : '综合', primary.includes(run.id) ? '当前运行' : '', run.strategy].filter(Boolean);
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
            if (output?.log) actions.append(runAction(run, 'log', '日志'));
            if (output?.directory) actions.append(runAction(run, 'directory', '目录'));
            if (!actions.children.length) actions.textContent = '—';
            row.append(identity, state, progress, actions);
            return row;
        }));
        $('run-count').textContent = runs.length ? runs.length + ' 项' : '';
        $('run-table').hidden = !runs.length;
        $('runs-empty').hidden = Boolean(runs.length);
    }

    function drawTiming(run) {
        const { wns, tns, whs, ths } = run?.timing || {};
        const items = [['WNS', wns, 'ns'], ['TNS', tns, 'ns'], ['WHS', whs, 'ns'], ['THS', ths, 'ns'], ['总功耗', run?.power, 'W']];
        const hasResults = items.some(([, value]) => Number.isFinite(value));
        $('timing-source').textContent = hasResults ? run.id + (run.needsRefresh ? ' · 待重跑' : '') : '';
        if (!hasResults) {
            $('timing').replaceChildren(node('p', '当前运行暂无时序与功耗结果。', 'empty'));
            return;
        }
        const metrics = node('dl', undefined, 'metrics');
        for (const [label, value, unit] of items) {
            const item = node('div', undefined, 'metric');
            const display = numberText(value);
            item.append(node('dt', label), node('dd', display === '—' ? display : display + ' ' + unit,
                unit === 'ns' && value < 0 ? 'negative' : ''));
            metrics.append(item);
        }
        $('timing').replaceChildren(metrics);
    }

    function drawMessages(messages = {}) {
        const items = [['错误', messages.errors || 0, 'negative'], ['警告', messages.warnings || 0, 'warning']];
        $('messages').replaceChildren(...items.map(([label, count, kind]) => {
            const item = node('div');
            item.append(node('dt', label), node('dd', String(count), count ? kind : ''));
            return item;
        }));
    }

    function status(text, kind = '', busy = false) {
        const notice = $('status');
        if (notice.textContent !== text) notice.textContent = text;
        notice.className = kind;
        $('refresh').disabled = busy;
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
            drawTiming(implementation || synthesis);
            drawMessages(next.messages);
            drawRuns(runs, next.paths, [synthesis?.id, implementation?.id]);
        }
        $('content').hidden = false;
        $('updated').textContent = '更新于 ' + new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
        status('');
    }

    $('auto').checked = auto;
    $('auto').onchange = () => {
        auto = $('auto').checked;
        vscode.setState({ auto });
        vscode.postMessage({ action: 'auto', enabled: auto });
    };
    $('refresh').onclick = () => vscode.postMessage({ action: 'refresh' });
    $('folder').onclick = () => vscode.postMessage({ action: 'openFolder' });
    window.addEventListener('message', ({ data: message }) => {
        if (message?.type === 'summary') render(message.data, message.at);
        else if (message?.type === 'loading') status('正在刷新…', '', true);
        else if (message?.type === 'error') status(message.message, message.busy ? 'warning' : 'negative');
        else if (message?.type === 'reset') {
            signature = undefined;
            $('project').textContent = '工程概览';
            $('directory').hidden = true;
            $('content').hidden = true;
            $('updated').textContent = '';
            status('正在读取工程状态…', '', true);
        }
    });
    status('正在读取工程状态…', '', true);
    vscode.postMessage({ action: 'ready', auto });
})();
