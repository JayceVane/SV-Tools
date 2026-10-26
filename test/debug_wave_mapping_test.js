'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {createVcdParser}=require('../src/waveform/parser');
const {createDesign}=require('../src/circuit/model');
const {createCircuitTracer}=require('../src/circuit/trace');
const {createCircuitWaveSignals}=require('../src/circuit/wave-signals');
const {createWaveCatalog,matchCircuitSignal,waveCircuitRequest,waveDeclaration}=require('../src/debug/signal-mapping');
const {createWaveLinks}=require('../src/debug/wave-links');

function fixture({ascending=false,flat=false}={}){
    const bits=['n:1','n:2','n:3','n:4'],port=(id,name)=>({id,name,direction:'input',bits,offset:4,upto:ascending});
    const model=createDesign({schemaVersion:1,title:'mapping',top:'top',provenance:{engine:flat?'vivado':'yosys',version:'fixture',stage:'rtl',...(flat?{hierarchy:'flat'}:{})},modules:[
        {id:'top',name:'top',ports:[port('top.d','d')],signals:flat?[{id:'qualified',name:'u1/d',bits,offset:4,upto:ascending}]:[],cells:flat?[]:['u0','u1'].map(name=>({id:name,name,type:'child',kind:'instance',moduleId:'child',ports:[port(name+'.d','d')]}))},
        ...(!flat?[{id:'child',name:'child',ports:[port('child.d','d')],signals:[{id:'alias',name:'alias',bits,offset:4,upto:ascending}],cells:[]}]:[])]});
    const tracer=createCircuitTracer(model),circuit=createCircuitWaveSignals(model,tracer),range=ascending?'[4:7]':'[7:4]';
    const parser=createVcdParser();parser.write(`$scope module tb $end\n$scope module dut $end\n$scope module u0 $end\n$var wire 4 ! d ${range} $end\n$upscope $end\n$scope module u1 $end\n$var wire 4 ! d ${range} $end\n$var wire 4 ! alias ${range} $end\n$upscope $end\n$upscope $end\n$upscope $end\n$enddefinitions $end\n`);
    const metadata=parser.finish(),catalog=createWaveCatalog(metadata);
    return{model,tracer,circuit,metadata,catalog};
}

test('重复实例和VCD别名按实际声明定位，不能用共享identifier code代替层级身份',()=>{
    const h=fixture(),result=h.circuit.selection({moduleId:'child',origin:{objectId:'child.d'}});
    assert.deepEqual(result.contexts.map(item=>item.instanceNames),[['u0'],['u1']]);
    const target={...result.candidates[0],...result.contexts[1]},matches=matchCircuitSignal(target,h.catalog,1);
    assert.deepEqual(matches.map(item=>item.key),['tb.dut.u1.d']);assert.equal(h.catalog.byKey.get(matches[0].key).id,'!');
    const request=waveCircuitRequest(h.catalog.select(matches[0].key),h.catalog,1),reverse=h.circuit.find(request);
    assert.deepEqual(reverse[0].instancePath,['u1']);assert.equal(reverse[0].objectId,'child.d');
});
test('非零起点、切片与升序范围保持HDL下标及位方向，参数宽度或方向冲突明确拒绝',()=>{
    for(const ascending of [false,true]){
        const h=fixture({ascending}),selection=h.circuit.selection({moduleId:'child',origin:{objectId:'child.d',indices:[5,6]},instancePath:['u1']});
        const target={...selection.candidates[0],...selection.contexts[0]},match=matchCircuitSignal(target,h.catalog,1)[0];assert.equal(match.keys.length,2);
        for(const key of match.keys){const selected=h.catalog.select(key),found=h.circuit.find(waveCircuitRequest(selected,h.catalog,1))[0];assert.deepEqual(found.indices,[selected.signal.bitIndex]);}
        assert.deepEqual(matchCircuitSignal({...target,upto:!ascending},h.catalog,1),[]);assert.deepEqual(matchCircuitSignal({...target,width:2,offset:5},h.catalog,1),[]);
    }
});
test('带点的实际作用域与多个层级分段不混淆，未知范围、非法位和错误根不被猜测',()=>{
    const parser=createVcdParser();parser.write('$scope module tb $end $scope module u.v $end $var wire 1 ! d $end $upscope $end $scope module u $end $scope module v $end $var wire 1 # d $end $upscope $end $upscope $end $upscope $end $enddefinitions $end');
    const c=createWaveCatalog(parser.finish()),target={name:'d',nameParts:['d'],instanceNames:['u.v'],width:1,offset:0,upto:false,indices:[0]};
    assert.equal(matchCircuitSignal(target,c,0)[0].key,'["tb.u.v.d","!",""]');assert.equal(matchCircuitSignal({...target,instanceNames:['u','v']},c,0)[0].key,'["tb.u.v.d","#",""]');
    assert.throws(()=>waveDeclaration({type:'wire',name:'d',width:4}),/没有记录/);assert.throws(()=>c.select('["$bit","missing",2]'),/不存在/);
    const h=fixture();assert.throws(()=>waveCircuitRequest(h.catalog.select('tb.dut.u0.d'),h.catalog,3),/不在/);
});
test('Vivado平坦限定名称使用适配器的斜杠层级，不按同名模块假造实例',()=>{
    const h=fixture({flat:true}),found=h.circuit.find(waveCircuitRequest(h.catalog.select('tb.dut.u1.d'),h.catalog,1));
    assert.equal(found[0].moduleId,'top');assert.deepEqual(found[0].instancePath,[]);assert.deepEqual(found[0].nameParts,['u1','d']);assert.equal(matchCircuitSignal(found[0],h.catalog,1)[0].key,'tb.dut.u1.d');
});
function serviceFixture(){
    const h=fixture(),questions=[],reveals=[],traces=[],notices=[],snapshot={id:'design',revision:1,viewGeneration:1,top:'top',modules:[{id:'top',name:'top'}]},flags={fileChanged:false,pause:null};
    const vscode={window:{async showQuickPick(items,options){questions.push(options.title);if(flags.pause){const pause=flags.pause;flags.pause=null;await pause;}return items.find(item=>item.item.id===1)||items.find(item=>item.item.label==='u1')||items[0];},async showInputBox(){return '';}}};
    const links=createWaveLinks({vscode});
    const circuit=links.registerCircuit({snapshot:()=>snapshot,label:()=> 'design',targets:async()=>h.circuit.selection({moduleId:'child',origin:{objectId:'child.d'}}),find:async request=>h.circuit.find(request),trace:async(target,direction)=>{traces.push({target,direction});return{trace:{}};},reveal(){},notify:state=>notices.push(state)});
    const wave=links.registerWave({snapshot:()=>({id:'wave',revision:1}),label:()=> 'wave.vcd',file:'wave.vcd',metadata:async()=>h.metadata,validate:async()=>{if(flags.fileChanged)throw Error('file changed');},reveal:async request=>reveals.push(request),notify:state=>notices.push(state)});
    return{...h,links,circuit,wave,questions,reveals,traces,notices,snapshot,flags};
}
test('产品映射要求人工选择根层级，双向复用确认且明确标记来源未证明同次构建',async()=>{
    const h=serviceFixture(),result=await h.circuit.show({selection:{}});assert.equal(result.ok,true);assert.deepEqual(h.reveals[0].keys,['tb.dut.u1.d']);
    assert.equal(h.questions.filter(title=>title.startsWith('人工确认')).length,1);assert.match(result.label,/未验证同次构建/);
    const reverse=await h.wave.trace('tb.dut.u1.d','loads');assert.equal(reverse.ok,true);assert.deepEqual(h.traces[0].target.instancePath,['u1']);assert.equal(h.traces[0].direction,'loads');
    assert.equal(h.questions.filter(title=>title.startsWith('人工确认')).length,1);h.links.dispose();
});
test('关闭、重仿真、源码变化和磁盘替换会撤销映射，不悄悄沿用旧VCD identifier',async()=>{
    const h=serviceFixture();await h.circuit.configure();assert.equal(h.links.state().links.length,1);
    h.flags.fileChanged=true;await assert.rejects(h.wave.trace('tb.dut.u1.d','drivers'),/file changed/);assert.equal(h.links.state().links.length,0);
    h.flags.fileChanged=false;await h.circuit.configure();h.circuit.invalidate('源码已变化');h.snapshot.sourceStale=true;
    await assert.rejects(h.circuit.show({}),/变化/);assert.equal(h.links.state().links.length,0);
    h.snapshot.sourceStale=false;await h.circuit.configure();h.wave.dispose();assert.equal(h.links.state().links.length,0);await assert.rejects(h.wave.trace('tb.dut.u1.d','drivers'),/关闭/);
    assert.ok(h.notices.some(item=>item.status==='invalid'));h.links.dispose();
});
test('选择器期间关闭页面和并发操作不会提交迟到映射',async()=>{
    const h=serviceFixture();let release;h.flags.pause=new Promise(resolve=>{release=resolve;});const setting=h.circuit.configure();await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(h.wave.trace('tb.dut.u1.d','drivers'),/正在进行/);h.wave.dispose();release();await assert.rejects(setting,/关闭/);assert.equal(h.links.state().links.length,0);h.links.dispose();
});
test('关闭相关视图主动取消原生选择器，立即结束关联操作而不等待用户选择',async()=>{
    const h=fixture();let tokenSeen,disposed=false;
    class TokenSource{constructor(){this.listeners=[];this.token={onCancellationRequested:fn=>{this.listeners.push(fn);return{dispose(){}};}};}cancel(){for(const fn of this.listeners)fn();}dispose(){disposed=true;}}
    const links=createWaveLinks({vscode:{CancellationTokenSource:TokenSource,window:{showQuickPick(_items,_options,token){tokenSeen=token;return new Promise(resolve=>token.onCancellationRequested(()=>resolve(undefined)));}}}});
    const circuit=links.registerCircuit({snapshot:()=>({id:'d',revision:1,top:'top'}),label:()=> 'circuit'});
    const wave=links.registerWave({snapshot:()=>({id:'w',revision:1}),label:()=> 'wave',metadata:async()=>h.metadata,validate:async()=>{},notify(){}});
    const setting=circuit.configure();await new Promise(resolve=>setImmediate(resolve));assert.ok(tokenSeen);wave.dispose();
    await assert.rejects(setting,/关闭/);assert.equal(links.state().busy,false);assert.equal(disposed,true);links.dispose();
});
module.exports={fixture};
