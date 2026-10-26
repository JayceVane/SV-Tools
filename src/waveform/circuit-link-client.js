(function(root,factory){
    const display=typeof module==='object'&&module.exports?require('./signal-display'):root.WaveSignalDisplay;
    const api=factory(display);if(typeof module==='object'&&module.exports)module.exports=api;else root.WaveCircuitLink=api;
})(typeof globalThis==='object'?globalThis:this,function(D){
    'use strict';
    /** @param {object} deps 页面现有行、选择和查询入口。 @returns {object} 关联显示不改变时间范围和原始事件。 */
    function createWaveCircuitLink({state,post,addSignals,select,tracks,status,document}){
        let subscribed=false,cursorKey;
        function reportCursors(){
            if(!subscribed||!state.metadata)return;
            const key=JSON.stringify([state.cursorA,state.cursorB]);if(key===cursorKey)return;
            cursorKey=key;post({type:'circuit-cursors',a:state.cursorA,b:state.cursorB});
        }
        function receive(message){
            if(message.type==='circuit-cursor-subscribe'){subscribed=message.enabled===true;cursorKey=undefined;reportCursors();return true;}
            if(message.type==='circuit-link-state'){
                const node=document.getElementById('circuitLinkStatus');if(node){node.hidden=false;node.textContent=message.state.text;node.title=message.state.text;node.dataset.status=message.state.status;}return true;
            }
            if(message.type==='link-notice'){status(message.message);return true;}
            if(message.type!=='link-reveal')return false;
            try{
                if(!state.metadata||!Array.isArray(message.keys)||!message.keys.length||message.keys.length>D.MAX_TRACKS)throw new Error('波形尚未加载或定位行超过预算');
                const keys=[...new Set(message.keys)], staged=new Map();
                for(const key of keys){
                    if(typeof key!=='string'||key.length>131072)throw new Error('定位行身份无效');
                    if(state.signals.has(key)){staged.set(key,state.signals.get(key));continue;}
                    let tuple;try{tuple=JSON.parse(key);}catch{throw new Error('定位行已不存在');}
                    const parent=Array.isArray(tuple)&&tuple[0]==='$bit'&&state.signals.get(tuple[1]);
                    if(!parent)throw new Error('定位行的父信号已不存在');staged.set(parent.key,parent);D.restoreBits([key],staged,D.MAX_TRACKS);
                    if(!staged.has(key))throw new Error('定位行的位选择无效');
                }
                if(new Set([...state.selected,...keys]).size>D.MAX_TRACKS||new Set([...state.bitKeys,...keys.filter(key=>Number.isInteger(staged.get(key).bitOffset))]).size>D.MAX_TRACKS)throw new Error('定位将超过2000条波形或隐藏位预算，请先移除部分信号');
                for(const key of keys){const signal=staged.get(key);state.signals.set(key,signal);if(Number.isInteger(signal.bitOffset)){state.bitKeys.add(key);if(!state.groups[key]&&state.groups[signal.parentKey])state.groups[key]=state.groups[signal.parentKey];}}
                const groups=new Set(keys.map(key=>state.groups[key]).filter(Boolean));state.collapsedGroups=state.collapsedGroups.filter(name=>!groups.has(name));
                addSignals(keys);select({keys,anchor:keys[0],activeKey:keys[0]});
                const row=state.rows.find(row=>row.key===keys[0]);if(row)tracks.scrollTop=row.y;
                status('已从电路定位 '+keys.length+' 条波形；时间视窗保持不变');post({type:'link-revealed',token:message.token,ok:true});
            }catch(error){status(error.message);post({type:'link-revealed',token:message.token,ok:false,error:error.message});}
            return true;
        }
        return {receive,reportCursors};
    }
    return {createWaveCircuitLink};
});
