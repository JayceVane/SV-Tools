/* 从完整布局重新创建独立SVG，不复制已被视口裁剪或低细节隐藏的现场DOM。 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('../graphics/svg-canvas'),require('../graphics/image-export'));else root.CircuitImageExport=factory(root.SvgCanvas,root.ImageExport);})(typeof window==='object'?window:globalThis,function(S,I){
    'use strict';
    const SVG_NS='http://www.w3.org/2000/svg',PADDING=40,HEADER=46;
    const STYLE_PROPERTIES=['fill','stroke','stroke-width','stroke-dasharray','stroke-linecap','stroke-linejoin','font-family','font-size','font-weight','text-anchor','paint-order','opacity'];
    /** @param {{graph:object,design:object,options:object,window:object,renderer:object}} deps @returns {object} 全模块SVG与尺寸；不改变现场相机、选择或LOD。 */
    function create({graph,design,options,window,renderer}){
        if(!graph||!graph.nodes?.length)throw new Error('当前模块没有可导出的电路');
        const document=window.document,svg=document.createElementNS(SVG_NS,'svg'),container=document.createElement('div');
        container.style.cssText='position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';container.appendChild(svg);document.body.appendChild(container);
        try{
            renderer.renderGraph(svg,graph);
            for(const hit of svg.querySelectorAll('.wireHit,.pinHit,.busHit'))hit.remove();
            // 独立场景没有选中/悬停状态；CSS变量在导出时解析为实际值。
            for(const element of svg.querySelectorAll('*')){
                const computed=window.getComputedStyle(element),isText=element.tagName.toLowerCase()==='text';
                for(const property of STYLE_PROPERTIES){
                    let value=computed.getPropertyValue(property);if(!value)continue;
                    if(options.style==='document'){
                        if(property==='fill'&&value!=='none')value=isText?'#111111':'#ffffff';
                        if(property==='stroke'&&value!=='none')value=isText?'#ffffff':'#111111';
                        if(property==='opacity')value='1';
                    }
                    element.style.setProperty(property,value);
                }
                // PNG栅格化后不能依靠non-scaling-stroke，否则线宽与其它内容比例不同。
                element.style.setProperty('vector-effect','none');
                for(const name of ['tabindex','role','aria-label'])element.removeAttribute(name);
            }
            const bounds=svg.getBBox(),left=Math.min(0,bounds.x),top=Math.min(0,bounds.y),right=Math.max(graph.width||0,bounds.x+bounds.width),bottom=Math.max(graph.height||0,bounds.y+bounds.height);
            if(![left,top,right,bottom].every(Number.isFinite))throw new Error('电路导出布局尺寸无效');
            const width=Math.ceil(right-left+PADDING*2),height=Math.ceil(bottom-top+PADDING*2+HEADER);
            const palette=window.getComputedStyle(document.body),paper=options.style==='document';
            const bg=paper?'#ffffff':palette.getPropertyValue('--bg').trim()||'#ffffff',fg=paper?'#111111':palette.getPropertyValue('--fg').trim()||'#111111';
            const title=`${design?.title||'电路结构'} · ${graph.name||graph.id}`,detail=`${graph.nodes.length} 节点 · ${graph.edges.length} 连接 · 当前模块完整布局`;
            const serializer=new window.XMLSerializer(),scene=[...svg.childNodes].map(node=>serializer.serializeToString(node)).join('');
            let background='';
            if(!paper){const grid=palette.getPropertyValue('--grid').trim()||'#dddddd';background=`<defs><pattern id="export-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="${S.escape(grid)}"/></pattern></defs><rect width="100%" height="100%" fill="url(#export-grid)"/>`;}
            const header=`<text x="${PADDING}" y="28" font-family="sans-serif" font-size="16" fill="${S.escape(fg)}">${S.escape(title)}</text>`;
            const body=background+header+`<g transform="translate(${PADDING-left} ${HEADER+PADDING-top})">${scene}</g>`;
            return {svg:I.svgDocument({width,height,title,detail,body,background:bg}),width,height};
        }finally{container.remove();}
    }
    return {create};
});
