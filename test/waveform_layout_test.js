'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/waveform/model');
const D = require('../src/waveform/signal-display');
const S = require('../src/waveform/layout-state');
const L = require('../src/waveform/row-layout');
const vars = id => M.prepareSignals([{ id, path: 'tb.bus', name: 'bus', width: 4, range: '[7:4]', type: 'wire' }]);
test('布局按路径、声明范围和位偏移跨 VCD 标识符恢复，隐藏位配置仍保留', () => {
    const signals = new Map(vars('!').map(s => [s.key, s]));
    const bit = D.bitSignals(signals.get('tb.bus'), 4)[1]; signals.set(bit.key, bit);
    const saved = S.capture({ signals, selected: ['tb.bus'], bitKeys: new Set([bit.key]), formats: { [bit.key]: 'bin' },
        highlights: { [bit.key]: 'rose' }, groups: { [bit.key]: '控制' }, heights: {}, columns: {}, collapsedGroups: ['控制'],
        view: { start: 10, span: 20 }, cursorA: 15, cursorB: 25, secondsPerTick: 1e-9 });
    const next = new Map(vars('changed').map(s => [s.key, s]));
    const restored = S.restore(JSON.parse(JSON.stringify(saved)), next, { endTime: 100, secondsPerTick: 1e-9 });
    assert.deepEqual(restored.selected, ['tb.bus']);
    const key = [...restored.bitKeys][0];
    assert.equal(next.get(key).id, 'changed'); assert.equal(restored.highlights[key], 'rose');
    assert.equal(restored.formats[key], 'bin'); assert.equal(restored.groups[key], '控制');
    assert.deepEqual(restored.missing, []); assert.equal(restored.cursorA, 15);
});
test('布局报告缺失或不唯一信号，拒绝版本错误和超大行集，时间按 timescale 换算', () => {
    const signals = new Map(vars('!').map(s => [s.key, s]));
    const saved = S.capture({ signals, selected: ['tb.bus'], view: { start: 10, span: 20 }, cursorA: 15, cursorB: null, secondsPerTick: 1e-9 });
    const missing = S.restore(saved, new Map(), { endTime: 100, secondsPerTick: 1e-9 });
    assert.equal(missing.missing.length, 1);
    const next = S.restore(saved, signals, { endTime: 1000, secondsPerTick: 1e-10 });
    assert.equal(next.cursorA, 150); assert.equal(next.view.span, 200);
    assert.throws(() => S.validate({ ...saved, version: 999 }), /版本/);
    assert.throws(() => S.validate({ ...saved, tracks: Array(2001).fill(saved.tracks[0]) }), /2000/);
});
test('分组收起仅影响可见行，不改变成员顺序或设置', () => {
    const signals = new Map(['a','b','c'].map(key => [key, { key, name:key, path:key, type:'wire', width:1 }]));
    const rows = L.buildRows(['a','b','c'], signals, {}, {}, { a:'控制', c:'控制' }, ['控制']);
    assert.deepEqual(rows.map(row => row.key), ['a','b']); assert.equal(rows[0].groupSummary, '控制'); assert.equal(rows[0].groupCount, 2);
    assert.deepEqual(L.buildRows(['a','b','c'], signals, {}, {}, { a:'控制', c:'控制' }, []).map(row => row.key), ['a','b','c']);
});

const { createLayoutFiles } = require('../src/waveform/layout-files');
test('保存布局不能将JSON写进RTL或其他非布局扩展名',async()=>{
    const layout=S.capture({signals:new Map(vars('!').map(s=>[s.key,s])),selected:['tb.bus'],view:{start:0,span:100},cursorA:0,cursorB:null});
    let writes=0;
    const files=createLayoutFiles({filePath:'/p/test.vcd',vscode:{workspace:{fs:{async writeFile(){writes++;}}}}});
    await assert.rejects(files.save(layout,{scheme:'file',fsPath:'/p/design.sv'}),/json/i);
    assert.equal(writes,0);
});
test('布局文件通过用户选择的独立URI读写，取消、超预算、覆盖VCD和损坏JSON有明确结果', async () => {
    const layout=S.capture({signals:new Map(vars('!').map(s=>[s.key,s])),selected:['tb.bus'],view:{start:0,span:100},cursorA:0,cursorB:null});
    let data, size=0, picked;
    const uri=file=>({scheme:'file',fsPath:file});
    const files=createLayoutFiles({filePath:'/p/test.vcd',vscode:{Uri:{file:uri},window:{showSaveDialog:async()=>picked,showOpenDialog:async()=>picked?[picked]:undefined},
        workspace:{fs:{writeFile:async(_uri,bytes)=>{data=bytes;},stat:async()=>({size}),readFile:async()=>data}}}});
    assert.equal(await files.save(layout),false);assert.equal(await files.load(),null);
    picked=uri('/p/test.svwave.json');assert.equal(await files.save(layout),true);size=data.length;
    assert.deepEqual((await files.load()).tracks,JSON.parse(JSON.stringify(layout.tracks)));
    await assert.rejects(files.save(layout,uri('/p/test.vcd')),/覆盖 VCD/);
    size=S.MAX_BYTES+1;await assert.rejects(files.load(),/4 MiB/);size=2;data=Buffer.from('{!');await assert.rejects(files.load(),SyntaxError);
});
const { clientHarness } = require('./helpers/waveform-client-harness');
test('真实控制器分组收起、重载和展开不删除成员，并从可见查询中排除摘要', async()=>{
    const h=clientHarness({fileKey:'test',selected:['tb.a','tb.b','tb.c'],groups:{'tb.a':'控制','tb.b':'控制'}});await h.flush();
    h.contextMenu('tb.a').items.find(item=>item.id==='toggle-group-控制').action();await h.flush();
    assert.equal(h.state.rows.length,2);assert.equal(h.state.selected.length,3);assert.equal(h.state.rows[0].groupSummary,'控制');
    const latest=h.messages.filter(m=>m.type==='window').at(-1);assert.deepEqual([...latest.params.ids],['c']);
    const next=clientHarness(h.persisted());await next.flush();assert.equal(next.state.rows.length,2);
    next.contextMenu('tb.a').items.find(item=>item.id==='toggle-group-控制').action();await next.flush();assert.equal(next.state.rows.length,3);
});

test('收起组之后的拖拽槽位按真实成员数计算，拖动摘要移动整个组',async()=>{
    const h=clientHarness({fileKey:'test',selected:['tb.a','tb.b','tb.c'],groups:{'tb.a':'组','tb.b':'组'},collapsedGroups:['组']});await h.flush();
    assert.equal(L.insertionSlot(h.state.rows,['tb.c'],39),2);
    h.event('pointerdown',80,18);h.event('pointermove',80,90);h.event('pointerup',80,90);h.settleFrames();
    assert.deepEqual([...h.state.selected],['tb.c','tb.a','tb.b']);
});
