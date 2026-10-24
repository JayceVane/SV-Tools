'use strict';

/**
 * @param {{showQuickPick:Function}} deps 编辑器选择边界。
 * @returns {{register:Function,list:Function,pick:Function,dispose:Function}} 每个扩展会话独立持有引擎注册；本模块不探测或启动工具。
 */
function createSimulationEnginePicker({ showQuickPick }) {
    if (typeof showQuickPick !== 'function') throw new TypeError('仿真引擎选择需要showQuickPick');
    const engines = new Map(); let disposed = false;
    /** @param {{id:string,label:string,description?:string,run:Function}} engine @returns {{dispose:Function}} 重复ID明确失败，注销只移除本次注册。 */
    function register(engine) {
        if (disposed) throw new Error('仿真引擎选择已关闭');
        if (!engine || !/^[a-z][a-z0-9-]*$/i.test(engine.id) || typeof engine.label !== 'string' || !engine.label.trim()
            || typeof engine.run !== 'function' || (engine.description !== undefined && typeof engine.description !== 'string')) {
            throw new TypeError('仿真引擎需要有效ID、名称和执行回调');
        }
        if (engines.has(engine.id)) throw new Error('仿真引擎重复注册：' + engine.id);
        const entry = Object.freeze({ id: engine.id, label: engine.label, description: engine.description, run: engine.run });
        engines.set(entry.id, entry);
        return { dispose() { if (engines.get(entry.id) === entry) engines.delete(entry.id); } };
    }
    function items(entries) { return [...entries.values()].map(entry => ({ label: entry.label, description: entry.description, value: entry.id })); }
    /** @returns {object[]} 可显示选项的副本，不泄漏注册对象和执行回调。 */
    function list() { return items(engines); }
    /** @returns {Promise<unknown>} 取消、未知选项或等待期间失效的注册不启动任何引擎。 */
    async function pick() {
        if (disposed) return;
        const snapshot = new Map(engines);
        const selected = await showQuickPick(items(snapshot), { placeHolder: '选择仿真引擎' });
        const engine = selected && snapshot.get(selected.value);
        if (disposed || !engine || engines.get(engine.id) !== engine) return;
        return engine.run();
    }
    return { register, list, pick, dispose() { disposed = true; engines.clear(); } };
}
module.exports = { createSimulationEnginePicker };
