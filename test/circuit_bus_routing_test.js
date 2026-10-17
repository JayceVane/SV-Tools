'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { projectModule } = require('../src/circuit/projection');
const { layoutModule } = require('../src/circuit/layout');
const { createGraphIndex } = require('../src/circuit/graph-index');
function design(ports, cells = {}) { return fromYosys({ modules: { top: { ports, cells } } }); }
function cdc() { return design({ i_clk:{direction:'input',bits:[2]},i_rst_n:{direction:'input',bits:[3]},i_bit:{direction:'input',bits:[4]},o_bit:{direction:'output',bits:[5]} },
    { sync:{type:'$aldff',parameters:{WIDTH:'10',CLK_POLARITY:'1',ALOAD_POLARITY:'0'},port_directions:{D:'input',Q:'output',AD:'input',ALOAD:'input',CLK:'input'},connections:{D:[4,6],Q:[6,5],AD:['1','1'],ALOAD:[3],CLK:[2]}} }); }
const project = d => projectModule(d,d.top);
function bundle(graph,pin) { return graph.nodes.find(n=>n.kind==='bus' && n.originalPort?.label===pin); }
function trunk(graph,node) { return graph.edges.find(e=>e.bundleNode===node.id); }
function lane(node,bit) { return node.ports.find(p=>p.bitPositions && p.bits.includes(bit)); }

test('CDC拼接和拆分显示完整两位主干及准确位位置',()=>{
    const d=cdc(),before=structuredClone(d),g=project(d),join=bundle(g,'D'),split=bundle(g,'Q');
    assert.ok(join,'D必须有拼接节点'); assert.ok(split,'Q必须有拆分节点');
    assert.equal(join.routing,'join'); assert.equal(split.routing,'split');
    assert.deepEqual(trunk(g,join).bits,['n:4','n:6']); assert.deepEqual(trunk(g,split).bits,['n:6','n:5']);
    assert.deepEqual(lane(join,'n:4').bitPositions,[[0]]); assert.deepEqual(lane(join,'n:6').bitPositions,[[1]]);
    assert.deepEqual(lane(split,'n:6').bitPositions,[[0]]); assert.deepEqual(lane(split,'n:5').bitPositions,[[1]]);
    assert.equal(g.stats.cellCount,1); assert.equal(g.stats.busNodeCount,3);
    assert.deepEqual(d,before); assert.deepEqual(project(d),g);
});
test('重复常量保留一位源、两位目标和逐位重复映射',()=>{
    const g=project(cdc()),ad=bundle(g,'AD'),p=lane(ad,'c:1'); assert.ok(ad);
    assert.deepEqual(trunk(g,ad).bits,['c:1','c:1']); assert.deepEqual(p.bits,['c:1']); assert.deepEqual(p.bitPositions,[[0,1]]);
    assert.equal(p.wireLabel,'1b ×2'); assert.equal(g.nodes.filter(n=>n.kind==='constant').length,1);
});
test('拆分分支各自保持实际宽度，不把完整主干宽度写到切片上',()=>{
    const d=design({a:{direction:'input',bits:[2,3,4,5]},y:{direction:'output',bits:[2,3]},z:{direction:'output',bits:[4,5]}}),g=project(d);
    const b=bundle(g,'a');assert.ok(b);assert.deepEqual(trunk(g,b).bits,['n:2','n:3','n:4','n:5']);
    assert.deepEqual(b.ports.filter(p=>p.bitPositions).map(p=>p.bitPositions),[[[0],[1]],[[2],[3]]]);
    assert.deepEqual(g.edges.filter(e=>!e.bundleNode).map(e=>e.bits.length),[2,2]);
});
test('向量重排使用显式位映射，不改写端口顺序',()=>{
    const d=design({a:{direction:'input',bits:[2,3]},y:{direction:'output',bits:[3,2]}}),g=project(d),b=bundle(g,'y');
    assert.ok(b);assert.deepEqual(trunk(g,b).bits,['n:3','n:2']);
    assert.deepEqual(b.ports.find(p=>p.bitPositions).bitPositions,[[1],[0]]);
    assert.equal(b.ports.find(p=>p.bitPositions).label,'[0:1]');
});
test('普通单比特和完整同序4096位总线不增加连接节点',()=>{
    for(const bits of [[2],Array.from({length:4096},(_,i)=>i+2)]){
        const g=project(design({a:{direction:'input',bits},y:{direction:'output',bits}}));
        assert.equal(g.nodes.length,2);assert.equal(g.edges.length,1);assert.equal(g.stats.busNodeCount,0);
    }
});
test('非恒定信号重复拼接保留真实单比特源及重复次数',()=>{
    const g=project(design({a:{direction:'input',bits:[2]},y:{direction:'output',bits:[2,2,2]}})),b=bundle(g,'y');assert.ok(b);
    assert.deepEqual(trunk(g,b).bits,['n:2','n:2','n:2']);assert.deepEqual(b.ports.find(p=>p.bitPositions).bitPositions,[[0,1,2]]);
});
test('分支选中经过主干但不误选其它位，选中主干覆盖其全部成员网络',()=>{
    const g=project(cdc()),index=createGraphIndex(g),q=bundle(g,'Q'),d=bundle(g,'D'),q0=lane(q,'n:6'),q1=lane(q,'n:5');
    assert.ok(q0);const branch=g.edges.find(e=>e.source===q0.id),other=g.edges.find(e=>e.source===q1.id);
    const selected=index.selection({type:'edge',id:branch.id});assert.ok(selected.edges.has(trunk(g,q).id));assert.ok(selected.edges.has(trunk(g,d).id));assert.ok(!selected.edges.has(other.id));
    const all=index.selection({type:'edge',id:trunk(g,q).id});assert.ok(all.edges.has(branch.id));assert.ok(all.edges.has(other.id));
});
test('真实ELK为CDC反馈与总线节点生成独立、有限的路由',async()=>{
    const d=cdc(),g=await layoutModule(d,d.top);assert.equal(g.nodes.filter(n=>n.kind==='bus').length,3);
    for(const e of g.edges) assert.ok(e.sections.every(s=>Number.isFinite(s.startPoint.x)&&Number.isFinite(s.endPoint.y)));
    for(const n of g.nodes.filter(n=>n.kind==='bus'))assert.ok(n.ports.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
});

test('连接节点同样受节点、连线和引脚预算约束，不通过省略分支绕过预算',()=>{
    const { addBusConnections }=require('../src/circuit/bus-routing');
    for(const key of ['maxNodes','maxEdges','maxPorts']){
        // 取原始端口重新投影一个需要拆分的简单总线。
        const nodes=[{id:'source',ports:[{id:'p',label:'P',direction:'output',bits:['a','b']}]}];
        const edges=[{id:'a',netId:'na',source:'p',target:'x',bits:['a']},{id:'b',netId:'nb',source:'p',target:'y',bits:['b']}];
        const limits={maxNodes:20,maxEdges:20,maxPorts:20,[key]:key==='maxNodes'?1:key==='maxEdges'?2:3};
        assert.throws(()=>addBusConnections(nodes,edges,limits),/预算|exceeds/);
    }
});
test('全端口选择经过总线成员索引，主干详情保持原位顺序',()=>{
    const g=project(cdc()),q=bundle(g,'Q'),index=createGraphIndex(g);
    const selected=index.selection({type:'port',id:q.originalPort.id});
    for(const p of q.ports.filter(p=>p.bitPositions))assert.ok(g.edges.filter(e=>e.source===p.id).every(e=>selected.edges.has(e.id)));
    assert.ok(index.networkEdges(trunk(g,q)).some(e=>e.source===lane(q,'n:6').id));
});

test('位出现次数相同但排列不同，不误标成向量重复', () => {
    const g = project(design({ a: { direction: 'input', bits: [2, 3] }, y: { direction: 'output', bits: [2, 3, 3, 2] } }));
    const b = bundle(g, 'y'), branch = b.ports.find(port => port.bitPositions);
    assert.equal(branch.wireLabel, '2b →4b');
    assert.deepEqual(branch.bitPositions, [[0, 3], [1, 2]]);
});

test('四级同步器保留三位反馈切片和一位输入分支', () => {
    const d = design({ i_bit: { direction: 'input', bits: [4] }, o_bit: { direction: 'output', bits: [5] } }, {
        sync: { type: '$dff', port_directions: { D: 'input', Q: 'output' }, connections: { D: [4, 6, 7, 8], Q: [6, 7, 8, 5] } }
    });
    const g = project(d), join = bundle(g, 'D'), split = bundle(g, 'Q');
    assert.deepEqual(trunk(g, join).bits, ['n:4', 'n:6', 'n:7', 'n:8']);
    assert.deepEqual(lane(join, 'n:6').bitPositions, [[1], [2], [3]]);
    assert.deepEqual(lane(split, 'n:6').bitPositions, [[0], [1], [2]]);
    assert.equal(lane(join, 'n:6').wireLabel, '3b [3:1]');
    assert.equal(lane(split, 'n:6').wireLabel, '3b [2:0]');
});
