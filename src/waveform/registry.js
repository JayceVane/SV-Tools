'use strict';
const path = require('node:path');
const fileKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
function within(directory, file) {
    const relative = path.relative(fileKey(directory), fileKey(file));
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

/**
 * 面板与写入租约共享文件身份；关闭必须等待绑定释放，写入期间拒绝新的读会话。
 * @returns {object} 面板注册、文件状态、可等待关闭及仿真写入租约。
 */
function createWaveformRegistry() {
    const active = new Map(), closing = new Set(), sources = new Map(), writers = new Set();
    function isWriting(file) {
        const key = fileKey(file);
        return [...writers].some(writer => writer.paths.has(key) || writer.uncertain && within(writer.directory, file));
    }
    function assertAvailable(file) {
        if (isWriting(file)) {
            throw new Error('该波形正在重新仿真，完成后可再次打开：' + path.basename(file));
        }
    }
    function close(record) {
        if (record.closing) return record.closing;
        if (active.get(record.key) === record) active.delete(record.key);
        record.closing = Promise.resolve().then(() => record.binding.dispose());
        closing.add(record);
        const remove = () => { closing.delete(record); record.listener.dispose(); };
        record.closing.then(remove, remove);
        record.panel.dispose();
        return record.closing;
    }
    function attach(file, panel, binding, sourceFile) {
        assertAvailable(file);
        const key = fileKey(file), previous = active.get(key);
        if (previous) close(previous);
        if (sourceFile) sources.set(key, fileKey(sourceFile));
        const record = { key, file, panel, binding, closing: null };
        record.listener = panel.onDidDispose(() => close(record));
        active.set(key, record);
        return binding;
    }
    /**
     * 注册写入租约后关闭目标面板并等待worker退出；失败时撤销租约并阻止仿真启动。
     * @param {{paths?:string[],sourceFile?:string,directory:string,uncertain?:boolean}} options
     * @returns {Promise<{dispose:Function}>} 写入结束后由调用方释放，恢复波形打开入口。
     */
    async function prepareForSimulation({ paths = [], sourceFile, directory, uncertain = false }) {
        const targets = new Set(paths.map(fileKey));
        if (sourceFile) for (const [file, source] of sources) if (source === fileKey(sourceFile)) targets.add(file);
        const writer = { paths: targets, directory, uncertain };
        writers.add(writer);
        try {
            const records = new Set([...active.values(), ...closing]);
            await Promise.all([...records].filter(record => targets.has(record.key) || uncertain && within(directory, record.file)).map(close));
            return { dispose() { writers.delete(writer); } };
        } catch (error) { writers.delete(writer); throw error; }
    }
    return {
        assertAvailable, isWriting, attach, prepareForSimulation,
        sourceFile: file => sources.get(fileKey(file)),
        activeFile: () => [...active.values()].find(record => record.panel.active)?.file,
        get(file) { assertAvailable(file); return active.get(fileKey(file)); },
        async dispose() { await Promise.all([...new Set([...active.values(), ...closing])].map(close)); }
    };
}
module.exports = { createWaveformRegistry };
