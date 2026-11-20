'use strict';

const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { samePath } = require('./xpr');

function managerHtml(webview, vscode, resources) {
    const nonce = randomBytes(24).toString('base64');
    const uri = file => webview.asWebviewUri(vscode.Uri.joinPath(resources, file));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
    <link rel="stylesheet" href="${uri('ip-view.css')}"></head><body>
    <header class="page-header">
        <div><h1>IP 管理</h1><p id="ip-project"></p></div>
        <div class="toolbar" aria-label="工程 IP 操作">
            <button id="ip-catalog" data-command="create">IP Catalog</button>
            <button data-command="import">添加已有 IP</button><button data-command="repositories">IP 仓库</button>
            <button data-command="report">状态报告</button><button id="ip-refresh" data-command="refresh">重新读取</button>
        </div>
    </header>
    <main>
        <nav class="members" aria-label="工程 IP">
            <label for="ip-search">工程 IP <span id="ip-count"></span></label>
            <input id="ip-search" type="search" placeholder="按名称或文件集搜索">
            <div id="ip-members" class="member-list"></div>
        </nav>
        <section class="editor" aria-labelledby="ip-name">
            <div id="ip-placeholder" class="empty">请选择工程中的 IP。</div>
            <div id="ip-detail" hidden>
                <header class="detail-header">
                    <div><h2 id="ip-name"></h2><p id="ip-identity"></p></div>
                    <span id="ip-locked" class="locked" hidden>已锁定 · 只读</span>
                </header>
                <div id="ip-operations" class="toolbar"></div>
                <p id="ip-upgrade" class="muted" hidden></p>
                <div class="parameter-toolbar">
                    <label for="parameter-search">配置参数</label>
                    <input type="search" id="parameter-search" placeholder="搜索参数名或当前值">
                </div>
                <nav id="parameter-groups" class="groups" aria-label="参数分类"></nav>
                <div id="ip-parameters"></div>
            </div>
        </section>
    </main>
    <footer>
        <p id="ip-message" role="status" aria-live="polite"></p>
        <div class="toolbar"><span id="ip-changes"></span><button id="ip-revert">撤销修改</button>
        <button id="ip-apply" class="primary">应用参数</button></div>
    </footer>
    <script nonce="${nonce}" src="${uri('ip-client.js')}"></script></body></html>`;
}

const PROJECT_COMMANDS = new Set(['create', 'import', 'repositories', 'report', 'refresh']);
const sameMember = (left, right) => left.fileset === right.fileset && samePath(left.file, right.file);

function resolveEdits(edits, info) {
    if (info.locked || !Array.isArray(edits) || edits.length > info.parameters.length) return;
    const available = new Map(info.parameters.map(parameter => [parameter.key, parameter]));
    const changes = [];
    for (const edit of edits) {
        const parameter = available.get(edit?.key);
        if (!parameter || typeof edit.value !== 'string' || edit.value.length > 65536 || edit.value.includes('\0')) return;
        available.delete(edit.key);
        if (edit.value !== parameter.value) changes.push({ key: parameter.key, before: parameter.value, value: edit.value });
    }
    return changes;
}

function openIpPanels(context, vscode, invoke) {
    const panels = new Set();
    context.subscriptions.push({ dispose() { for (const item of panels) item.panel.dispose(); } });

    function open({ xpr, members, focus }) {
        const existing = [...panels].find(item => samePath(item.xpr, xpr));
        if (existing) {
            existing.show(members, focus);
            return;
        }
        const resources = vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado');
        const panel = vscode.window.createWebviewPanel('svtoolsIpManager', 'IP 管理 · ' + path.basename(xpr, '.xpr'),
            vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
        const details = new Map();
        let records = [], selected, nextId = 0, revision = 0, nextDetail = 0, ready = false, busy = false, disposed = false, status = '';

        const post = message => { if (ready && !disposed) void panel.webview.postMessage(message); };
        function publish() {
            post({ type: 'snapshot', revision: ++revision, project: xpr, busy, status, selected: selected?.id,
                members: records.map(({ id, label, description, detail }) => ({ id, label, description, detail })),
                info: details.get(selected?.id) });
        }
        function replace(next, focus) {
            const before = selected;
            const old = records;
            records = next.map(item => ({ ...item, id: old.find(member => sameMember(member, item))?.id ?? ++nextId }));
            const ids = new Set(records.map(item => item.id));
            for (const id of details.keys()) if (!ids.has(id)) details.delete(id);
            const preferred = focus || before;
            selected = (preferred && records.find(item => sameMember(item, preferred))) || records[0];
        }

        async function perform(action, payload) {
            if (busy) return;
            const target = selected;
            const info = details.get(target?.id);
            busy = true;
            status = action === 'load' ? '正在读取 Vivado IP 参数…' : 'Vivado 正在处理…';
            post({ type: 'activity', busy, status });
            try {
                const result = await invoke(xpr, action, target, info, payload);
                status = result?.message || result?.error || '';
                if (result?.members) replace(result.members, result.focus);
                if (result?.info) {
                    const owner = records.find(item => result.focus ? sameMember(item, result.focus) : item.id === target?.id);
                    if (owner) details.set(owner.id, { ...result.info, version: ++nextDetail });
                }
            } catch (error) {
                status = error.message;
            } finally {
                busy = false;
                publish();
            }
            if (!disposed && selected && !details.has(selected.id) && action !== 'load' && selected.id !== target?.id) {
                await perform('load');
            }
        }
        function show(next, focus) {
            replace(next, focus);
            panel.reveal();
            publish();
            if (ready && selected && !details.has(selected.id)) void perform('load');
        }

        replace(members, focus);
        const entry = { xpr, panel, show };
        panels.add(entry);
        panel.onDidDispose(() => { disposed = true; panels.delete(entry); });
        panel.webview.onDidReceiveMessage(async message => {
            if (disposed || !message) return;
            if (message.action === 'ready') {
                ready = true;
                publish();
                if (selected && !details.has(selected.id)) await perform('load');
                return;
            }
            if (busy || message.revision !== revision) return;
            if (message.action === 'select') {
                const member = records.find(item => item.id === message.id);
                if (!member || selected === member) return;
                selected = member;
                status = '';
                publish();
                if (!details.has(member.id)) await perform('load');
                return;
            }
            if (PROJECT_COMMANDS.has(message.action)) {
                await perform(message.action);
                return;
            }
            const info = details.get(selected?.id);
            if (!info || selected.id !== message.id || info.version !== message.version) return;
            if (message.action === 'apply') {
                const changes = resolveEdits(message.edits, info);
                if (changes?.length) await perform('apply', changes);
                return;
            }
            if (info.actions.some(item => item.id === message.action)) await perform(message.action);
        });
        panel.webview.html = managerHtml(panel.webview, vscode, resources);
    }
    return { open };
}

module.exports = { openIpPanels, resolveEdits };
