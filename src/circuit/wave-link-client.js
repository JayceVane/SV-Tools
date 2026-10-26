(function(root,factory){
    const actions=typeof module==='object'&&module.exports?require('./trace-actions'):root.CircuitTraceActions;
    const api=factory(actions);if(typeof module==='object'&&module.exports)module.exports=api;else root.CircuitWaveLink=api;
})(typeof globalThis==='object'?globalThis:this,function(actions){
    'use strict';
    /** @param {object} deps 页面和消息适配。 @returns {object} 页面只发送当前图选择与宿主世代，不提交声明路径。 */
    function createWaveLinkControls({document,window,post}){
        const setup=document.getElementById('waveLinkSetup'),show=document.getElementById('waveLinkShow'),label=document.getElementById('waveLinkState'),bits=document.getElementById('traceBits');
        const listeners=[];let graph,design,selection,viewGeneration,loading=true,stale=false,busy=false,menu;
        function refresh(){if(setup)setup.disabled=loading||stale||busy||!design?.id;if(show)show.disabled=loading||stale||busy||!actions.traceOrigin(graph,selection);}
        function closeMenu(){if(menu){menu.remove();menu=null;}}
        function contextMenu(event){
            closeMenu();event.preventDefault();menu=document.createElement('div');menu.className='circuitLinkMenu';menu.tabIndex=-1;menu.setAttribute('role','menu');
            const width=window?.innerWidth||1024,height=window?.innerHeight||720;
            menu.style.left=Math.max(8,Math.min(event.clientX,width-268))+'px';menu.style.top=Math.max(8,Math.min(event.clientY,height-184))+'px';
            const targets=[[show,'添加 / 定位到波形…'],[document.getElementById('traceDrivers'),'追踪驱动 ←'],[document.getElementById('traceLoads'),'追踪负载 →'],[setup,'确认VCD根层级…']],buttons=[];
            for(const [target,text] of targets){if(!target)continue;const item=document.createElement('button');item.textContent=text;item.setAttribute('role','menuitem');item.disabled=target.disabled;item.onclick=()=>{closeMenu();target.click();};menu.appendChild(item);buttons.push(item);}
            menu.addEventListener('keydown',event=>{event.stopPropagation();const enabled=buttons.filter(item=>!item.disabled),index=enabled.indexOf(document.activeElement);
                if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu();document.getElementById('circuit')?.focus();}
                else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&enabled.length){event.preventDefault();const at=event.key==='Home'?0:event.key==='End'?enabled.length-1:(index+(event.key==='ArrowDown'?1:enabled.length-1))%enabled.length;enabled[at].focus();}});
            document.body.appendChild(menu);(buttons.find(item=>!item.disabled)||menu).focus();
        }
        const outside=event=>{if(menu&&!menu.contains(event.target))closeMenu();};document.addEventListener('pointerdown',outside);listeners.push(()=>document.removeEventListener('pointerdown',outside));
        function send(type){post({type,designId:design?.id,revision:design?.revision,viewGeneration,selection,bitChoice:bits?.value||'*'});}
        for(const [button,type] of [[setup,'wave-map'],[show,'wave-show']])if(button){const fn=()=>{if(!button.disabled)send(type);};button.addEventListener('click',fn);listeners.push(()=>button.removeEventListener('click',fn));}
        function receive(message){
            if(message.type==='graph'){closeMenu();graph=message.graph;design=message.design;viewGeneration=message.viewGeneration;selection=null;loading=false;busy=false;stale=!!message.sourceStale;}
            if(message.type==='loading'){closeMenu();loading=true;selection=null;}
            if(message.type==='trace-state')busy=!!message.navigation?.busy;
            if(message.type==='error')loading=true;
            if(message.type==='source-stale')stale=true;
            if(message.type==='wave-link-state'&&label){label.textContent=message.state.text;label.title=message.state.text;label.dataset.status=message.state.status;}
            refresh();
        }
        refresh();return{receive,contextMenu,select(value){selection=value;refresh();},destroy(){closeMenu();for(const fn of listeners)fn();}};
    }
    return{createWaveLinkControls};
});
