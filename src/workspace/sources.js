'use strict';

const fs = require('fs');
const path = require('path');
const { SOURCE_EXCLUDE_GLOB, isExcludedSourcePath } = require('./source-policy');

// 同时识别模块、接口、包和程序，供编译依赖与工程树复用。
const MODULE_DECL_RE = /^[ \t]*(?:module|macromodule|interface|package|program)\s+(?:(?:automatic|static)\s+)?([A-Za-z_][A-Za-z0-9_$]*)/gm;
const WORKSPACE_SCAN_TTL_MS = 10000;
const WORKSPACE_SCAN_MAX_DIRS = 200;
const WORKSPACE_SCAN_MAX_FILES = 3000;

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
 * @param {{workspace: object, readFileSync?: typeof fs.readFileSync, now?: () => number, onError?: (message: string) => void}} deps
 * @returns {{scan: (force?: boolean) => Promise<{dirs: string[], modules: Map<string, string>}>, invalidate: () => void}}
 */
function createWorkspaceSourceIndex({ workspace, readFileSync = fs.readFileSync, now = Date.now, onError = console.warn, sourceCatalog }) {
    let workspaceScanCache = { dirs: [], modules: new Map(), expiresAt: 0 };
    function invalidate() { workspaceScanCache.expiresAt = 0; }
    /**
     * 扫描工作区 Verilog 源码：收集含源文件的目录（供 -y/-I 使用）与
     * 「设计单元名（module/interface/package/program）→ 文件路径」索引
     * （供缺单元时按实际定义文件补编译，覆盖文件名≠单元名的情况）。
     * 结果带 TTL 缓存，避免每次防抖 lint 都全量扫描；缺模块重试与文件增删事件会强制刷新。
     * @param {boolean} [force=false] 跳过缓存强制重新扫描
     * @returns {Promise<{dirs: string[], modules: Map<string, string>}>}
     */
    async function scan(force = false) {
        const timestamp = now();
        if (!force && workspaceScanCache.expiresAt > timestamp) {
            return { dirs: workspaceScanCache.dirs, modules: workspaceScanCache.modules };
        }

        const dirs = [];
        const modules = new Map();
        const roots = workspace.workspaceFolders;
        const enabled = workspace.getConfiguration('svtools.iverilog').get('scanWorkspace', true);
        if (enabled && roots && roots.length > 0) {
            const dirSet = new Set();
            let scanned = 0;
            for (const pattern of sourceCatalog ? ['shared'] : ['**/*.sv', '**/*.v', '**/*.svh', '**/*.vh']) {
                if (scanned >= WORKSPACE_SCAN_MAX_FILES) break;
                let uris = [];
                try {
                    uris = sourceCatalog ? (await sourceCatalog.discover({ limit: WORKSPACE_SCAN_MAX_FILES })).uris
                        : await workspace.findFiles(pattern, SOURCE_EXCLUDE_GLOB, WORKSPACE_SCAN_MAX_FILES);
                } catch (err) {
                    onError('扫描工作区模式 ' + pattern + ' 失败：' + err.message);
                    continue; // 单个模式失败不影响其余
                }
                for (const uri of uris) {
                    if (isExcludedSourcePath(uri.fsPath)) continue;
                    if (scanned++ >= WORKSPACE_SCAN_MAX_FILES) break;
                    dirSet.add(path.dirname(uri.fsPath));
                    try {
                        const text = readFileSync(uri.fsPath, 'utf8');
                        for (const name of extractDesignUnitNames(text)) {
                            if (!modules.has(name)) modules.set(name, uri.fsPath);
                        }
                    } catch (err) {
                        onError('扫描源码 ' + uri.fsPath + ' 失败：' + err.message);
                        // 不可读文件跳过，不影响其余扫描
                    }
                }
            }
            dirs.push(...dirSet);
        }

        workspaceScanCache = {
            dirs: dirs.slice(0, WORKSPACE_SCAN_MAX_DIRS),
            modules,
            expiresAt: timestamp + WORKSPACE_SCAN_TTL_MS
        };
        return { dirs: workspaceScanCache.dirs, modules: workspaceScanCache.modules };
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
