'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { clientHarness } = require('./helpers/waveform-client-harness');
const { createWaveLinkHost } = require('../src/waveform/link-host');

test('没有观察者不广播游标；订阅后仅游标变化广播，取消订阅立即停止',async()=>{
    const h=clientHarness();await h.flush();
    const packets=()=>h.messages.filter(message=>message.type==='circuit-cursors');assert.equal(packets().length,0);
    h.windowListeners.message({data:{type:'circuit-cursor-subscribe',enabled:true}});assert.equal(packets().length,1);
    h.node('jumpTime').value='20';h.node('jump').onclick();await h.flush();assert.equal(packets().at(-1).a,20);assert.equal(packets().length,2);
    h.node('jump').onclick();await h.flush();assert.equal(packets().length,2);
    h.windowListeners.message({data:{type:'circuit-cursor-subscribe',enabled:false}});
    h.node('jumpTime').value='30';h.node('jump').onclick();await h.flush();assert.equal(packets().length,2);
    h.windowListeners.message({data:{type:'circuit-cursor-subscribe',enabled:true}});assert.equal(packets().at(-1).a,30);
});

test('来自电路的信号添加及逐位定位保留时间视窗，展开已收起组并确认实际行身份', async () => {
    const vars = [{path:'tb.data',name:'data',scopePath:'tb',id:'!',range:'[7:4]',width:4,type:'reg',changeCount:3}];
    const h = clientHarness({fileKey:'test',selected:['tb.data'],start:20,span:30,groups:{'tb.data':'DATA'},collapsedGroups:['DATA']},{vars});
    await h.flush();
    const key = JSON.stringify(['$bit','tb.data',2]);
    h.windowListeners.message({data:{type:'link-reveal',token:8,keys:[key],text:'manual'}});
    await h.flush();
    assert.ok(h.state.selected.includes(key)); assert.equal(h.state.signals.get(key).bitIndex,6);
    assert.equal(h.state.activeKey,key); assert.equal(h.state.collapsedGroups.length,0);
    assert.deepEqual(JSON.parse(JSON.stringify(h.state.view)),{start:20,span:30});
    assert.ok(h.messages.some(message=>message.type==='link-revealed'&&message.token===8&&message.ok===true));
    assert.ok(h.persisted().bitKeys.includes(key));
});

test('非法行和超预算定位不部分添加；右键追踪冻结单信号而非依赖后来选择', async () => {
    const h = clientHarness(); await h.flush();
    const before = [...h.state.selected];
    h.windowListeners.message({data:{type:'link-reveal',token:2,keys:['tb.a','missing']}});
    assert.deepEqual([...h.state.selected],before); assert.equal(h.messages.at(-1).ok,false);
    const item = h.contextMenu('tb.a').items.find(item=>item.id==='circuit-trace').submenu[0];
    h.pointer('tb.b'); item.action();
    assert.equal(h.messages.at(-1).key,'tb.a'); assert.equal(h.messages.at(-1).direction,'drivers');
    h.pointer('tb.c',{ctrlKey:true});
    assert.ok(h.contextMenu('tb.b').items.find(item=>item.id==='circuit-trace').submenu.every(item=>item.disabled));
});

test('波形定位使用独立token，忽略伪造确认，关闭会话会拒绝正在等待的页面确认', async () => {
    const sent = [], host = createWaveLinkHost({send:message=>sent.push(message),initialized:Promise.resolve({signals:1}),closed:()=>false});
    const pending = host.reveal({keys:['tb.a']}); await new Promise(resolve=>setImmediate(resolve));
    await host.receive({type:'link-revealed',token:999,ok:true});
    const token = sent[0].token; await host.receive({type:'link-revealed',token,ok:true}); assert.equal((await pending).ok,true);
    const closing = host.reveal({keys:['tb.a']}); await new Promise(resolve=>setImmediate(resolve));
    const rejected = assert.rejects(closing,/关闭/); host.dispose(); await rejected;
});
