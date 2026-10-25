'use strict';
const { keyPath } = require('./trace-source');
const { sourceHash } = require('./source-snapshots');
const CHECK_DELAY_MS = 200;

/**
 * 只检查当前生成使用的已打开源码；编辑后提示保留快照，实际跳转仍另行校验。
 * @param {{vscode:object,onStale:Function,clock?:object}} options 宿主事件与通知。
 * @returns {{replace:Function,dispose:Function}} 有界的快照观察器，关闭时解除监听。
 */
function createSourceWatch({ vscode, onStale, clock = globalThis }) {
    let snapshots = new Map(), pending = new Map(), timer, stale = false;
    function changed(document) {
        if (stale || !document?.uri?.fsPath || !snapshots.has(keyPath(document.uri.fsPath))) return;
        pending.set(keyPath(document.uri.fsPath), document);
        clock.clearTimeout(timer);
        timer = clock.setTimeout(() => {
            for (const [key, document] of pending) {
                if (document.isClosed || sourceHash(document.getText()) === snapshots.get(key)) continue;
                stale = true; onStale(); break;
            }
            pending.clear();
        }, CHECK_DELAY_MS);
    }
    const subscription = vscode.workspace.onDidChangeTextDocument?.(event => changed(event.document));
    return {
        replace(entries) {
            clock.clearTimeout(timer); pending.clear(); stale = false;
            snapshots = new Map(entries.map(entry => [keyPath(entry.path), entry.hash]));
            for (const document of vscode.workspace.textDocuments || []) changed(document);
        },
        dispose() { clock.clearTimeout(timer); pending.clear(); snapshots.clear(); subscription?.dispose(); }
    };
}
module.exports = { createSourceWatch };
