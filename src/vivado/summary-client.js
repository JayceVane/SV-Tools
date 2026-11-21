/* global acquireVsCodeApi */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), $ = id => document.getElementById(id);
    let data, auto = vscode.getState()?.auto !== false;

    function node(tag, text, className) {
        const item = document.createElement(tag);
        if (text !== undefined) item.textContent = text;
        if (className) item.className = className;
        return item;
    }
    const timeText = at => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
    const statusKind = status => /complete|100%/i.test(status) ? 'ok' : /error|fail|stopped/i.test(status) ? 'bad'
        : /queued|running/i.test(status) ? 'busy' : 'idle';
    const progressValue = progress => {
        const match = /(\d+)%/.exec(progress || '');
        return match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
    };
    const fmt = value => value === null || value === undefined ? '—' : (Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(3));

    function statusCell(status) {
        const cell = node('td');
        const chip = node('span', status || 'Unknown', 'chip ' + statusKind(status));
        cell.append(chip);
        return cell;
    }
    function progressCell(progress) {
        const cell = node('td', undefined, 'progress-cell');
        const value = progressValue(progress);
        if (value === null) { cell.textContent = progress || '—'; return cell; }
        const bar = node('span', undefined, 'bar');
        const fill = node('span', undefined, 'fill');
        fill.style.width = value + '%';
        bar.append(fill);
        cell.append(bar, node('span', progress, 'muted'));
        return cell;
    }

    function drawCards(runs) {
        const cards = $('cards');
        const groups = [
            { label: '综合', run: runs.find(run => !run.implementation) },
            { label: '实现', run: runs.find(run => run.implementation) }
        ];
        cards.replaceChildren(...groups.filter(group => group.run).map(({ label, run }) => {
            const card = node('article', undefined, 'card ' + statusKind(run.status));
            const head = node('header');
            head.append(node('h2', label), node('span', run.status, 'chip ' + statusKind(run.status)));
            const value = progressValue(run.progress);
            const bar = node('div', undefined, 'bar big');
            const fill = node('div', undefined, 'fill');
            fill.style.width = (value === null ? 0 : value) + '%';
            bar.append(fill);
            const detail = node('p', [run.progress || '—', run.step ? '步骤 ' + run.step : '', run.elapsed ? '耗时 ' + run.elapsed : '']
                .filter(Boolean).join(' · '), 'muted');
            card.append(head, bar, detail);
            return card;
        }));
        cards.hidden = !cards.children.length;
    }

    function drawRuns(runs, paths) {
        const body = $('runs');
        body.replaceChildren(...runs.map(run => {
            const row = node('tr');
            row.append(node('td', run.id), node('td', run.implementation ? '实现' : '综合'));
            row.append(statusCell(run.status), progressCell(run.progress));
            row.append(node('td', run.step || '—'), node('td', run.elapsed || '—'), node('td', run.strategy || '—', 'muted'));
            const action = node('td');
            const info = paths?.[run.id];
            if (info) {
                const open = node('button', '日志');
                open.type = 'button';
                open.title = info.log;
                open.onclick = () => vscode.postMessage({ action: 'openLog', path: info.log });
                action.append(open);
            }
            row.append(action);
            return row;
        }));
        $('runs-empty').hidden = runs.length > 0;
    }

    function drawTiming(runs) {
        const target = runs.filter(run => run.implementation && run.timing && Object.values(run.timing).some(value => value !== null))
            .pop() || runs.find(run => run.timing && Object.values(run.timing).some(value => value !== null));
        const container = $('timing');
        if (!target) {
            container.replaceChildren(node('p', '尚无时序结果。完成实现后显示 WNS/TNS/WHS/THS 与功耗。', 'muted'));
            return;
        }
        const items = [
            ['WNS', target.timing.wns, 'ns'], ['TNS', target.timing.tns, 'ns'],
            ['WHS', target.timing.whs, 'ns'], ['THS', target.timing.ths, 'ns'],
            ['功耗', target.power, 'W']
        ];
        container.replaceChildren(...items.map(([label, value, unit]) => {
            const item = node('div', 'timing-item');
            const number = fmt(value);
            const negative = (label === 'WNS' || label === 'WHS') && typeof value === 'number' && value < 0;
            item.append(node('strong', number === '—' ? '—' : number + ' ' + unit, negative ? 'value bad' : 'value'),
                node('span', label, 'muted'));
            return item;
        }), node('p', '来自 ' + target.id + ' 的报告属性；完整报告见 run 日志。', 'muted'));
    }

    function drawMessages(messages) {
        const container = $('messages');
        const errors = messages?.errors || 0, warnings = messages?.warnings || 0;
        container.replaceChildren(
            node('span', errors + ' 个 Error', errors ? 'chip bad' : 'chip ok'),
            node('span', warnings + ' 个 Warning', warnings ? 'chip warn' : 'chip ok'),
            node('span', errors || warnings ? '消息来自当前工程会话，详细内容见 Vivado 输出通道。' : '当前工程没有 Error/Warning 消息。', 'muted'));
    }

    function render(next, at) {
        data = next;
        const project = next.project || {};
        $('project').textContent = project.name || 'Vivado 工程概览';
        $('meta').textContent = [project.part && '器件 ' + project.part, project.top && '顶层 ' + project.top,
            project.board && '板卡 ' + project.board, project.directory].filter(Boolean).join(' · ');
        $('meta').title = project.directory || '';
        drawCards(next.runs || []);
        drawRuns(next.runs || [], next.paths);
        drawTiming(next.runs || []);
        drawMessages(next.messages);
        $('status').textContent = '最近读取 ' + timeText(at);
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
        else if (message?.type === 'error') $('status').textContent = message.message;
    });
    $('status').textContent = '正在读取工程状态…';
    vscode.postMessage({ action: 'ready' });
})();
