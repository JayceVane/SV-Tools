'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const D = require('../src/waveform/signal-display');
const M = require('../src/waveform/model');
const { parseDocument } = require('../src/editor/completion/syntax');
const { createRoleIndex, classifySignals } = require('../src/waveform/source-roles');
const { clientHarness } = require('./helpers/waveform-client-harness');
const bus = (range = '[7:4]') => ({ key: 'tb.ctrl', id: '!', name: 'ctrl', path: 'tb.ctrl', scopePath: 'tb', type: 'wire', width: 4, range, role: 'input' });

test('总线展开使用声明左右界，升序、负下标、切片及数组字保持位序', () => {
    for (const [range, indices] of [['[7:4]', [7,6,5,4]], ['[0:3]', [0,1,2,3]], ['[-1:-4]', [-1,-2,-3,-4]]]) {
        const bits = D.bitSignals(bus(range));
        assert.deepEqual(bits.map(s => s.bitIndex), indices);
        assert.deepEqual(bits.map(s => s.bitOffset), [3,2,1,0]);
        assert.ok(bits.every(s => s.id === '!' && s.width === 1 && s.role === 'input'));
        assert.deepEqual(bits.map(s => M.formatValue('1010', s)), ['1','0','1','0']);
    }
    const word = { ...bus(), name: 'mem[2]', path: 'tb.mem[2]', key: 'word' };
    assert.equal(D.bitSignals(word)[0].name, 'mem[2][7]');
    assert.equal(D.bitSignals({ ...bus(), range: undefined })[0].bitIndex, 3);
    assert.equal(D.bitSignals({ ...bus(), type: 'real' }).length, 0);
});

test('位投影保持X/Z、缩短向量的零扩展及空值，不为超宽声明分配填充字符串', () => {
    assert.equal(D.bitValue('1', 3), '0'); assert.equal(D.bitValue('x', 999999), 'x');
    assert.equal(D.bitValue('z01', 2), 'z'); assert.equal(D.bitValue(null, 0), null);
    const bit = D.bitSignals(bus())[0];
    assert.equal(M.formatValue('x', bit), 'x');
    const projected = D.projectSeries({ changes: [{t:0,value:'0000'},{t:1,value:'0001'},{t:2,value:'1001'}], dense: [{start:4,end:5,count:9}] }, bit);
    assert.deepEqual(projected.changes, [{t:0,value:'0'},{t:2,value:'1'}]);
    assert.equal(projected.dense.length, 1);
});

test('恢复派生位只接受存在父信号与合法位号，别名和同名切片保持独立身份', () => {
    const parent = bus(), bit = D.bitSignals(parent)[2], signals = new Map([[parent.key,parent]]);
    D.restoreBits([bit.key, '["$bit","tb.ctrl",999]', '["$bit","missing",0]'], signals, 2000);
    assert.equal(signals.get(bit.key).bitOffset, 1); assert.equal(signals.size, 2);
    const slices = M.prepareSignals([{...bus(),key:undefined,id:'a'},{...bus('[3:0]'),key:undefined,id:'b'}]);
    assert.notEqual(D.bitSignals(slices[0])[0].key,D.bitSignals(slices[1])[0].key);
});

test('高亮仅恢复登记颜色和有效行，保留安全属性名，任意CSS输入被拒绝', () => {
    const keys = new Map([['a', {}], ['__proto__', {}]]);
    const restored = D.restoreHighlights(JSON.parse('{"a":"sky","__proto__":"rose","bad":"url(x)"}'), keys);
    assert.equal(Object.getPrototypeOf(restored), null); assert.equal(restored.a, 'sky'); assert.equal(restored.__proto__, 'rose');
    assert.equal(D.highlightColor('url(x)'), null); assert.equal(D.highlightColor('sky'), '#1684d6');
});

function roles(text, vars) { return classifySignals(vars, createRoleIndex([{file:'test.sv',model:parseDocument(text)}])); }
const v = (scopePath,name,id='!') => ({scopePath,name,path:scopePath+'.'+name,id,type:'wire',width:1});
test('方向取自精确模块与实例层级，输入输出及内部wire/reg分离，同id别名不共用方向', () => {
    const vars = [v('tb','a'),v('tb.dut','a'),v('tb.dut','b'),v('tb.dut','c'),v('tb.dut','n'),v('tb.dut','q'),v('tb','i_fake')];
    const result = roles('module tb; reg a; wire i_fake; child dut(.a(a)); endmodule module child(input a, output reg b, inout c); wire n; reg q; endmodule', vars);
    assert.deepEqual(result.map(s=>s.role), ['internal','input','output','inout','internal','internal','internal']);
    assert.equal(result[0].roleSource, 'RTL'); assert.equal(vars[0].role, undefined);
});

test('非ANSI端口的reg重声明不抹掉output，缺源码、歧义及条件分支不猜方向', () => {
    assert.deepEqual(roles('module top(a,b); input a; output b; reg b; endmodule',[v('top','a'),v('top','b')]).map(s=>s.role),['input','output']);
    assert.equal(roles('module top(input a); endmodule module top(output a); endmodule',[v('top','a')])[0].role,'unknown');
    assert.equal(roles('module other; wire i_fake; endmodule',[v('missing','i_fake')])[0].role,'unknown');
    assert.equal(roles('module top; `ifdef X\n input a; `else\n output a; `endif\n endmodule',[v('top','a')])[0].role,'unknown');
});

test('实际控制器批量背景色冻结右键目标，持久化且不重新查询VCD', async () => {
    const h=clientHarness(); await h.flush(); h.pointer('tb.a'); h.pointer('tb.b',{ctrlKey:true});
    const menu=h.contextMenu('tb.a'); const highlights=menu.items.find(item=>item.id==='signal-highlight');
    h.pointer('tb.c'); highlights.submenu.find(item=>item.id==='highlight-sky').action(); await h.flush();
    assert.equal(h.state.highlights['tb.a'],'sky'); assert.equal(h.state.highlights['tb.b'],'sky'); assert.equal(h.state.highlights['tb.c'],undefined);
    assert.equal(h.persisted().highlights['tb.a'],'sky'); assert.deepEqual(h.messages.filter(m=>m.requestId).map(m=>m.type),['window','values']);
});

test('目录中的信号可点击或按键切换添加和移除，批量添加保持幂等', async () => {
    const h = clientHarness(); await h.flush();
    h.node('clearSignals').click();
    const row = () => h.node('catalogSpace').children.find(item => item.title.startsWith('tb.a ·'));
    row().click(); assert.deepEqual([...h.state.selected], ['tb.a']);
    row().click(); assert.deepEqual([...h.state.selected], []);
    assert.deepEqual(h.persisted().selected, []);
    let prevented = false;
    row().onkeydown({ key: 'Enter', preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.deepEqual([...h.state.selected], ['tb.a']);
    row().onkeydown({ key: ' ', preventDefault() {} }); assert.deepEqual([...h.state.selected], []);
    h.node('addFiltered').click(); h.node('addFiltered').click();
    assert.deepEqual([...h.state.selected], ['tb.a', 'tb.b', 'tb.c']);
});

test('目录移除已拆分的总线时同步移除其派生行，其他信号和保存状态保持一致', async () => {
    const parent = { ...bus(), changeCount: 3 };
    const keep = { key: 'tb.keep', id: 'keep', name: 'keep', path: 'tb.keep', scopePath: 'tb', type: 'wire', width: 1, changeCount: 1 };
    const saved = { fileKey: 'test', selected: [parent.key, keep.key] };
    const h = clientHarness(saved, { vars: [parent, keep] }); await h.flush();
    h.contextMenu(parent.key).items.find(item => item.id === 'split-bus').submenu.find(item => item.id === 'split-unit').action();
    h.find('waveSplitWidth0').value = '2'; h.find('waveSplitConfirm').click(); await h.flush();
    const parts = h.state.rows.filter(row => row.signal.parentKey === parent.key).map(row => row.key);
    assert.equal(parts.length, 2); h.pointer(parts[0]);
    h.node('catalogSpace').children.find(item => item.title.startsWith('tb.ctrl[7:4]')).click();
    assert.deepEqual([...h.state.selected], [keep.key]); assert.equal(h.state.activeKey, keep.key);
    assert.equal(h.state.multi.size, 0); assert.equal(h.state.bitKeys.size, 0);
    assert.ok(parts.every(key => !h.state.signals.has(key)));
    const restored = clientHarness(h.persisted(), { vars: [parent, keep] }); await restored.flush();
    assert.deepEqual([...restored.state.selected], [keep.key]);
    restored.node('catalogSpace').children.find(item => item.title.startsWith('tb.ctrl[7:4]')).click();
    assert.deepEqual([...restored.state.selected], [keep.key, parent.key]);
});

test('实际控制器展开/收起保持父总线，可单独选择和分组，重载恢复位行和颜色', async () => {
    const h=clientHarness(undefined,{vars:[{...bus(),changeCount:3}]}); await h.flush();
    h.contextMenu('tb.ctrl').items.find(item=>item.id==='expand-bus').action(); await h.flush();
    assert.equal(h.state.selected.length,5); const bit=h.state.rows[2].signal;
    assert.equal(bit.bitIndex,6); h.pointer(bit.key); assert.deepEqual([...h.state.multi],[bit.key]);
    h.contextMenu(bit.key).items.find(i=>i.id==='signal-highlight').submenu.find(i=>i.id==='highlight-rose').action();
    const restored=clientHarness(h.persisted(),{vars:[{...bus(),changeCount:3}]}); await restored.flush();
    assert.equal(restored.state.rows.length,5); assert.equal(restored.state.highlights[bit.key],'rose');
    restored.contextMenu('tb.ctrl').items.find(i=>i.id==='collapse-bus').action();
    assert.deepEqual([...restored.state.selected],['tb.ctrl']); assert.equal(restored.state.rows.length,1);
    assert.equal(restored.persisted().highlights[bit.key], 'rose');
    const collapsed = clientHarness(restored.persisted(), { vars:[{...bus(),changeCount:3}] }); await collapsed.flush();
    collapsed.contextMenu('tb.ctrl').items.find(i=>i.id==='expand-bus').action();
    assert.equal(collapsed.state.highlights[bit.key], 'rose');
});

test('超宽展开在分配位行前检查总行预算，标量与real禁用展开', async () => {
    const h=clientHarness(undefined,{vars:[{...bus(),width:1000000,range:undefined,changeCount:3}]}); await h.flush();
    const item=h.contextMenu('tb.ctrl').items.find(i=>i.id==='expand-bus');
    assert.equal(item.disabled,true); assert.match(item.detail,/2000/); assert.equal(h.state.signals.size,1);
    for (const signal of [{...bus(),width:1},{...bus(),type:'real'}]) {
        const other=clientHarness(undefined,{vars:[{...signal,changeCount:3}]}); await other.flush();
        assert.equal(other.contextMenu('tb.ctrl').items.find(i=>i.id==='expand-bus'),undefined);
    }
});

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { VcdStore } = require('../src/waveform/store');
const { VcdSession } = require('../src/waveform/session');
const { readSignalRoles, collectSourceContext } = require('../src/waveform/source-roles');

test('仅一个RTL文件的清单连续失效后有界重试，恢复方向而非误报超预算', async t => {
    const { createSourceCatalog } = require('../src/workspace/source-catalog');
    const { root, file } = await sourceFixture(t);
    let calls = 0, catalog;
    const folder = { uri: { fsPath: root } };
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, RelativePattern: class {}, workspace: {
        workspaceFolders: [folder], textDocuments: [], getWorkspaceFolder: () => folder,
        async findFiles() { const call = ++calls; await new Promise(resolve => setImmediate(resolve)); if (call <= 2) catalog.invalidate(); return [{ fsPath: file }]; }
    } };
    catalog = createSourceCatalog({ vscode }); t.after(() => catalog.dispose());
    const context = await collectSourceContext(vscode, path.join(root, 'a.vcd'), catalog);
    assert.equal(context.truncated, false); assert.deepEqual(context.files, [file]); assert.ok(calls >= 3 && calls <= 8);
});

test('持续变化与真实超预算分别说明，关闭时终止方向清单重试', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(collectSourceContext({}, 'wave.vcd', null, null, { signal: controller.signal }), { name: 'AbortError' });
    const vars = [bus()];
    const transient = await readSignalRoles(vars, { roots: ['any'], files: [], invalidated: true, truncated: true });
    assert.match(transient.sourceRoleNote, /正在变化/); assert.doesNotMatch(transient.sourceRoleNote, /预算/);
    const budget = await readSignalRoles(vars, { roots: ['any'], files: [], truncated: true });
    assert.match(budget.sourceRoleNote, /预算/);
});

test('方向更新保留波形窗口、游标、分组和展开位，仅替换方向元数据', async () => {
    const h = clientHarness(undefined, { vars: [{ ...bus(), changeCount: 3 }] }); await h.flush();
    h.contextMenu('tb.ctrl').items.find(item => item.id === 'expand-bus').action(); await h.flush();
    h.state.view = { start: 20, span: 40 }; h.state.cursorA = 25; h.state.cursorB = 45;
    const before = { selected: [...h.state.selected], rows: h.state.rows, view: h.state.view, groups: h.state.groups, queries: h.messages.length };
    h.windowListeners.message({ data: { type: 'roles', roles: [{ path: 'tb.ctrl', role: 'output', roleSource: 'RTL' }], sourceRoleNote: 'RTL方向匹配 1/1' } });
    assert.deepEqual([...h.state.selected], before.selected); assert.equal(h.state.rows, before.rows);
    assert.equal(h.state.view, before.view); assert.equal(h.state.groups, before.groups);
    assert.equal(h.state.cursorA, 25); assert.equal(h.state.cursorB, 45); assert.equal(h.messages.length, before.queries);
    assert.ok([...h.state.signals.values()].every(signal => signal.role === 'output'));
});

test('无空格内嵌范围仍使用正确RTL下标，转义标识符的括号原样保留', () => {
    const inline = {...bus(),range:undefined,name:'ctrl[7:4]',path:'tb.ctrl[7:4]'};
    assert.equal(D.bitSignals(inline)[0].name,'ctrl[7]');
    assert.equal(D.bitSignals({...inline,name:'\\ctrl[7:4]',path:'tb.\\ctrl[7:4]'})[0].name,'\\ctrl[7:4][3]');
});
function edgeStore(scan = 100000) {
    const store=new VcdStore({maxBitEdgeScan:scan}); store.register(bus());
    for (const [t,value] of [[0,'0000'],[1,'0001'],[2,'0010'],[3,'0011'],[4,'1000'],[5,'1001'],[6,'x001'],[7,'z001']]) store.add('!',t,value);
    return store;
}
test('派生位边沿跳过其它位跳变，前后导航与X/Z事件准确', () => {
    const store=edgeStore();
    assert.deepEqual(store.edge({id:'!',time:0,direction:'next',bitOffset:3}),{time:4,value:'1'});
    assert.deepEqual(store.edge({id:'!',time:6,direction:'previous',bitOffset:3}),{time:4,value:'1'});
    assert.deepEqual(store.edge({id:'!',time:4,direction:'previous',bitOffset:3}),{time:0,value:'0'});
    assert.deepEqual(store.edge({id:'!',time:5,direction:'next',bitOffset:3}),{time:6,value:'x'});
    assert.deepEqual(store.edge({id:'!',time:6,direction:'next',bitOffset:3}),{time:7,value:'z'});
    assert.throws(()=>store.edge({id:'!',time:0,direction:'next',bitOffset:4}));
    assert.throws(()=>store.edge({id:'!',time:0,direction:'next',bitOffset:0.5}));
});
test('位边沿按预算续查而非误报无边沿，续查位置经过验证', () => {
    const store=edgeStore(2), query={id:'!',time:0,direction:'next',bitOffset:3};
    const partial=store.edge(query); assert.equal(partial.time,null); assert.equal(partial.continuation,3);
    assert.deepEqual(store.edge({...query,continuation:partial.continuation}),{time:4,value:'1'});
    assert.throws(()=>store.edge({...query,continuation:-1}));
    assert.throws(()=>store.edge({...query,continuation:0}));
});
test('实际控制器三角与Enter切换；展开只复用父VCD id；bit查询带位偏移', async () => {
    const h=clientHarness(undefined,{vars:[{...bus(),changeCount:3}]}); await h.flush();
    h.event('pointerdown',12,16); h.event('pointerup',12,16); await h.flush();
    assert.equal(h.state.rows.length,5); assert.equal(h.state.metadata.vars.length,1);
    assert.equal(h.messages.filter(m=>m.type==='window').length,1);
    h.canvas.focus(); h.documentListeners.keydown({target:h.canvas,key:'Enter',preventDefault(){}});
    assert.equal(h.state.rows.length,1);
});
async function sourceFixture(t) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'svtools-wave-role-'));
    t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('svtools-wave-role-')); await fs.rm(root,{recursive:true,force:true});});
    const file=path.join(root,'design.sv'); await fs.writeFile(file,'module tb; reg a; child dut(.a(a)); endmodule module child(input a, output reg b); wire n; endmodule');
    return {root,file};
}
test('真实VCD worker加载源上下文并为同id不同层级别名保留不同角色', async t=>{
    const {root,file}=await sourceFixture(t), trace=path.join(root,'trace.vcd');
    await fs.writeFile(trace,'$scope module tb $end $var reg 1 ! a $end $scope module dut $end $var wire 1 ! a $end $var reg 1 # b $end $upscope $end $upscope $end $enddefinitions $end #0 0! 0# #2 1! 1#');
    const session=new VcdSession(); t.after(()=>session.dispose());
    const metadata=await session.open(trace,{roots:[root],files:[file]});
    assert.deepEqual(metadata.vars.map(v=>v.role),['internal','input','output']);
    assert.equal(metadata.vars[0].id,metadata.vars[1].id); assert.match(metadata.sourceRoleNote,/3\/3/);
});
test('源码方向尊重脏缓冲区；扫描不完整、缺失文件和超预算统一降级未知', async t=>{
    const {root,file}=await sourceFixture(t), vars=[v('tb','a')];
    const result=await readSignalRoles(vars,{roots:[root],files:[file],documents:[{file,text:'module tb(output a); endmodule'}]});
    assert.equal(result.vars[0].role,'output');
    for (const context of [{roots:[root],files:[file],truncated:true},{roots:[root],files:[file,path.join(root,'missing.sv')]}]) {
        const unknown=await readSignalRoles(vars,context); assert.equal(unknown.vars[0].role,undefined); assert.match(unknown.sourceRoleNote,/方向未知/);
    }
});
test('方向上下文发现不会openTextDocument，后端忽略glob时仍过滤生成文件', async t=>{
    const {root,file}=await sourceFixture(t); let exclude;
    const vscode={Uri:{file:fsPath=>({fsPath})},RelativePattern:class{constructor(base,pattern){this.base=base;this.pattern=pattern;}},workspace:{
        workspaceFolders:[{uri:{fsPath:root}}],getWorkspaceFolder:()=>null,textDocuments:[],
        findFiles:async(pattern,ignored)=>{exclude=ignored;return [{fsPath:file},{fsPath:path.join(root,'.svtools','generated.sv')}];},
        openTextDocument(){assert.fail('方向查找不得触发文档打开事件');}
    }};
    const context=await collectSourceContext(vscode,path.join(root,'a.vcd'));
    assert.deepEqual(context.files,[file]); assert.match(exclude,/\.svtools/);
});

test('位边沿直接读取压缩载荷，不解码百万位字符串；短X/Z仍正确扩展', () => {
    const store=new VcdStore(); store.register({...bus(),width:1000000});
    store.add('!',0,'0'.repeat(1000000)); store.add('!',2,'1'+'0'.repeat(999999)); store.add('!',3,'z');
    store.valuesPool.get=()=>assert.fail('位查询不应解码整条总线');
    assert.deepEqual(store.edge({id:'!',time:0,direction:'next',bitOffset:999999}),{time:2,value:'1'});
    assert.deepEqual(store.edge({id:'!',time:2,direction:'next',bitOffset:999999}),{time:3,value:'z'});
});

test('切换活动信号使迟到的位边沿结果失效，不能跳动新目标的游标', async () => {
    const h=clientHarness(undefined,{vars:[{...bus(),changeCount:3}]});await h.flush();
    h.contextMenu('tb.ctrl').items.find(i=>i.id==='expand-bus').action();await h.flush();
    const bit=h.state.rows[2].signal;h.pointer(bit.key);
    const moving=h.node('nextEdge').onclick(), query=h.messages.findLast(m=>m.type==='edge');
    assert.equal(query.params.bitOffset,2);h.pointer('tb.ctrl');
    h.windowListeners.message({data:{type:'response',requestId:query.requestId,result:{time:80,value:'1'}}});
    await moving;assert.equal(h.state.cursorA,0);
});

test('两段拆分、固定单元余数、升序和负下标均保持原声明位序与绝对偏移', () => {
    const parent = { ...bus('[15:0]'), width: 16 };
    const pair = D.splitSignals(parent, 'pair', [4, 12]);
    assert.deepEqual(pair.map(s => [s.name, s.width, s.sliceOffset]), [['ctrl[15:12]',4,12],['ctrl[11:0]',12,0]]);
    const again = D.splitSignals(pair[1], 'pair', [4,8]);
    assert.deepEqual(again.map(s => s.name), ['ctrl[11:8]','ctrl[7:0]']);
    assert.ok(again.every(s => s.parentKey === parent.key && s.sourceWidth === 16));
    assert.equal(M.formatValue('1011001000011111', pair[0]), '0xB');
    assert.equal(M.formatValue('1011001000011111', again[0]), '0x2');
    assert.equal(M.formatValue('1011', pair[0], 'hex', true), '0xB');
    assert.deepEqual(D.splitSignals({ ...parent, range: '[0:15]' }, 'unit', [6]).map(s => s.name), ['ctrl[0:3]','ctrl[4:9]','ctrl[10:15]']);
    assert.deepEqual(D.splitSignals(bus('[-1:-4]'), 'pair', [2,2]).map(s => s.name), ['ctrl[-1:-2]','ctrl[-3:-4]']);
    assert.equal(D.sliceValue('z1',4,4),'zzzz'); assert.equal(D.sliceValue('1',4,4),'0000');
    const series = D.projectSeries({ changes:[{t:0,value:'0000'},{t:1,value:'0001'},{t:2,value:'1101'}],dense:[] }, D.splitSignals(bus(), 'pair', [2,2])[0]);
    assert.deepEqual(series.changes,[{t:0,value:'00'},{t:2,value:'11'}]);
    for (const args of [['pair',[1,2]],['pair',[0,4]],['unit',[4]],['unit',[0]],['unit',[1.5]]]) assert.throws(()=>D.splitSignals(bus(),...args),RangeError);
    assert.throws(()=>D.splitSignals({...bus(),width:1000000},'unit',[1]),/2000/);
});

test('实际拆分对话框校验输入，重复拆分替换原段，同层保存恢复并查询原始总线', async () => {
    const parent = { ...bus('[15:0]'), width: 16, changeCount: 3 };
    const h = clientHarness(undefined,{vars:[parent]}); await h.flush();
    const open = (key,mode) => h.contextMenu(key).items.find(i=>i.id==='split-bus').submenu.find(i=>i.id===mode).action();
    open(parent.key,'split-pair');
    h.find('waveSplitWidth0').value='5'; h.find('waveSplitWidth1').value='5'; h.find('waveSplitConfirm').click();
    assert.match(h.find('waveSplitError').textContent,/之和/); assert.equal(h.state.rows.length,1);
    h.find('waveSplitWidth0').value='4'; h.find('waveSplitWidth1').value='12'; h.find('waveSplitConfirm').click(); await h.flush();
    assert.deepEqual(h.state.rows.map(row=>row.signal.width),[16,4,12]);
    const lower=h.state.rows[2].signal;
    h.pointer(lower.key);
    open(lower.key,'split-unit'); h.find('waveSplitWidth0').value='4'; h.find('waveSplitConfirm').click(); await h.flush();
    assert.deepEqual(h.state.rows.map(row=>row.signal.name),['ctrl','ctrl[15:12]','ctrl[11:8]','ctrl[7:4]','ctrl[3:0]']);
    assert.ok(h.state.rows.slice(1).every(row=>row.signal.parentKey===parent.key)); assert.ok(!h.state.signals.has(lower.key));
    assert.deepEqual(h.messages.filter(m=>m.type==='window').map(m=>[...m.params.ids]),[['!']]);
    const reloaded=clientHarness(h.persisted(),{vars:[parent]}); await reloaded.flush();
    assert.deepEqual(reloaded.state.rows.map(row=>row.signal.name),h.state.rows.map(row=>row.signal.name));
    const S=require('../src/waveform/layout-state'), layout=S.capture(h.state), signals=new Map([[parent.key,parent]]);
    const restored=S.restore(layout,signals,{endTime:100,secondsPerTick:1e-9});
    assert.deepEqual(restored.selected,[...h.state.selected]);
    const before=[...h.state.selected];
    h.contextMenu(parent.key).items.find(i=>i.id==='collapse-bus').action(); assert.equal(h.state.rows.length,1);
    h.event('pointerdown',12,16); h.event('pointerup',12,16);
    assert.deepEqual([...h.state.selected],before);
    const high=h.state.rows[1].signal; h.pointer(high.key); const moving=h.node('nextEdge').onclick(),query=h.messages.findLast(m=>m.type==='edge');
    assert.equal(query.params.bitOffset,12); assert.equal(query.params.bitWidth,4);
    h.windowListeners.message({data:{type:'response',requestId:query.requestId,result:{time:40,value:'1'}}}); await moving;
    assert.equal(h.state.cursorA,40);
});

test('切片边沿只考虑所选段，忽略其它位跳变，扫描预算可续查且不解码完整向量', () => {
    const store=edgeStore(4); store.valuesPool.get=()=>assert.fail('不得解码完整向量');
    assert.deepEqual(store.edge({id:'!',time:0,direction:'next',bitOffset:2,bitWidth:2}),{time:null,value:null,continuation:3});
    assert.deepEqual(store.edge({id:'!',time:0,direction:'next',bitOffset:2,bitWidth:2,continuation:3}),{time:4,value:'10'});
    assert.deepEqual(store.edge({id:'!',time:5,direction:'previous',bitOffset:2,bitWidth:2}),{time:4,value:'10'});
    assert.throws(()=>store.edge({id:'!',time:0,direction:'next',bitOffset:3,bitWidth:2}));
});

test('Questa逐位dump与重复声明还原为总线，保留真正的bit mem和不同作用域别名', async t => {
    const {root,file}=await sourceFixture(t),trace=path.join(root,'split.vcd');
    await fs.writeFile(file,'module top; wire [3:0] data; reg mem[0:1]; child dut(); endmodule module child(input [3:0] data); endmodule');
    const declarations='$var wire 1 ! data [3] $end $var wire 1 # data [2] $end $var wire 1 $ data [1] $end $var wire 1 % data [0] $end ';
    await fs.writeFile(trace,'$scope module top $end '+declarations+declarations+'$var reg 1 m mem [0] $end $var reg 1 n mem [1] $end $scope module dut $end '+declarations+'$upscope $end $upscope $end $enddefinitions $end #0 0! 0# x$ z% 0m 1n #3 1! 1# #5 0%');
    const session=new VcdSession(); t.after(()=>session.dispose());
    const metadata=await session.open(trace,{roots:[root],files:[file]});
    const parent=metadata.vars.find(v=>v.path==='top.data'),alias=metadata.vars.find(v=>v.path==='top.dut.data');
    assert.equal(parent.width,4); assert.equal(parent.range,'[3:0]'); assert.equal(parent.role,'internal'); assert.equal(alias.role,'input'); assert.equal(parent.id,alias.id);
    assert.equal(metadata.vars.length,4); assert.ok(metadata.vars.some(v=>v.path==='top.mem[0]'));
    assert.equal((await session.values({ids:[parent.id],time:0})).values[parent.id],'00xz');
    assert.equal((await session.values({ids:[parent.id],time:3})).values[parent.id],'11xz');
    const window=await session.window({ids:[parent.id],start:0,end:6,pixels:100});
    assert.deepEqual(window.series[0].changes,[{t:0,value:'00xz'},{t:3,value:'11xz'},{t:5,value:'11x0'}]);
    assert.deepEqual(await session.edge({id:parent.id,time:0,direction:'next',bitOffset:2,bitWidth:2}),{time:3,value:'11'});
    const roles=await session.roles({roots:[root],files:[file]}); assert.equal(roles.roles.find(v=>v.path===parent.path).role,'internal');
    const initiallyUnknown=new VcdSession(); t.after(()=>initiallyUnknown.dispose());
    const raw=await initiallyUnknown.open(trace); assert.equal(raw.vars.length,14);
    const retried=await initiallyUnknown.roles({roots:[root],files:[file]}); assert.equal(retried.vars.length,4);
    assert.equal((await initiallyUnknown.values({ids:[retried.vars.find(v=>v.path==='top.data').id],time:3})).values[parent.id],'11xz');
    const h=clientHarness({fileKey:'test',selected:['top.data[3]','top.data[2]']},{vars:metadata.vars}); await h.flush();
    assert.deepEqual([...h.state.selected],['top.data']);
});

test('缺RTL、索引空洞和不同ID的重名逐位声明不擅自合并', () => {
    const { restorePackedBuses }=require('../src/waveform/packed-buses');
    const vars=[3,2,1,0].map((index)=>({id:String(index),width:1,type:'wire',name:'d['+index+']',path:'top.d['+index+']',scopePath:'top'}));
    const store={compose(){assert.fail('不应合并');}};
    assert.deepEqual(restorePackedBuses(vars,store),vars);
    const marked=vars.map(v=>({...v,packedBit:{name:'d',index:Number(v.id)}}));
    assert.deepEqual(restorePackedBuses([marked[0],marked[2]],store),[marked[0],marked[2]]);
    assert.equal(restorePackedBuses([...marked,{...marked[0],id:'conflict'}],store).length,5);
});
