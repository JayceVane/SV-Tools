'use strict';
const path = require('node:path');
const { createWaveCatalog, matchCircuitSignal, waveCircuitRequest } = require('./signal-mapping');
const { createCursorValues } = require('./cursor-values');
const MAX_LINKS = 64, MAX_PICKER_ITEMS = 512;

/**
 * @param {object} dependencies 编辑器选择器；只协调已注册的可信会话，不读取网表或查询事件。
 * @returns {object} 注册、人工根映射、双向定位和失效协议；映射不持久化到下一次构建。
 */
function createWaveLinks({ vscode }) {
    const circuits = new Map(), waves = new Map(), links = new Map(); let sequence = 0, busy = false, disposed = false, operation;
    const identity = entry => entry.endpoint.snapshot();
    const values = createCursorValues({
        valid:link=>{const now=identity(link.circuit);return !disposed && link.circuit.active && link.wave.active && links.get(link.key)===link && now && !now.sourceStale && now.id===link.snapshot.id && now.revision===link.snapshot.revision;},
        validate:wave=>validateWave(wave),
        notify:(entry,message)=>{if(entry.active)Promise.resolve(entry.endpoint.notifyValues?.(message)).catch(error=>console.error('电路读值发送失败：'+error.message));}
    });
    function current(entry, snapshot, view = false) {
        if (disposed || !entry.active) throw new Error('关联的视图已关闭，请重新选择');
        operation?.entries.add(entry);
        const now = identity(entry);
        if (!now || now.sourceStale || snapshot && (now.id !== snapshot.id || now.revision !== snapshot.revision
            || view && now.viewGeneration !== snapshot.viewGeneration)) throw new Error('电路来源或视图已变化，请重新关联');
        return now;
    }
    function notify(entry, value) {
        if (!entry.active) return;
        Promise.resolve(entry.endpoint.notify?.(value)).catch(error => console.error('波形关联状态发送失败：' + error.message));
    }
    function removeLink(key, reason) {
        const link = links.get(key); if (!link) return; links.delete(key);
        values.invalidate(link);
        for (const entry of [link.circuit,link.wave]) notify(entry,{ status:'invalid',text:reason });
    }
    function invalidate(entry, reason) {
        if(operation?.entries.has(entry)){operation.reason=reason;operation.cancellation?.cancel();}
        for (const [key,link] of links) if (link.circuit === entry || link.wave === entry) removeLink(key,reason);
    }
    async function run(action) {
        if (disposed) throw new Error('波形关联服务已关闭');
        if (busy) throw new Error('已有波形关联操作正在进行，请先完成或取消选择');
        busy = true;
        const cancellation=vscode.CancellationTokenSource?new vscode.CancellationTokenSource():null;
        operation={entries:new Set(),cancellation};
        try { return await action(); }
        finally { cancellation?.dispose();operation=null;busy=false; }
    }
    async function pick(items, title, describe, always = false) {
        if (!items.length) throw new Error(title + '：没有可用对象');
        if (items.length === 1 && !always) return items[0];
        const chosen=await vscode.window.showQuickPick(items.map((item,index) => ({...describe(item,index),item})),{title,matchOnDescription:true,matchOnDetail:true},operation?.cancellation?.token);
        if(operation?.reason)throw new Error(operation.reason);
        return chosen?.item;
    }
    async function chooseEndpoint(kind, supplied) {
        if (supplied) { current(supplied); return supplied; }
        const entries = [...(kind === 'circuit' ? circuits : waves).values()].filter(entry => entry.active && identity(entry) && !identity(entry).sourceStale);
        if (!entries.length) throw new Error(kind === 'circuit' ? '请先打开要关联的电路视图' : '请先打开仿真结束后的VCD波形');
        const chosen=await pick(entries,kind === 'circuit' ? '选择关联的电路视图' : '选择关联的VCD',entry => ({label:entry.endpoint.label(),description:entry.endpoint.file || ''}));
        if(chosen)current(chosen);return chosen;
    }
    async function waveCatalog(wave) {
        current(wave); await validateWave(wave); current(wave);
        const metadata = await wave.endpoint.metadata(); current(wave);
        if (!metadata) throw new Error('VCD尚未加载成功，请先完成波形加载');
        wave.catalog ||= createWaveCatalog(metadata); return wave.catalog;
    }
    async function validateWave(wave){try{await wave.endpoint.validate();current(wave);}catch(error){invalidate(wave,'VCD来源已变化或不可读取，请重新确认');throw error;}}
    async function configure(circuit, wave, force = false) {
        const snapshot = current(circuit), key = JSON.stringify([circuit.id,snapshot.id,snapshot.revision,wave.id]);
        const catalog = await waveCatalog(wave); current(circuit,snapshot);
        if (!force && links.has(key)) return links.get(key);
        let roots = catalog.scopes.map((scope,id) => ({...scope,id}));
        if (roots.length > MAX_PICKER_ITEMS) {
            const query = await vscode.window.showInputBox({title:'筛选VCD的DUT根层级',prompt:'作用域较多，请输入完整路径的一部分'},operation?.cancellation?.token);
            if(operation?.reason)throw new Error(operation.reason);
            if (query === undefined) return null;
            roots = roots.filter(root => root.path.toLowerCase().includes(query.toLowerCase()));
            if (roots.length > MAX_PICKER_ITEMS) throw new Error('根层级候选仍超过512项，请使用更具体的路径');
        }
        const topName = snapshot.modules?.find(module => module.id === snapshot.top)?.name || snapshot.top;
        const root = await pick(roots,'人工确认：电路 ' + topName + ' 对应哪个VCD根实例？',scope => ({
            label:scope.path,description:scope.type + ' · 分段 ' + JSON.stringify(catalog.paths[scope.id]),
            detail:'仅确认层级对应，不证明网表和VCD来自同一次构建；重新仿真后失效'
        }),true);
        if (!root) return null;
        current(circuit,snapshot); await validateWave(wave); current(wave);
        const label = '人工确认：' + topName + ' ↔ ' + root.path + ' · ' + path.basename(wave.endpoint.file || wave.endpoint.label()) + ' · 未验证同次构建';
        if(links.has(key))removeLink(key,'波形根映射已重新确认');
        const link = { key,circuit,wave,snapshot,rootId:root.id,label }; links.set(key,link);
        while (links.size > MAX_LINKS) removeLink(links.keys().next().value,'较早的波形映射已淘汰，请重新确认');
        for (const entry of [circuit,wave]) notify(entry,{status:'confirmed',text:label});
        return link;
    }
    async function setup(entry) {
        const circuit = await chooseEndpoint('circuit',entry.kind === 'circuit' ? entry : null); if (!circuit) return {cancelled:true};
        const wave = await chooseEndpoint('wave',entry.kind === 'wave' ? entry : null); if (!wave) return {cancelled:true};
        const link = await configure(circuit,wave,true); return link ? {ok:true,label:link.label} : {cancelled:true};
    }
    async function toWave(circuit, selection, observe = false) {
        const snapshot = current(circuit), result = await circuit.endpoint.targets(selection); current(circuit,snapshot,true);
        const signal = await pick(result.candidates,'选择要加入波形的命名网络',item => ({label:item.name,description:item.width+' bit · offset '+item.offset})); if (!signal) return {cancelled:true};
        const context = await pick(result.contexts,'确认实际电路实例',item => ({label:item.label,description:JSON.stringify(item.instancePath)})); if (!context) return {cancelled:true};
        const wave = await chooseEndpoint('wave'); if (!wave) return {cancelled:true};
        const link = await configure(circuit,wave); if (!link) return {cancelled:true};
        current(circuit,snapshot,true); const catalog = await waveCatalog(wave);
        const matches = matchCircuitSignal({...signal,...context},catalog,link.rootId);
        if (!matches.length && !observe) throw new Error('没有层级、名称和位范围均匹配的VCD声明；该信号可能未dump、被优化或来自不同参数/源码');
        const match = matches.length ? await pick(matches,'确认VCD信号声明',item => ({label:item.path+item.range,description:item.width+' bit · '+item.indices.length+'个选定位'})) : null;
        if (matches.length && !match) return {cancelled:true};
        current(circuit,snapshot,true); await validateWave(wave); current(wave);
        if(observe)return values.watch(link,{target:signal,context,selection:selection.selection,viewGeneration:snapshot.viewGeneration,match,catalog});
        await wave.endpoint.reveal({keys:match.keys,text:link.label});
        return {ok:true,keys:match.keys,target:signal,context,label:link.label};
    }
    async function toCircuit(wave, key, direction) {
        if (!['drivers','loads'].includes(direction)) throw new Error('电路追踪方向无效');
        const catalog = await waveCatalog(wave), selected = catalog.select(key);
        const circuit = await chooseEndpoint('circuit'); if (!circuit) return {cancelled:true};
        const snapshot = current(circuit), link = await configure(circuit,wave); if (!link) return {cancelled:true};
        current(circuit,snapshot,true);
        const targets = await circuit.endpoint.find(waveCircuitRequest(selected,catalog,link.rootId));
        current(circuit,snapshot,true);
        const target = await pick(targets,'确认波形对应的实际电路信号',item => ({label:item.label+' · '+item.name,description:item.width+' bit · '+item.indices.length+'个选定位'}));
        if (!target) return {cancelled:true};
        current(circuit,snapshot,true); await validateWave(wave); current(wave);
        const graph = await circuit.endpoint.trace(target,direction);
        if (graph?.error) throw new Error(graph.error);
        if (!graph) return {cancelled:true};
        circuit.endpoint.reveal(); return {ok:true,target,direction,label:link.label};
    }
    function register(kind,endpoint) {
        const entry = {id:String(++sequence),kind,endpoint,active:true}; (kind === 'circuit' ? circuits : waves).set(entry.id,entry);
        return {id:entry.id,configure:()=>run(()=>setup(entry)),
            show:selection=>run(()=>toWave(entry,selection)),trace:(key,direction)=>run(()=>toCircuit(entry,key,direction)),
            watch:selection=>run(()=>toWave(entry,selection,true)),removeProbe:id=>values.remove(entry,id),
            cursors:cursor=>values.cursors(entry,cursor),probes:()=>values.snapshot(entry),
            invalidate(reason) {invalidate(entry,reason);},
            dispose() {if(!entry.active)return;entry.active=false;invalidate(entry,kind === 'wave' ? '关联波形已关闭或重新仿真，请重新确认' : '关联电路已关闭，请重新确认');(kind === 'circuit' ? circuits : waves).delete(entry.id);if(kind==='wave')values.disposeWave(entry);entry.catalog=null;}
        };
    }
    return {registerCircuit:endpoint=>register('circuit',endpoint),registerWave:endpoint=>register('wave',endpoint),
        state:()=>({circuits:circuits.size,waves:waves.size,busy,links:[...links.values()].map(link=>({circuit:link.circuit.id,wave:link.wave.id,designId:link.snapshot.id,revision:link.snapshot.revision,rootId:link.rootId,label:link.label}))}),
        dispose() {disposed=true;values.dispose();if(operation){operation.reason='关联服务已关闭';operation.cancellation?.cancel();}for(const [key] of links)removeLink(key,'关联服务已关闭');for(const entry of [...circuits.values(),...waves.values()]){entry.active=false;entry.catalog=null;}circuits.clear();waves.clear();}}
}
module.exports = { createWaveLinks };
