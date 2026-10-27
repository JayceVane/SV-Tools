'use strict';
const { bitValue } = require('../waveform/signal-display');
const { waveDeclaration } = require('./signal-mapping');
const { formatTime } = require('../waveform/model');
const MAX_PROBES = 32, MAX_PROBE_BITS = 4096;

/** @param {string|null} raw Worker的四态编码。 @param {number[]} offsets LSB-first选定位。 @returns {object} 不把未初始化或X/Z当成零。 */
function sample(raw, offsets) {
    if (raw === null || raw === undefined) return {status:'no-event',text:'无事件'};
    if (typeof raw !== 'string' || !/^[01xz]+$/i.test(raw)) throw new Error('关联值不是有效的四态位向量');
    const bits = offsets.map(offset => bitValue(raw,offset)).reverse().join('');
    const unknown = /[xz]/.test(bits);
    return {status:'value',bits,unknown,text:unknown ? `${bits.length}'b${bits}` : `${bits.length}'h${BigInt('0b'+bits).toString(16).toUpperCase().padStart(Math.ceil(bits.length/4),'0')}`};
}

/** @param {object} a @param {object} b @param {number[]} indices LSB-first的HDL下标。 @returns {object} X/Z保留未知语义，列出编码发生变化的实际位。 */
function compare(a,b,indices) {
    if (a.status !== 'value' || b.status !== 'value') return {status:'unavailable',text:b.status === 'no-cursor' ? '未设置B' : '不可比较',indices:[]};
    const changed = indices.filter((_,position) => a.bits.at(-1-position) !== b.bits.at(-1-position));
    if (a.unknown || b.unknown) return {status:'unknown',text:'含 X/Z',indices:changed};
    return {status:changed.length ? 'changed':'same',text:changed.length ? `Δ ${changed.length} bit`:'相同',indices:changed};
}

/**
 * @param {{notify:Function,valid:Function,validate:Function,onError?:Function}} deps 可信会话边界。
 * @returns {object} 少量显式探针；全服务仅一个查询泵，移动游标合并到最新世代。
 */
function createCursorValues({notify,valid,validate,onError=console.error}) {
    const groups = new Map(), cursors = new Map(), wanted = new Set(), subscriptions=new Set();
    let sequence=0, pumping=false, disposed=false;
    function subscribe(wave) {
        const needed=[...groups.values()].some(group=>group.link.wave===wave&&group.probes.size);
        if(needed===subscriptions.has(wave))return;
        if(needed)subscriptions.add(wave);else{subscriptions.delete(wave);cursors.delete(wave);}
        wave.endpoint.subscribeCursors?.(needed);
    }
    function rows(group, status) {
        return [...group.probes.values()].map(probe => ({id:probe.id,label:probe.label,target:probe.target,context:probe.context,
            anchor:probe.anchor,viewGeneration:probe.viewGeneration,...(status ? {a:{status,text:status==='pending'?'读取中':'关联失效'},b:{status,text:'—'},difference:{status:'unavailable',text:'—',indices:[]}} : probe.value)}));
    }
    function publish(group,status) {
        const cursor=cursors.get(group.link.wave);
        notify(group.link.circuit,{type:'wave-values',linkKey:group.link.key,rows:rows(group,status),
            times:cursor ? {a:cursor.a,b:cursor.b,aText:formatTime(cursor.a,group.secondsPerTick),bText:formatTime(cursor.b,group.secondsPerTick)} : null});
    }
    function queue(group,force=false) {group.version++;const pending=group.pending;group.pending=true;if(!pending||force)publish(group,'pending');wanted.add(group);void pump();}
    async function pump() {
        if (pumping || disposed) return;
        pumping=true;
        try {
            while (wanted.size && !disposed) {
                const group=wanted.values().next().value;wanted.delete(group);
                const version=group.version, cursor=cursors.get(group.link.wave);
                if (!cursor || !valid(group.link) || !group.probes.size) continue;
                try {
                    await validate(group.link.wave);
                    if (version!==group.version || !valid(group.link)) continue;
                    const ids=[...new Set([...group.probes.values()].filter(probe=>probe.query).map(probe=>probe.query.id))];
                    const a=ids.length ? await group.link.wave.endpoint.values({ids,time:cursor.a}) : {values:{}};
                    // 中间A结果从不发布；B属于同一游标快照，新的游标已到达时跳过旧B查询。
                    if (version!==group.version || !valid(group.link)) continue;
                    const b=cursor.b!==null && ids.length ? await group.link.wave.endpoint.values({ids,time:cursor.b}) : {values:{}};
                    await validate(group.link.wave);
                    if (version!==group.version || !valid(group.link)) continue;
                    for (const probe of group.probes.values()) {
                        const av=probe.query ? sample(a.values[probe.query.id],probe.query.offsets) : {status:'unmapped',text:'无匹配dump'};
                        const bv=cursor.b===null ? {status:'no-cursor',text:'未设置'} : probe.query ? sample(b.values[probe.query.id],probe.query.offsets) : {status:'unmapped',text:'无匹配dump'};
                        probe.value={a:av,b:bv,difference:compare(av,bv,probe.target.indices)};
                    }
                    group.pending=false;publish(group);
                } catch (error) {
                    if (version!==group.version || !valid(group.link) || disposed) continue;
                    for(const probe of group.probes.values())probe.value={a:{status:'error',text:'查询失败'},b:{status:'error',text:'—'},difference:{status:'unavailable',text:'—',indices:[]}};
                    group.pending=false;publish(group);onError(error);
                }
            }
        } finally {pumping=false;}
    }
    function invalidate(link) {
        const group=groups.get(link.key);if(!group)return;
        group.version++;wanted.delete(group);groups.delete(link.key);
        subscribe(link.wave);
        notify(link.circuit,{type:'wave-values',linkKey:link.key,rows:[],times:null,invalid:true});
    }
    return {
        /** @param {object} link 当前人工确认映射。 @param {object} input 可信声明和用户选定候选。 @returns {object} 探针身份。 */
        watch(link,{target,context,selection,viewGeneration,match,catalog}) {
            if(disposed || !valid(link))throw new Error('关联已失效，请重新确认');
            for(const group of [...groups.values()])if(group.link.circuit===link.circuit && group.link!==link)invalidate(group.link);
            let group=groups.get(link.key);
            if(!group){group={link,version:0,probes:new Map(),secondsPerTick:catalog.secondsPerTick};groups.set(link.key,group);}
            const identity=JSON.stringify([target.moduleId,context.instancePath,target.objectId,target.indices]);
            const parent=match && catalog.byKey.get(match.key), declaration=parent && waveDeclaration(parent);
            const query=parent ? {id:parent.id,offsets:target.indices.map(index=>(index-declaration.right)*(declaration.left>=declaration.right?1:-1))} : null;
            const existing=[...group.probes.values()].find(probe=>probe.identity===identity);
            if(existing){existing.anchor=selection;existing.viewGeneration=viewGeneration;existing.query=query;queue(group,true);return {ok:true,id:existing.id};}
            const count=[...group.probes.values()].reduce((sum,probe)=>sum+probe.target.indices.length,0);
            if(group.probes.size>=MAX_PROBES || count+target.indices.length>MAX_PROBE_BITS)throw new Error('电路读值最多观察32个信号、合计4096位，请先移除部分观察');
            const contiguous=target.indices.every((index,position)=>!position || index-target.indices[position-1]===target.indices[1]-target.indices[0]) && (target.indices.length===1 || Math.abs(target.indices[1]-target.indices[0])===1);
            const range=contiguous ? '['+target.indices.at(-1)+(target.indices.length>1?':'+target.indices[0]:'')+']' : '['+target.indices.slice().reverse().join(',')+']';
            const probe={id:String(++sequence),identity,target,context,anchor:selection,viewGeneration,query,
                label:context.label+'/'+target.name+range};
            group.probes.set(probe.id,probe);subscribe(link.wave);queue(group,true);return {ok:true,id:probe.id,unmapped:!query};
        },
        cursors(wave,cursor) {if(disposed)return;const previous=cursors.get(wave);if(previous?.a===cursor.a && previous?.b===cursor.b)return;
            cursors.set(wave,{a:cursor.a,b:cursor.b});for(const group of groups.values())if(group.link.wave===wave)queue(group);},
        remove(circuit,id) {for(const group of groups.values())if(group.link.circuit===circuit){if(id===undefined)group.probes.clear();else group.probes.delete(id);subscribe(group.link.wave);queue(group,true);}},
        invalidate,
        disposeWave(wave){cursors.delete(wave);},
        snapshot(circuit){const group=[...groups.values()].find(group=>group.link.circuit===circuit);return group ? rows(group,group.pending?'pending':undefined):[];},
        dispose(){disposed=true;for(const group of [...groups.values()])invalidate(group.link);cursors.clear();wanted.clear();}
    };
}
module.exports={MAX_PROBES,MAX_PROBE_BITS,sample,compare,createCursorValues};
