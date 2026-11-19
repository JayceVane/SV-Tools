import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import MarkdownIt from 'markdown-it';

const vscode = acquireVsCodeApi();
const byId = id => document.getElementById(id);
const source = byId('source');
const status = byId('status');
const markdown = new MarkdownIt({ html: false });
let version = 0, saved = '', desired = '', inflight, timer, rich = true, initialized = false, conflicted = false;
let saveRequested = false;

function queue(content) {
    desired = content;
    if (conflicted) { vscode.setState({ draft: content }); return; }
    clearTimeout(timer);
    timer = setTimeout(flush, 140);
}

function flush() {
    if (!initialized || conflicted || inflight) return;
    if (desired === saved) {
        if (saveRequested) { saveRequested = false; vscode.postMessage({ type: 'save' }); }
        return;
    }
    inflight = { content: desired, version };
    vscode.postMessage({ type: 'edit', ...inflight });
}

const editor = new Editor({
    element: byId('editor'),
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), Markdown, TableKit, Image],
    content: '', contentType: 'markdown',
    onUpdate: ({ editor }) => { if (rich) queue(editor.getMarkdown()); }
});

function applyMode() {
    byId('editor').hidden = !rich;
    byId('tools').hidden = !rich;
    source.hidden = rich;
    byId('mode').textContent = rich ? 'Markdown 源码' : '富文本';
}

function load(content) {
    source.value = content;
    editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false });
    const supported = markdown.render(content) === markdown.render(editor.getMarkdown());
    byId('mode').disabled = !supported;
    if (!supported) rich = false;
    status.textContent = supported ? '' : '此文档含富文本模式无法保真的 Markdown，已打开源码编辑。';
    applyMode();
}

byId('mode').onclick = () => {
    rich = !rich;
    load(desired);
};
source.oninput = () => {
    queue(source.value);
    if (rich) return;
    editor.commands.setContent(source.value, { contentType: 'markdown', emitUpdate: false });
    byId('mode').disabled = markdown.render(source.value) !== markdown.render(editor.getMarkdown());
};
const tools = {
    bold: chain => chain.toggleBold(), italic: chain => chain.toggleItalic(), heading: chain => chain.toggleHeading({ level: 2 }),
    list: chain => chain.toggleBulletList(), code: chain => chain.toggleCodeBlock(), quote: chain => chain.toggleBlockquote(),
    table: chain => chain.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
};
for (const button of byId('tools').querySelectorAll('button[data-action]')) {
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => tools[button.dataset.action](editor.chain().focus()).run();
}
byId('link').onclick = () => {
    const href = byId('url').value.trim();
    if (/^(?:https?:\/\/|mailto:|#)/iu.test(href)) editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    else status.textContent = '请输入 https、http、mailto 或文档内链接。';
};
byId('save').onclick = () => { saveRequested = true; flush(); };
byId('reload').onclick = () => {
    conflicted = false;
    saveRequested = false;
    vscode.setState({});
    desired = saved;
    load(saved);
    byId('reload').hidden = true;
};
window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        byId('save').click();
    }
});
window.addEventListener('message', ({ data }) => {
    if (data?.type !== 'state' || typeof data.content !== 'string' || data.version < version) return;
    const previous = saved;
    saved = data.content;
    version = data.version;
    if (inflight && inflight.content === saved) {
        inflight = undefined;
        flush();
        return;
    }
    if (initialized && desired !== previous && (data.conflict || saved !== previous)) {
        inflight = undefined;
        conflicted = true;
        vscode.setState({ draft: desired });
        rich = false;
        source.value = desired;
        status.textContent = '文档同时被修改。请先复制当前草稿，再读取文件并合并。';
        byId('mode').disabled = true;
        byId('reload').hidden = false;
        applyMode();
        return;
    }
    if (!initialized || saved !== previous) {
        const draft = vscode.getState()?.draft;
        initialized = true;
        if (typeof draft === 'string' && draft !== saved) {
            desired = draft;
            conflicted = true;
            rich = false;
            source.value = draft;
            byId('mode').disabled = true;
            byId('reload').hidden = false;
            status.textContent = '保留了冲突草稿。请先复制草稿，再读取文件并合并。';
            applyMode();
        } else { desired = saved; load(saved); }
    }
});
applyMode();
vscode.postMessage({ type: 'ready' });
