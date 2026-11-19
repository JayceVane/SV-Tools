/* global acquireVsCodeApi */
'use strict';

(() => {
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const set = (id, value) => { $(id).textContent = value; };
    const observations = new Map(), samples = new Map();
    let snapshot, currentRule, currentStep = 0, visible = false, revision = 0, interaction = 0, revealScroll;
    const saved = vscode.getState() || {};
    const visited = new Map();
    const send = (type, token) => vscode.postMessage({ type, revision, token, interaction });
    const currentEvent = () => currentRule?.events[currentStep];

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    }
    function button(label, action) {
        const node = element('button', label);
        node.type = 'button';
        node.onclick = action;
        return node;
    }
    function linkButtons(refs) {
        return refs.map(ref => button(ref.label, () => send('open', ref.token)));
    }
    function status(message) {
        set('status', message);
        $('status').hidden = !message;
    }
    const formats = { bits: '位串', unsigned: '无符号十进制', signed: '有符号十进制' };
    function expectedValue(item) {
        return item.value + '（' + formats[item.encoding] + '）';
    }
    function hideResults() {
        interaction++;
        visible = false;
        revealScroll = undefined;
        observations.clear();
        samples.clear();
        $('observed').replaceChildren();
        $('observed').hidden = true;
        $('reveal').setAttribute('aria-expanded', 'false');
        set('reveal', '查看实际结果');
    }
    function renderInterfaces(event) {
        const interfaces = (event.interfaces || []).map(id => currentRule.interfaces.find(item => item.id === id));
        const labels = { compatible: '约定相容', mismatch: '约定不一致', unresolved: '约定待确认' };
        $('interface-review').hidden = interfaces.length === 0;
        $('interfaces').replaceChildren(...interfaces.map(item => {
            const section = element('details', undefined, 'interface-card');
            section.open = interfaces.length === 1;
            const summary = element('summary', item.title);
            const endpoints = element('div', undefined, 'interface-ends');
            for (const [heading, side] of [['上游保证', item.from], ['下游前提', item.to]]) {
                const endpoint = element('section');
                endpoint.append(element('h4', heading + ' · ' + side.module), element('p', side.expectation));
                const links = element('div', undefined, 'evidence-links');
                links.append(...linkButtons(side.refs));
                endpoint.append(links);
                endpoints.append(endpoint);
            }
            const assessment = element('details', undefined, 'interface-assessment');
            const badge = element('strong', labels[item.status], 'interface-status');
            badge.dataset.status = item.status;
            assessment.append(element('summary', '查看讲解判断'), badge, element('p', item.rationale, 'interface-reason'));
            section.append(summary, endpoints, assessment);
            return section;
        }));
    }
    function renderChanges(rule) {
        const changes = rule.changes || [];
        const kinds = { contract: '接口约定', implementation: '实现', verification: '验证' };
        $('change-review').hidden = changes.length === 0;
        $('changes').replaceChildren(...changes.map(change => {
            const card = element('details', undefined, 'change-card');
            const summary = element('summary', change.title);
            const comparison = element('dl');
            comparison.append(element('dt', change.from), element('dd', change.before),
                element('dt', change.to), element('dd', change.after));
            const impacts = element('ul', undefined, 'change-impacts');
            for (const impact of change.impacts) {
                const index = rule.events.findIndex(event => event.id === impact.event);
                const item = element('li');
                item.append(button(rule.events[index].title, () => selectStep(index, true)), element('p', impact.note));
                impacts.append(item);
            }
            const links = element('div', undefined, 'evidence-links');
            links.append(...change.sourceDiffs.map(diff => button(diff.label, () => send('diff', diff.token))));
            card.append(summary, element('p', kinds[change.kind], 'muted'), comparison, impacts, links);
            return card;
        }));
    }
    function renderStep(focusStep = false) {
        hideResults();
        const event = currentEvent();
        $('previous').disabled = currentStep === 0;
        $('next').disabled = currentStep === currentRule.events.length - 1;
        const steps = currentRule.events.map((step, index) => {
            const node = button(step.title, () => selectStep(index, true));
            if (index === currentStep) node.setAttribute('aria-current', 'step');
            return node;
        });
        $('steps').replaceChildren(...steps);
        $('flow').replaceChildren(...event.flow.map(item => {
            const node = element('li', undefined, item.active ? 'active' : '');
            if (item.active) node.setAttribute('aria-current', 'step');
            node.append(element('strong', item.label), element('span', item.detail));
            return node;
        }));
        set('expected', event.expected);
        const expectations = event.expectedValues || [];
        $('expected-values').hidden = !expectations.length;
        $('expected-values').replaceChildren(...expectations.map(item =>
            element('li', item.label + ' · ' + expectedValue(item))));
        $('step-links').replaceChildren(...linkButtons(event.refs));
        renderInterfaces(event);
        if (focusStep) steps[currentStep].focus();
    }
    function selectStep(index, focusStep) {
        if (!currentRule || index < 0 || index >= currentRule.events.length || index === currentStep) return;
        currentStep = index;
        renderStep(focusStep);
        save();
    }
    function save() {
        saved.rule = currentRule.id;
        saved.event = currentEvent().id;
        visited.set(saved.rule, saved.event);
        vscode.setState(saved);
    }
    function selectRule(rule, eventId, restoreFocus = false) {
        currentRule = rule;
        currentStep = Math.max(0, rule.events.findIndex(item => item.id === eventId));
        const items = snapshot.rules.map(item => {
            const node = button(item.title, () => selectRule(item, visited.get(item.id), true));
            if (item.id === rule.id) node.setAttribute('aria-current', 'true');
            return node;
        });
        const groups = new Map();
        snapshot.rules.forEach((item, index) => {
            const group = item.group || '';
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(items[index]);
        });
        $('rules').replaceChildren(...[...groups].flatMap(([group, buttons]) =>
            group ? [element('h3', group, 'rule-group'), ...buttons] : buttons));
        set('module', rule.module);
        set('rule-title', rule.title);
        $('frozen-note').hidden = !rule.note;
        $('frozen-note').replaceChildren(...(rule.note ? [
            button('打开定版 Note', () => send('note', rule.note.token)),
            element('span', rule.note.id, 'muted')
        ] : []));
        set('contract', rule.contract);
        set('mechanism', rule.mechanism);
        set('stimulus', rule.stimulus);
        set('checker', rule.checker);
        renderChanges(rule);
        renderStep();
        if (restoreFocus) items[snapshot.rules.indexOf(rule)].focus();
        save();
    }
    function sampleTable(sample) {
        if (!sample) return element('p', '正在读取波形采样…', 'muted');
        if (sample.error) return element('p', '波形采样不可用：' + sample.error, 'muted');
        const table = element('table');
        const checks = new Map((sample.checks || []).map(item => [item.signal, item]));
        table.append(element('caption', (checks.size ? '采样点对照' : '记录值') + ' · ' + sample.time));
        if (checks.size) {
            table.className = 'sample-comparison';
            const headers = element('thead'), row = element('tr');
            for (const heading of ['信号', '预期', '实际', '对照']) {
                const col = element('th', heading);
                col.scope = 'col';
                row.append(col);
            }
            headers.append(row);
            table.append(headers);
        }
        const body = element('tbody');
        const names = Object.keys(sample.values).map(signal => signal.split('.').at(-1));
        for (const [signal, value] of Object.entries(sample.values)) {
            const check = checks.get(signal);
            const row = element('tr');
            const leaf = signal.split('.').at(-1);
            const name = element('th', names.filter(item => item === leaf).length === 1 ? leaf : signal);
            name.title = signal;
            name.scope = 'row';
            const shown = value?.value ?? value?.hex ?? value?.bits ?? '无记录';
            const actual = element('td', check?.actual ?? (value?.signed ? shown + '（有符号 ' + value.signed + '）' : shown));
            if (check?.actual !== undefined) actual.title = '波形表示：' + shown;
            row.append(name);
            if (checks.size) {
                const labels = { match: '一致', mismatch: '不一致', unknown: '值含 X/Z',
                    missing: '无记录', invalid: '预期不符合位宽', unavailable: '不可比较' };
                const verdict = element('td', check ? labels[check.status] : '—', 'sample-check');
                if (check) verdict.dataset.status = check.status;
                row.append(element('td', check ? expectedValue(check.expected) : '—'), actual, verdict);
            } else row.append(actual);
            body.append(row);
        }
        table.append(body);
        return table;
    }
    function renderObservations() {
        if (!visible) return;
        const labels = { passed: '当前检查通过', failed: '当前检查失败', not_triggered: '目标场景未触发',
            inconclusive: '证据不足', pending_review: '待审阅', unavailable: '证据不可用' };
        const before = document.activeElement?.dataset?.reviewLink;
        const sections = currentRule.variants.map(variant => {
            const section = element('section', undefined, 'run');
            section.append(element('h4', variant.label));
            const item = currentEvent().evidence.find(entry => entry.variant === variant.id);
            if (!item) {
                section.append(element('p', '此事件尚无该候选的观察。', 'muted'));
                return section;
            }
            const obs = observations.get(item.token);
            if (!obs) {
                section.append(element('p', '正在核对候选与证据…', 'muted'));
                return section;
            }
            const label = element('strong', labels[obs.status], 'result');
            label.dataset.status = obs.status;
            section.append(label, element('p', obs.text));
            if (obs.issues?.length) {
                const reasons = { changed: '内容已变更', missing: '文件缺失', unavailable: '无法核验', anchor: '源码锚点不匹配',
                    'run-input': '与仿真运行的输入不符', 'run-artifact': '与仿真运行的产物不符' };
                const issueList = element('ul', undefined, 'review-issues');
                for (const issue of obs.issues)
                    issueList.append(element('li', issue.label + ' · ' + reasons[issue.reason] + '（' + issue.path + '）'));
                section.append(issueList);
            } else {
                section.append(element('small', '来源：导入的运行摘要', 'muted'));
            }
            const links = element('div', undefined, 'evidence-links');
            const buttons = linkButtons(obs.refs);
            buttons.forEach((node, index) => { node.dataset.reviewLink = obs.refs[index].token; });
            links.append(...buttons);
            section.append(links);
            for (const ref of obs.refs.filter(ref => ref.hasSample)) section.append(sampleTable(samples.get(ref.token)));
            return section;
        });
        $('observed').replaceChildren(...sections);
        if (before) [...$('observed').querySelectorAll('[data-review-link]')]
            .find(node => node.dataset.reviewLink === before)?.focus();
        if (revealScroll !== undefined && currentEvent().evidence.every(item =>
            observations.get(item.token)?.refs.every(ref => !ref.hasSample || samples.has(ref.token)))) {
            const beforeLoad = revealScroll;
            revealScroll = undefined;
            // 实际对照是异步加载的。如果读者已滚动，保留其当前阅读位置。
            if (document.scrollingElement?.scrollTop === beforeLoad)
                $('verification-title').scrollIntoView({ block: 'start' });
        }
    }
    $('previous').onclick = () => selectStep(currentStep - 1, true);
    $('next').onclick = () => selectStep(currentStep + 1, true);
    $('refresh').onclick = () => send('refresh');
    $('reveal').onclick = () => {
        if (visible) { hideResults(); return; }
        visible = true;
        $('observed').hidden = false;
        $('reveal').setAttribute('aria-expanded', 'true');
        set('reveal', '收起实际结果');
        renderObservations();
        $('verification-title').scrollIntoView({ block: 'start' });
        revealScroll = document.scrollingElement?.scrollTop;
        for (const item of currentEvent().evidence) send('observation', item.token);
    };
    window.addEventListener('message', ({ data }) => {
        if (!data || data.revision < revision) return;
        if (data.type === 'loading') {
            revision = data.revision;
            hideResults();
            $('content').hidden = true;
            status('正在读取设计讲解…');
        } else if (data.type === 'load-error') {
            status(data.text);
        } else if (data.type === 'review') {
            snapshot = data;
            revision = data.revision;
            set('title', data.title);
            status(data.message || '');
            $('content').hidden = false;
            const rule = data.rules.find(item => item.id === (data.focusRule || saved.rule)) || data.rules[0];
            selectRule(rule, visited.get(rule.id));
        } else if (data.revision === revision && data.interaction === interaction && data.type === 'observation' && visible &&
            currentEvent()?.evidence.some(item => item.token === data.token)) {
            observations.set(data.token, data);
            renderObservations();
            for (const ref of data.refs.filter(ref => ref.hasSample)) send('sample', ref.token);
        } else if (data.revision === revision && data.interaction === interaction && data.type === 'sample' && visible &&
            [...observations.values()].some(obs => obs.refs.some(ref => ref.token === data.token))) {
            samples.set(data.token, data);
            renderObservations();
        } else if (data.revision === revision && data.type === 'link-error') {
            status('无法打开证据：' + data.error);
        }
    });
    send('ready');
})();
