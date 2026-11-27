'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fail } = require('../agent/protocol');
const { createHash } = require('node:crypto');
const { relative } = require('./workflow-contract');
const { fingerprint, safePath } = require('./workflow-files');
const { loadMarkdownIt } = require('./note-export');

const MAX_DOCUMENT = 1024 * 1024;
const MAX_TOTAL = 8 * MAX_DOCUMENT;

function markdownRenderer() {
    const markdown = new (loadMarkdownIt())({ html: false, linkify: false });
    // 设计文档随报告离线阅读，正文保留文本、表格和代码。附件链接保留可读的原始引用。
    markdown.renderer.rules.link_open = (tokens, index, _options, env) => {
        env.designDocumentHref = tokens[index].attrGet('href');
        return '';
    };
    markdown.renderer.rules.link_close = (_tokens, _index, _options, env) =>
        ' <code>' + markdown.utils.escapeHtml(env.designDocumentHref) + '</code>';
    markdown.renderer.rules.image = (tokens, index) => {
        const token = tokens[index];
        return markdown.utils.escapeHtml(token.content) + ' <code>' + markdown.utils.escapeHtml(token.attrGet('src')) + '</code>';
    };
    return markdown;
}

async function readMarkdown(root, name, stamp) {
    const file = await fs.open(await safePath(root, name), 'r');
    try {
        const bytes = Buffer.alloc(stamp.bytes + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        const content = bytes.subarray(0, bytesRead);
        if (bytesRead !== stamp.bytes || createHash('sha256').update(content).digest('hex') !== stamp.sha256) {
            fail('CONTEXT_CHANGED', '绑定的设计文档读取期间已变化：' + name);
        }
        try { return new TextDecoder('utf-8', { fatal: true }).decode(content); }
        catch { fail('INVALID_ARGUMENT', '绑定的设计文档必须使用 UTF-8：' + name); }
    } finally { await file.close(); }
}

async function bindDesignDocs(root, config, pages, units) {
    const documents = new Map();
    const bindings = [];
    if (config === undefined) return { documents, bindings };
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail('INVALID_ARGUMENT', 'designDocs 必须是模块名到 Markdown 路径的映射');
    const pagesByName = new Map();
    for (const page of pages) {
        if (!pagesByName.has(page.name)) pagesByName.set(page.name, []);
        pagesByName.get(page.name).push(page);
    }
    let renderer;
    let totalBytes = 0;
    for (const [name, configured] of Object.entries(config)) {
        if (units.get(name)?.scope.kind !== 'module') fail('INVALID_ARGUMENT', `designDocs.${name} 找不到对应的模块声明`);
        const file = relative(configured, `designDocs.${name}`);
        if (!/\.md$/iu.test(path.extname(file))) fail('INVALID_ARGUMENT', `designDocs.${name} 需要 .md 文件`);
        const targets = pagesByName.get(name);
        if (!targets) continue;
        if (!documents.has(file)) {
            const stamp = await fingerprint(root, file, MAX_DOCUMENT).catch(error => {
                if (error.code === 'ENOENT') fail('INVALID_ARGUMENT', `designDocs.${name} 找不到设计文档：${file}`);
                throw error;
            });
            renderer ||= markdownRenderer();
            documents.set(file, { path: file, sha256: stamp.sha256, bytes: stamp.bytes, html: renderer.render(await readMarkdown(root, file, stamp)) });
        }
        const document = documents.get(file);
        totalBytes += document.bytes * targets.length;
        if (totalBytes > MAX_TOTAL) fail('SOURCE_LIMIT', '绑定的模块设计文档超过总大小限制');
        for (const page of targets) page.designDoc = document;
        bindings.push({ module: name, path: document.path, sha256: document.sha256 });
    }
    return { documents, bindings };
}

module.exports = { bindDesignDocs };
