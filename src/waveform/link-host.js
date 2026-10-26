'use strict';
const MAX_REVEALS = 4;

/** @param {object} deps 宿主消息边界。 @returns {object} 只处理已验证行的显示确认与关联动作，不与事件查询混用请求ID。 */
function createWaveLinkHost({ send, initialized, closed, onAction, timeoutMs = 10000 }) {
    const pending = new Map(); let sequence = 0, state;
    function notify(value) { state = value; send({type:'circuit-link-state',state}); }
    async function receive(message) {
        if (message.type === 'link-revealed') {
            const request = pending.get(message.token); if (!request) return true;
            pending.delete(message.token); clearTimeout(request.timer);
            if (message.ok === true) request.resolve({ok:true}); else request.reject(new Error(String(message.error || '波形未能显示所选信号').slice(0,2000)));
            return true;
        }
        if (!['circuit-link','circuit-trace'].includes(message.type)) return false;
        try {
            if (!onAction) throw new Error('当前宿主没有电路关联服务');
            await onAction(message);
        } catch (error) { send({type:'link-notice',message:error.message}); }
        return true;
    }
    async function reveal({ keys, text }) {
        if (!Array.isArray(keys) || !keys.length || keys.length > 2000 || keys.some(key => typeof key !== 'string' || key.length > 131072)) throw new Error('波形定位行超出预算或身份无效');
        const ready = await initialized;
        if (!ready || closed()) throw new Error('波形页面尚未就绪或已经关闭');
        if (pending.size >= MAX_REVEALS) throw new Error('波形定位请求过于频繁');
        return new Promise((resolve,reject) => {
            const token = ++sequence, timer = setTimeout(() => {pending.delete(token);reject(new Error('波形页面未确认定位，请重新打开波形'));},timeoutMs);
            pending.set(token,{resolve,reject,timer}); send({type:'link-reveal',token,keys,text});
        });
    }
    return { receive,reveal,notify,reportState(){if(state)send({type:'circuit-link-state',state});},
        dispose(){for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('波形定位因页面关闭而取消'));}pending.clear();} };
}
module.exports = { createWaveLinkHost };
