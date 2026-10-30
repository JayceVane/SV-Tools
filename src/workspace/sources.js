'use strict';

const fs = require('fs');
const path = require('path');
const { SOURCE_EXCLUDE_GLOB, isExcludedSourcePath } = require('./source-policy');

// 同时识别模块、接口、包和程序，供编译依赖与工程树复用。
const MODULE_DECL_RE = /^[ \t]*(?:module|macromodule|interface|package|program)\s+(?:(?:automatic|static)\s+)?([A-Za-z_][A-Za-z0-9_$]*)/gm;
const WORKSPACE_SCAN_TTL_MS = 10000;
const WORKSPACE_SCAN_MAX_DIRS = 200;
const WORKSPACE_SCAN_MAX_FILES = 3000;
const READ_CONCURRENCY = 8;
const MAX_CACHED_FILES = WORKSPACE_SCAN_MAX_FILES * 2;

/** @param {string} text @returns {string} 屏蔽注释和字符串，保留原文位置与换行。 */
function maskSourceText(text) {
    return String(text).replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*(?:"|$)/g,
        protectedText => protectedText.replace(/[^\r\n]/g, ' '));
}

/** @param {string} text @returns {{name:string,start:number,end:number}[]} 按原文区间识别设计单元声明。 */
function extractDesignUnits(text) {
    const code = maskSourceText(text);
    const matches = [...code.matchAll(MODULE_DECL_RE)];
    return matches.map((match, index) => ({ name: match[1], start: match.index, end: matches[index + 1]?.index ?? code.length }));
}

/** @param {string} text @returns {string[]} 按源码顺序提取设计单元名，忽略注释和字符串。 */
function extractDesignUnitNames(text) { return extractDesignUnits(text).map(unit => unit.name); }

/**
 * 工作区设计单元索引，不依赖 lint 引擎或 Vivado。
 * @param {{workspace: object, readFile?: Function, stat?: Function, now?: () => number, onError?: (message: string) => void, sourceCatalog?:object}} deps
 * @returns {{scan: (force?: boolean) => Promise<{dirs: string[], modules: Map<string, string>}>, invalidate: () => void}}
 */
function createWorkspaceSourceIndex({ workspace, readFile = fs.promises.readFile, stat = fs.promises.stat, now = Date.now, onError = console.warn, sourceCatalog }) {
    const facts = new Map();
    const keyOf = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    let generation = 0, cache, pending;
    function invalidate(change) {
        generation++; cache = null;
        if (change?.uri) facts.delete(keyOf(change.uri.fsPath));
    }
    async function declarations(file, revision) {
        try {
            const info = await stat(file), signature = [info.size, info.mtimeMs, info.ctimeMs].join(':');
            const key = keyOf(file), previous = facts.get(key);
            if (previous?.signature === signature) return previous.names;
            const names = extractDesignUnitNames(await readFile(file, 'utf8'));
            if (generation === revision) {
                facts.delete(key); facts.set(key, { signature, names });
                if (facts.size > MAX_CACHED_FILES) facts.delete(facts.keys().next().value);
            }
            return names;
        } catch (error) { onError('扫描源码 ' + file + ' 失败：' + error.message); return []; }
    }
    async function build(revision) {
        const files = new Map(), modules = new Map(), dirs = new Set();
        let truncated = false;
        const roots = workspace.workspaceFolders;
        if (workspace.getConfiguration('svtools.iverilog').get('scanWorkspace', true) && roots?.length) {
            for (const pattern of sourceCatalog ? ['shared'] : ['**/*.sv', '**/*.v', '**/*.svh', '**/*.vh']) {
                if (files.size >= WORKSPACE_SCAN_MAX_FILES) break;
                try {
                    const discovered = sourceCatalog ? await sourceCatalog.discover({ limit: WORKSPACE_SCAN_MAX_FILES }) : null;
                    if (discovered?.invalidated) return null;
                    const uris = discovered?.uris || await workspace.findFiles(pattern, SOURCE_EXCLUDE_GLOB, WORKSPACE_SCAN_MAX_FILES);
                    truncated ||= !!discovered?.truncated;
                    for (const uri of uris) if (!isExcludedSourcePath(uri.fsPath)) {
                        if (files.size >= WORKSPACE_SCAN_MAX_FILES) { truncated = true; break; }
                        files.set(keyOf(uri.fsPath), uri.fsPath);
                    }
                } catch (error) { onError('扫描工作区模式 ' + pattern + ' 失败：' + error.message); }
            }
        }
        const paths = [...files.values()], parsed = new Array(paths.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, async () => {
            while (next < paths.length && generation === revision) {
                const index = next++; parsed[index] = await declarations(paths[index], revision);
            }
        }));
        if (generation !== revision) return null;
        // 并发读取完成后按发现顺序合并，重复设计单元的优先级不随 I/O 完成顺序变化。
        for (let index = 0; index < paths.length; index++) {
            dirs.add(path.dirname(paths[index]));
            for (const name of parsed[index]) if (!modules.has(name)) modules.set(name, paths[index]);
        }
        return { dirs: [...dirs].slice(0, WORKSPACE_SCAN_MAX_DIRS), modules, ...(truncated ? { truncated: true } : {}) };
    }
    /** 相同代次共享扫描；失效期间的结果不得重新填入有效缓存。 */
    async function scan(force = false) {
        if (force && !(pending?.force && pending.revision === generation)) {
            sourceCatalog?.invalidate(); invalidate();
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            if (cache?.revision === generation && cache.expiresAt > now()) return cache.result;
            if (!pending || pending.revision !== generation) {
                const entry = { revision: generation, force };
                entry.promise = build(entry.revision).then(result => {
                    if (result && entry.revision === generation) cache = { result, revision: generation, expiresAt: now() + WORKSPACE_SCAN_TTL_MS };
                    return result;
                }).finally(() => { if (pending === entry) pending = null; });
                pending = entry;
            }
            const result = await pending.promise;
            if (result) return result;
        }
        throw new Error('源码索引在扫描期间持续变化，请稍后重试');
    }
    return { scan, invalidate };
}

let defaultIndex = null;

/** @param {boolean} [force=false] @returns {ReturnType<ReturnType<typeof createWorkspaceSourceIndex>['scan']>} */
function scanWorkspaceSources(force = false) {
    if (!defaultIndex) defaultIndex = createWorkspaceSourceIndex({ workspace: require('vscode').workspace });
    return defaultIndex.scan(force);
}

/** 文件增删改名时由集成层使缓存失效。 */
function invalidateWorkspaceSources() {
    if (defaultIndex) defaultIndex.invalidate();
}

module.exports = { maskSourceText, extractDesignUnits, extractDesignUnitNames, createWorkspaceSourceIndex, scanWorkspaceSources, invalidateWorkspaceSources };
