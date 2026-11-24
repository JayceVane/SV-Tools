'use strict';

/**
 * 解析批处理 Tcl 的 SVTOOLS_RUN_PROGRESS 标记。
 * 格式：SVTOOLS_RUN_PROGRESS <run> <progress> <status...>
 * @param {string} line 单行输出
 * @returns {{run:string, progress:string, status:string}|null} 非进度标记返回 null
 */
function parseRunProgress(line) {
    const match = /^SVTOOLS_RUN_PROGRESS\s+(\S+)\s+(\d+(?:\.\d+)?%)\s*(.*)$/u.exec(String(line || '').trim());
    if (!match) return null;
    const value = Number.parseFloat(match[2]);
    return { run: match[1], progress: Number.isFinite(value) ? Math.round(value) + '%' : match[2], status: match[3] || '' };
}

module.exports = { parseRunProgress };
