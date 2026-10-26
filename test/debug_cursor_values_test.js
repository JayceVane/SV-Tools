'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {setImmediate:turn}=require('node:timers/promises');
const {sample,compare,createCursorValues}=require('../src/debug/cursor-values');
const {createWaveCatalog}=require('../src/debug/signal-mapping');

function fixture(query=async({time})=>({values:{v:time===0?'0011':'1010'}})) {
    const messages=[],calls=[];
    const circuit={},wave={endpoint:{async values(request){calls.push(request);return query(request);}}};
    const link={key:'link',circuit,wave};let active=true;
    const service=createCursorValues({notify:(entry,message)=>messages.push(message),valid:()=>active,validate:async()=>{},onError:error=>{throw error;}});
    const catalog=createWaveCatalog({secondsPerTick:1e-9,scopes:[{name:'tb',path:'tb',parentId:null,type:'module'}],
        vars:[{id:'v',name:'q',path:'tb.q',scopeId:0,width:4,type:'wire',range:'[7:4]'}]});
    const input={target:{moduleId:'top',objectId:'q',name:'q',width:4,indices:[4,5,6,7],bits:['b0','b1','b2','b3']},context:{instancePath:[],instanceNames:[],label:'top'},selection:{type:'edge',id:'e'},viewGeneration:1,match:{key:'tb.q'},catalog};
    return {service,link,input,messages,calls,deactivate(){active=false;service.invalidate(link);}};
}
async function settled(){for(let i=0;i<12;i++)await turn();}

test('读值保持位选择顺序、零扩展、X/Z扩展及无初始化语义',()=>{
    assert.deepEqual(sample('1',[0,1,2,3]),{status:'value',bits:'0001',unknown:false,text:"4'h1"});
    assert.equal(sample('10xz',[3,0,2]).bits,'0z1');
    assert.equal(sample('x',[0,9]).bits,'xx');assert.equal(sample('z',[0,9]).bits,'zz');
    assert.equal(sample(null,[0]).status,'no-event');assert.equal(sample(undefined,[0]).status,'no-event');
    assert.throws(()=>sample('r1.25',[0]),/四态/);
});

test('A/B按选定位的HDL下标比较，未知、无事件和未设置B分别处理',()=>{
    const a=sample('01',[0,1]),b=sample('11',[0,1]);
    assert.deepEqual(compare(a,b,[6,7]),{status:'changed',text:'Δ 1 bit',indices:[7]});
    assert.equal(compare(a,a,[6,7]).status,'same');
    assert.equal(compare(sample('xz',[0,1]),sample('xz',[0,1]),[6,7]).status,'unknown');
    assert.equal(compare(sample(null,[0]),a,[4]).status,'unavailable');
    assert.equal(compare(a,{status:'no-cursor'},[4]).text,'未设置B');
});

test('真实声明映射后只查询去重id，A/B保留同一快照且不重布局',async()=>{
    const f=fixture();f.service.cursors(f.link.wave,{a:0,b:10});
    f.service.watch(f.link,f.input);
    f.service.watch(f.link,{...f.input,target:{...f.input.target,objectId:'q-slice',indices:[5,6]}});
    await settled();
    const rows=f.messages.at(-1).rows;
    assert.equal(rows.length,2);assert.equal(rows[0].a.text,"4'h3");assert.equal(rows[0].b.text,"4'hA");
    assert.equal(rows[1].a.text,"2'h1");assert.equal(rows[1].b.text,"2'h1");
    assert.ok(f.calls.every(call=>call.ids.length===1 && call.ids[0]==='v'));
    assert.equal(f.messages.at(-1).times.aText,'0 ns');
    assert.equal(f.service.watch(f.link,f.input).id,rows[0].id);
    await settled();f.service.dispose();
});

test('快速游标合并最新请求，不发布旧A、混合A/B或关闭后的迟到结果',async()=>{
    const pending=[];
    const f=fixture(request=>new Promise(resolve=>pending.push({request,resolve})));
    f.service.cursors(f.link.wave,{a:0,b:1});f.service.watch(f.link,f.input);await settled();
    assert.equal(pending.length,1);
    for(let i=1;i<=100;i++)f.service.cursors(f.link.wave,{a:i,b:i+1});
    pending[0].resolve({values:{v:'0000'}});await settled();assert.equal(pending.length,2);
    assert.equal(pending[1].request.time,100);
    pending[1].resolve({values:{v:'0010'}});await settled();assert.equal(pending.length,3);assert.equal(pending[2].request.time,101);
    pending[2].resolve({values:{v:'0011'}});await settled();
    assert.equal(f.messages.filter(message=>message.rows[0]?.a.status==='value').length,1);
    assert.equal(f.messages.at(-1).rows[0].a.text,"4'h2");assert.equal(f.messages.at(-1).rows[0].b.text,"4'h3");
    f.service.cursors(f.link.wave,{a:200,b:null});await settled();f.deactivate();const count=f.messages.length;
    pending[3].resolve({values:{v:'1111'}});await settled();assert.equal(f.messages.length,count);assert.deepEqual(f.messages.at(-1).rows,[]);
    f.service.dispose();
});

test('无匹配dump不查询事件，删除探针及32信号/4096位预算有界',async()=>{
    const f=fixture();f.service.cursors(f.link.wave,{a:0,b:null});
    const added=f.service.watch(f.link,{...f.input,match:null});await settled();
    assert.equal(f.calls.length,0);assert.equal(f.messages.at(-1).rows[0].a.status,'unmapped');
    f.service.remove(f.link.circuit,added.id);assert.deepEqual(f.messages.at(-1).rows,[]);
    for(let i=0;i<32;i++)f.service.watch(f.link,{...f.input,match:null,target:{...f.input.target,objectId:'q'+i}});
    assert.throws(()=>f.service.watch(f.link,{...f.input,target:{...f.input.target,objectId:'overflow'}}),/最多观察32/);
    f.service.remove(f.link.circuit);await settled();
    f.service.watch(f.link,{...f.input,match:null,target:{...f.input.target,indices:Array.from({length:4096},(_,i)=>i)}});
    assert.throws(()=>f.service.watch(f.link,{...f.input,target:{...f.input.target,objectId:'other',indices:[0]}}),/4096/);
    f.service.dispose();
});

test('不同波形和电路会话不混用游标或数据，失效会清空标注',async()=>{
    const f=fixture(),wave2={endpoint:{values:async()=>({values:{v:'1111'}})}},link2={key:'other',circuit:{},wave:wave2};
    f.service.cursors(f.link.wave,{a:0,b:null});f.service.cursors(wave2,{a:25,b:30});
    f.service.watch(f.link,f.input);f.service.watch(link2,f.input);await settled();
    assert.equal(f.service.snapshot(f.link.circuit)[0].a.text,"4'h3");assert.equal(f.service.snapshot(link2.circuit)[0].a.text,"4'hF");
    f.service.invalidate(link2);assert.deepEqual(f.service.snapshot(link2.circuit),[]);assert.equal(f.service.snapshot(f.link.circuit).length,1);
    f.service.dispose();
});

test('真实VCD Worker精确读取事件左闭值、无初始化值及四态，兼容升序和非零切片',async t=>{
    const fs=require('node:fs/promises'),path=require('node:path');
    const {VcdSession}=require('../src/waveform/session');
    const directory=await fs.mkdtemp(path.resolve('bin/m42-values-')),file=path.join(directory,'values.vcd');
    await fs.writeFile(file,'$timescale 1ns $end\n$scope module tb $end\n$var wire 4 ! q [4:7] $end\n$var wire 1 " idle $end\n$upscope $end\n$enddefinitions $end\n#3\nb1 !\n#10\nbxz01 !\n#20\nb1010 !\n#30\n');
    const session=new VcdSession();t.after(()=>session.dispose());const metadata=await session.open(file);
    const messages=[],circuit={},wave={endpoint:{values:params=>session.values(params)}},link={key:'real',circuit,wave};
    const service=createCursorValues({notify:(entry,message)=>messages.push(message),valid:()=>true,validate:async()=>{}});t.after(()=>service.dispose());
    service.cursors(wave,{a:2,b:10});
    const catalog=createWaveCatalog(metadata);
    service.watch(link,{target:{moduleId:'top',objectId:'q',name:'q',indices:[7,6,5,4],bits:['b0','b1','b2','b3']},context:{label:'top',instancePath:[]},match:{key:'tb.q'},catalog});
    async function ready(){for(let i=0;i<100 && service.snapshot(circuit)[0]?.a.status==='pending';i++)await new Promise(resolve=>setTimeout(resolve,5));}
    await ready();let row=service.snapshot(circuit)[0];assert.equal(row.a.status,'no-event');assert.equal(row.b.bits,'xz01');
    service.cursors(wave,{a:3,b:20});await ready();row=service.snapshot(circuit)[0];
    assert.equal(row.a.text,"4'h1");assert.equal(row.b.text,"4'hA");assert.deepEqual(row.difference.indices,[7,6,4]);
    assert.equal((await session.values({ids:['"'],time:20})).values['"'],null);
});
