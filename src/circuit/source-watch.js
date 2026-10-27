'use strict';
const { keyPath } = require('./trace-source');
const { sourceHash, sourceMatches } = require('./source-snapshots');
const path = require('node:path');
const { watch, realpathSync } = require('node:fs');
const CHECK_DELAY_MS = 200;

// Windows临时目录可能使用8.3短路径；libuv必须用与文件事件一致的真实长路径监听。
const watchSourceDirectory = (directory, options, callback) => watch(realpathSync.native(directory), options, callback);

/**
 * 观察生成输入的正文和磁盘变化；按目录复用监听，实际跳转仍另行校验。
 * @param {{vscode:object,onStale:Function,clock?:object,watchDirectory?:Function}} options 宿主事件与可注入的目录监听。
 * @returns {{replace:Function,dispose:Function}} 有界的快照观察器，关闭时解除监听。
 */
function createSourceWatch({ vscode, onStale, clock = globalThis, watchDirectory = watchSourceDirectory }) {
    let snapshots = new Map(), pending = new Map(), timer, stale = false, disposed = false, generation = 0;
    const pendingFiles = new Set(), watchers = [];
    function markStale() {
        if (disposed || stale) return;
        stale = true;
        onStale();
    }
    function documentMatches(document, expected) {
        try { return sourceHash(document.getText()) === expected; }
        catch (error) { console.error('无法读取生成输入正文：' + error.message); return false; }
    }
    function schedule() {
        clock.clearTimeout(timer);
        const version = generation;
        timer = clock.setTimeout(() => {
            if (disposed || stale || version !== generation) return;
            const documents = [...pending], files = [...pendingFiles];
            pending.clear(); pendingFiles.clear();
            for (const [key, document] of documents) {
                if (!documentMatches(document, snapshots.get(key))) { markStale(); break; }
            }
            // 单批顺序读取，避免大工程一次打开数千个文件；旧快照和关闭后的响应不再生效。
            void (async () => {
                for (const key of files) {
                    if (disposed || stale || version !== generation) return;
                    let matches;
                    try { matches = await sourceMatches(key, snapshots.get(key)); }
                    catch (error) {
                        matches = false;
                        if (error.code !== 'ENOENT') console.error('无法核验生成输入：' + error.message);
                    }
                    if (disposed || version !== generation) return;
                    if (!matches) { markStale(); return; }
                }
            })();
        }, CHECK_DELAY_MS);
    }
    function changed(document) {
        if (disposed || stale || !document?.uri?.fsPath || !snapshots.has(keyPath(document.uri.fsPath))) return;
        pending.set(keyPath(document.uri.fsPath), document);
        schedule();
    }
    function releaseWatchers() { for (const watcher of watchers.splice(0)) watcher.close(); }
    const subscription = vscode.workspace.onDidChangeTextDocument?.(event => changed(event.document));
    return {
        replace(entries) {
            if (disposed) return;
            generation++; releaseWatchers();
            clock.clearTimeout(timer); pending.clear(); pendingFiles.clear(); stale = false;
            snapshots = new Map(entries.map(entry => [keyPath(entry.path), entry.hash]));
            const directories = new Map(), version = generation;
            for (const key of snapshots.keys()) {
                const directory = path.dirname(key);
                if (!directories.has(directory)) directories.set(directory, new Set());
                directories.get(directory).add(key);
            }
            for (const [directory, files] of directories) {
                try {
                    const watcher = watchDirectory(directory, { persistent: false }, (_, name) => {
                        if (disposed || stale || version !== generation) return;
                        const keys = name === null || name === undefined ? files : [keyPath(path.join(directory, String(name)))];
                        for (const key of keys) if (files.has(key)) pendingFiles.add(key);
                        if (pendingFiles.size) schedule();
                    });
                    watcher.on?.('error', error => {
                        if (disposed || version !== generation) return;
                        console.error('生成输入监视失败：' + error.message); markStale();
                    });
                    watchers.push(watcher);
                } catch (error) { console.error('无法监视生成输入：' + error.message); markStale(); }
            }
            for (const document of vscode.workspace.textDocuments || []) changed(document);
        },
        dispose() { disposed = true; generation++; releaseWatchers(); clock.clearTimeout(timer); pending.clear(); pendingFiles.clear(); snapshots.clear(); subscription?.dispose(); }
    };
}
module.exports = { createSourceWatch };
