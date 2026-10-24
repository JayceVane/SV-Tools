/* 导出拥有独立数据窗口与绘制状态；不借用当前视口缓存或改变用户布局。 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('../graphics/svg-canvas'),require('../graphics/image-export'));else root.WaveImageExport=factory(root.SvgCanvas,root.ImageExport);})(typeof window==='object'?window:globalThis,function(S,I){
    'use strict';
    const HEADER=50,RULER=35,FOOTER=30,QUERY_POINTS=120000,BATCH_IDS=32;
    const DOCUMENT_COLORS={bg:'#ffffff',panel:'#ffffff',border:'#b0b0b0',fg:'#111111',dim:'#333333',grid:'#dddddd',accent:'#111111',bus:'#111111',x:'#111111',z:'#111111',a:'#111111',b:'#111111',selection:'#ffffff',labelText:'#111111',labelHalo:'#ffffff'};
    /** @param {object} state @param {object} options @returns {object} 自动画幅与归一化范围；无有效AB或信号时拒绝。 */
    function plan(state,{range='ab',signals='all'}={}){
        const validAB=Number.isFinite(state.cursorA)&&Number.isFinite(state.cursorB)&&state.cursorA!==state.cursorB;
        if(range==='ab'&&!validAB)throw new Error('请先设置两个不同的 A/B 游标');
        const start=range==='ab'?Math.min(state.cursorA,state.cursorB):state.view.start;
        const end=range==='ab'?Math.max(state.cursorA,state.cursorB):Math.min(state.metadata.endTime,state.view.start+state.view.span);
        if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw new Error('导出时间区间无效');
        let rows=state.rows.filter(row=>signals!=='selected'||state.multi.has(row.key)||row.memberKeys?.some(key=>state.multi.has(key)));
        if(!rows.length)throw new Error('没有可导出的信号，请先添加或选择信号');
        let height=0;rows=rows.map(row=>{const next={...row,y:height};height+=row.height;return next;});
        const longest=Math.max(...rows.map(row=>String(state.fullName?row.signal.path:row.signal.name).length));
        const names=Math.min(620,Math.max(300,longest*7+155));
        const width=Math.round(Math.min(2600,Math.max(1100,names+800,(height+HEADER+RULER+FOOTER)*1.6)));
        return {start,end,rows,names,width,height,fullHeight:height+HEADER+RULER+FOOTER};
    }
    /** @param {{state:object,options:object,request:Function,window:object,renderer:object,title:string}} deps @returns {Promise<object>} SVG及逻辑尺寸，所有数据均由worker查询。 */
    async function create({state,options,request,window,renderer,title}){
        const source={...state,view:{...state.view},rows:state.rows.slice(),formats:{...state.formats},groups:{...state.groups},heights:{...state.heights},highlights:{...state.highlights},multi:new Set(state.multi),selected:state.selected.slice()};
        const layout=plan(source,options),ids=[...new Set(layout.rows.filter(row=>!row.groupSummary).map(row=>row.signal.id))];
        const series=new Map(),valuesA=Object.create(null),valuesB=Object.create(null);
        const pixels=Math.max(1,Math.min(4096,Math.floor(layout.width-layout.names),Math.floor(QUERY_POINTS/Math.max(1,ids.length))));
        for(let offset=0;offset<ids.length;offset+=BATCH_IDS){
            const batch=ids.slice(offset,offset+BATCH_IDS),result=await request('window',{ids:batch,start:layout.start,end:layout.end,pixels});
            for(const item of result.series)series.set(item.id,item);
            Object.assign(valuesA,(await request('values',{ids:batch,time:source.cursorA})).values);
            if(source.cursorB!==null)Object.assign(valuesB,(await request('values',{ids:batch,time:source.cursorB})).values);
        }
        const measure=window.document.createElement('canvas').getContext('2d');
        const context=prefix=>S.createContext({prefix,measure:(text,font)=>{measure.font=font;return measure.measureText(text).width;}});
        const main=context('wave'),axis=context('ruler'),canvas=ctx=>({style:{},getContext:()=>ctx});
        const colors=options.style==='document'?DOCUMENT_COLORS:renderer.getPalette();
        const drawingState={...source,view:{start:layout.start,span:layout.end-layout.start},rows:layout.rows,columns:{names:layout.names},multi:new Set(),activeKey:null,
            series,seriesKey:'export',windowKey:'export',valuesA,valuesB,rowPresentation:null};
        const drawing=window.createWaveRenderer({canvas:canvas(main),ruler:canvas(axis),tracks:{clientWidth:layout.width,clientHeight:layout.height,scrollTop:0},state:drawingState,model:window.WaveModel,
            paletteOverride:colors,exportGeometry:{width:layout.width,height:layout.height,names:layout.names,plot:layout.width-layout.names-12,gutter:12},pixelRatio:1,cursorLabelsBelow:true,monochrome:options.style==='document'});
        drawing.draw();
        const M=window.WaveModel,range=`${M.formatTime(layout.start,source.secondsPerTick)} → ${M.formatTime(layout.end,source.secondsPerTick)}`;
        const dense=[...series.values()].some(item=>item.dense.length),detail=`${range} · ${layout.rows.length} 行 · ${dense?'密集区域已标示，未伪造边沿':'按需时间窗'} · A/B读值精确`;
        const header=`<text x="12" y="22" font-family="sans-serif" font-size="16" fill="${S.escape(colors.fg)}">${S.escape(title)}</text><text x="12" y="41" font-family="sans-serif" font-size="12" fill="${S.escape(colors.dim)}">${S.escape(range)}</text>`;
        const footer=`<text x="12" y="${layout.fullHeight-10}" font-family="sans-serif" font-size="11" fill="${S.escape(colors.dim)}">${S.escape(detail)}</text>`;
        const body=header+`<g transform="translate(0 ${HEADER})">${axis.content()}</g><g transform="translate(0 ${HEADER+RULER})">${main.content()}</g>`+footer;
        return {svg:I.svgDocument({width:layout.width,height:layout.fullHeight,title,detail:detail+'\n'+layout.rows.map(row=>row.groupSummary||row.signal.path+(row.signal.range||'')).join('\n'),body,background:colors.bg}),width:layout.width,height:layout.fullHeight};
    }
    return {plan,create,DOCUMENT_COLORS};
});
