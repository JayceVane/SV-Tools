'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCircuitWaveHost } = require('../src/circuit/wave-link-host');
const { CircuitSession } = require('../src/circuit/session');
const fs = require('node:fs/promises');
const path = require('node:path');

test('页面关联动作要求设计、世代和真实图对象一致，伪造或迟到选择不会触发查找', async () => {
    const state = {design:{id:'design',revision:2,top:'top'},generation:3,sourceStale:false,closed:false,
        graph:{id:'graph',moduleId:'top',edges:[],nodes:[{id:'node',ports:[{id:'port:p',bits:['n:1']}]}]}};
    const requests=[],notices=[];
    const host = createCircuitWaveHost({readState:()=>state,session:{async request(command,payload){requests.push({command,payload});return{candidates:[]};}},trace:{},instancePath:()=>[],send:message=>notices.push(message),onError(){}});
    const message = {designId:'design',revision:2,viewGeneration:3,selection:{type:'node',id:'node'},bitChoice:'*'};
    await host.targets(message); assert.equal(requests[0].payload.origin.objectId,'p');
    await assert.rejects(host.targets({...message,viewGeneration:2}),/过期/);
    await assert.rejects(host.targets({...message,selection:{type:'node',id:'injected'}}),/请选择/);
    state.sourceStale=true; await assert.rejects(host.targets(message),/变化/); assert.equal(requests.length,1);
});

test('真实电路Worker拒绝过期关联RPC，刷新后旧设计世代不能再用于反向查找', async () => {
    const root = await fs.mkdtemp(path.resolve('bin/m4-worker-')), file = path.join(root,'design.json');
    await fs.writeFile(file,JSON.stringify({modules:{top:{attributes:{top:1},ports:{data:{direction:'input',bits:[2,3,4,5],offset:4}},cells:{},netnames:{data:{bits:[2,3,4,5],offset:4}}}}}));
    const session = new CircuitSession();
    try {
        const first = await session.request('load',{filePath:file,format:'yosys',top:'top'}), snapshot={designId:first.id,revision:first.revision};
        const signals = await session.request('traceSignals',{...snapshot,moduleId:first.top,query:'data'});
        const result = await session.request('waveTargets',{...snapshot,moduleId:first.top,origin:{objectId:signals.items[0].objectId},instancePath:[]});
        assert.deepEqual(result.candidates[0].indices,[4,5,6,7]);
        const second = await session.request('load',{filePath:file,format:'yosys',top:'top'}); assert.notEqual(first.revision,second.revision);
        await assert.rejects(session.request('waveFind',{...snapshot,signal:{scopes:[],name:'data',width:4,left:7,right:4,indices:[6]}}),/过期/);
        const found = await session.request('waveFind',{designId:second.id,revision:second.revision,signal:{scopes:[],name:'data',width:4,left:7,right:4,indices:[6]}});
        assert.deepEqual(found[0].origin.positions,[2]);
    } finally {session.dispose();}
});
