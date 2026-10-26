(function(root,factory){
    const api=factory();
    if(typeof module==='object'&&module.exports)module.exports=api;else root.CircuitCursorValues=api;
})(typeof globalThis==='object'?globalThis:this,function(){
    'use strict';
    const SVG_NS='http://www.w3.org/2000/svg';
    const short=(value,limit=28)=>value.length>limit ? value.slice(0,limit-1)+'…':value;
    /** @param {object} deps 页面、可信消息和当前绘图索引。 @returns {object} 只更新读值DOM，不生成网表或调用布局。 */
    function createCursorValueControls({document,post,getDrawing}) {
        const panel=document.getElementById('waveValuesPanel'),list=document.getElementById('waveValuesList'),times=document.getElementById('waveValuesTimes');
        const toggle=document.getElementById('waveValuesOverlay'),clear=document.getElementById('waveValuesClear');
        const elements=new Map(),badges=new Map();
        let rows=[],graph,context,generation,design,enabled=true,stale=false;
        function removeBadge(id){const badge=badges.get(id);if(badge?.parentNode)badge.parentNode.removeChild(badge);badges.delete(id);}
        function clearBadges(){for(const id of [...badges.keys()])removeBadge(id);}
        function anchor(row,drawing) {
            if(graph?.moduleId!==row.target.moduleId || JSON.stringify(context)!==JSON.stringify(row.context.instancePath))return null;
            const targetBits=row.target.bits||[],constant=targetBits.some(bit=>bit.startsWith('c:'));
            function entry(selection){
                const item=drawing[selection.type==='edge'?'edges':selection.type==='port'?'ports':'nodes']?.get(String(selection.id));
                if(!item)return null;
                const object=item.edge||item.port||item.node;
                const bits=object.originalBits||object.bits||object.ports?.flatMap(port=>port.bits)||[];
                const members=new Set(bits);
                if(!targetBits.length || !targetBits.every(bit=>members.has(bit)))return null;
                return {...item,type:selection.type};
            }
            if(row.viewGeneration===generation && row.anchor){const found=entry(row.anchor);if(found)return found;}
            if(constant)return null; // 同值常量不是可传播的物理网络身份。
            for(const [id] of drawing.edges||[]){const found=entry({type:'edge',id});if(found)return found;}
            for(const [id] of drawing.ports||[]){const found=entry({type:'port',id});if(found)return found;}
            return null;
        }
        function annotate() {
            const drawing=getDrawing();
            if(!enabled || stale || !drawing){clearBadges();return;}
            const placements=new Map();
            for(const row of rows){
                const item=anchor(row,drawing);
                if(!item){removeBadge(row.id);continue;}
                const key=item.type+':'+(item.edge?.id||item.port?.id||item.node?.id),slot=placements.get(key)||0;
                placements.set(key,slot+1);
                let badge=badges.get(row.id);
                if(!badge){badge=document.createElementNS(SVG_NS,'g');badge.setAttribute('class','cursorValue');
                    badge.appendChild(document.createElementNS(SVG_NS,'title'));badge.appendChild(document.createElementNS(SVG_NS,'text'));badges.set(row.id,badge);}
                let x,y;
                if(item.edge){const section=item.edge.sections?.[0];if(!section){removeBadge(row.id);continue;}x=(section.startPoint.x+section.endPoint.x)/2;y=(section.startPoint.y+section.endPoint.y)/2-22;}
                else if(item.port){x=item.node.x+item.port.x;y=item.node.y+item.port.y+19;}
                else{x=item.node.x+item.node.width/2;y=item.node.y+item.node.height+18;}
                badge.setAttribute('transform',`translate(${x} ${y+slot*18})`);badge.setAttribute('data-status',row.difference.status);
                badge.children[0].textContent=row.label+' · A '+row.a.text+' · B '+row.b.text+' · '+row.difference.text;
                badge.children[1].textContent=short(row.label.split('/').at(-1),18)+' · A '+short(row.a.text)+(row.difference.status==='changed'?'  Δ':row.difference.status==='unknown'?'  ?':'');
                if(badge.parentNode!==drawing.layer)drawing.layer.appendChild(badge);
            }
        }
        function render(message) {
            rows=message.rows||[];panel.hidden=!rows.length;
            times.textContent=message.times ? `A ${message.times.aText} · B ${message.times.bText}`:'等待波形游标';
            const present=new Set(rows.map(row=>row.id));
            for(const [id,item] of elements)if(!present.has(id)){list.removeChild(item.root);elements.delete(id);removeBadge(id);}
            for(const row of rows){
                let item=elements.get(row.id);
                if(!item){const root=document.createElement('div'),name=document.createElement('strong'),value=document.createElement('div'),diff=document.createElement('span'),remove=document.createElement('button');
                    root.className='waveValueRow';value.className='waveValueNumbers';remove.textContent='×';remove.setAttribute('aria-label','移除观察信号');remove.onclick=()=>post({type:'wave-unwatch',designId:design?.id,revision:design?.revision,viewGeneration:generation,probeId:row.id});
                    root.appendChild(name);root.appendChild(remove);root.appendChild(value);root.appendChild(diff);list.appendChild(root);item={root,name,value,diff};elements.set(row.id,item);}
                item.name.textContent=short(row.label,44);item.name.title=row.label;
                item.value.textContent='A '+short(row.a.text,42)+'  /  B '+short(row.b.text,42);
                item.value.title='A '+row.a.text+'\nB '+row.b.text;
                item.diff.textContent=row.difference.text;item.diff.title=row.difference.indices.length ? '编码变化的HDL下标：'+row.difference.indices.join(', '):row.difference.text;
                item.root.dataset.status=row.difference.status;
            }
            annotate();
        }
        const onToggle=()=>{enabled=!enabled;toggle.setAttribute('aria-pressed',String(enabled));annotate();};
        const onClear=()=>post({type:'wave-unwatch',designId:design?.id,revision:design?.revision,viewGeneration:generation});
        toggle.addEventListener('click',onToggle);clear.addEventListener('click',onClear);
        return {
            receive(message){
                if(message.type==='graph'){clearBadges();graph=message.graph;context=message.waveContext;generation=message.viewGeneration;design=message.design;stale=!!message.sourceStale;}
                if(['loading','error','source-stale'].includes(message.type)){stale=true;clearBadges();}
                if(message.type==='wave-values')render(message);
            },
            graphReady:annotate,
            destroy(){clearBadges();toggle.removeEventListener('click',onToggle);clear.removeEventListener('click',onClear);elements.clear();}
        };
    }
    return {createCursorValueControls};
});
