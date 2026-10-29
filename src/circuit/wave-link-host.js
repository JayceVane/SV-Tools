'use strict';
const { traceOrigin, bitIndices } = require('./trace-actions');

/** @param {object} deps 当前可信图、设计世代、Worker及动作适配。 @returns {object} 电路关联消息的验证边界。 */
function createCircuitWaveHost({readState,session,trace,instancePath,onWave,onInvalidated,send,onError}) {
    function requireCurrent(message) {
        const state = readState(), descriptor = state.design;
        if (state.closed || !descriptor || !state.graph || state.sourceStale) throw new Error('电路尚未就绪或源码已变化，请刷新后再关联');
        if (message && (message.designId !== descriptor.id || message.revision !== descriptor.revision || message.viewGeneration !== state.generation)) throw new Error('电路选择已过期，请重新选择');
        return state;
    }
    async function action(message,type) {
        try {
            requireCurrent(message);
            if (!onWave) throw new Error('当前宿主没有波形关联服务');
            return await onWave(type,message);
        } catch (error) {
            await send({type:'notice',message:error.message});
            onError(error);
            return {error:error.message};
        }
    }
    async function targets(message) {
        const state = requireCurrent(message);
        let origin = traceOrigin(state.graph,message.selection);
        if (!origin) throw new Error('请选择具体命名网络、端口或引脚');
        const indices = bitIndices(message.bitChoice || '*');
        if (indices) origin = {objectId:origin.objectId,indices};
        const context = state.graph.trace?.context;
        const result = await session.request('waveTargets',{
            designId:state.design.id, revision:state.design.revision, moduleId:state.graph.moduleId, origin,
            instancePath:context?.kind === 'instance' ? context.instancePath : instancePath()
        });
        const current = requireCurrent(message);
        if (current.generation !== state.generation) throw new Error('电路视图已变化，请重新选择');
        return result;
    }
    return {
        handlers:{'wave-map':message=>action(message,'configure'),'wave-show':message=>action(message,'show'),
            'wave-watch':message=>action(message,'watch'),'wave-unwatch':message=>action(message,'remove')},
        targets,
        snapshot() {
            const state = readState();
            return !state.closed && state.design ? {...state.design,viewGeneration:state.generation,sourceStale:state.sourceStale} : null;
        },
        find(signal) {
            const state = requireCurrent();
            return session.request('waveFind',{designId:state.design.id,revision:state.design.revision,signal});
        },
        begin(target,direction) {requireCurrent();return trace.begin({...target,direction});},
        notify:state=>send({type:'wave-link-state',state}),
        notifyValues:message=>send(message),
        invalidate:reason=>onInvalidated?.(reason)
    };
}
module.exports = { createCircuitWaveHost };
