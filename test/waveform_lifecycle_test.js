'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createWaveformRegistry } = require('../src/waveform/registry');
const { simulationWaveforms } = require('../src/toolchains/simulation-waveforms');
function deferred() { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; }
function entry(registry, file, released = Promise.resolve(), sourceFile) {
    const listeners = new Set(); let closed = false, disposed = 0;
    const panel = { active: true, dispose() { if (closed) return; closed=true; for (const fn of [...listeners]) fn(); },
        onDidDispose(fn) { listeners.add(fn); return {dispose() { listeners.delete(fn); }}; } };
    const binding = { dispose() { disposed++; return released; } };
    registry.attach(file, panel, binding, sourceFile);
    return { panel, get closed() {return closed;}, get disposed() {return disposed;} };
}
const root = path.join(os.tmpdir(), 'svtools-wave-lifecycle');

test('仿真释放精确波形并等待worker，保护写入直到租约结束，其它波形保持打开', async () => {
    const registry=createWaveformRegistry(), release=deferred(), file=path.join(root,'a.vcd');
    const target=entry(registry,file,release.promise), other=entry(registry,path.join(root,'b.vcd'));
    let ready=false;
    const preparing=registry.prepareForSimulation({paths:[file],directory:root}).then(lease => {ready=true;return lease;});
    assert.equal(target.closed,true); assert.equal(other.closed,false);
    assert.throws(()=>registry.get(file),/重新仿真/); await nextTurn(); assert.equal(ready,false);
    release.resolve(); const lease=await preparing; assert.equal(target.disposed,1);
    assert.throws(()=>registry.assertAvailable(file),/重新仿真/);
    lease.dispose(); registry.assertAvailable(file); assert.ok(registry.get(path.join(root,'b.vcd')));
    await registry.dispose();
});

test('用户先关闭的面板仍有释放屏障；仿真不会漏掉正在退出的worker', async () => {
    const registry=createWaveformRegistry(), release=deferred(), file=path.join(root,'a.vcd');
    const target=entry(registry,file,release.promise); target.panel.dispose();
    let ready=false;
    const preparing=registry.prepareForSimulation({paths:[file],directory:root}).then(lease=>{ready=true;return lease;});
    await nextTurn(); assert.equal(ready,false); release.resolve(); const lease=await preparing;
    assert.equal(target.disposed,1); lease.dispose(); await registry.dispose();
});

test('动态文件名复用源文件关联，目录回退覆盖子目录但不波及相邻工程', async () => {
    const registry=createWaveformRegistry(), source=path.join(root,'tb.sv');
    const historical=entry(registry,path.join(os.tmpdir(),'outside-capture.vcd'),undefined,source);
    const nested=entry(registry,path.join(root,'waves','a.vcd'));
    const sibling=entry(registry,path.join(root+'-other','a.vcd'));
    const lease=await registry.prepareForSimulation({sourceFile:source,paths:[],directory:root,uncertain:true});
    assert.equal(historical.closed,true); assert.equal(nested.closed,true); assert.equal(sibling.closed,false);
    assert.throws(()=>registry.assertAvailable(path.join(root,'new.vcd')),/重新仿真/);
    registry.assertAvailable(path.join(root+'-other','new.vcd')); lease.dispose(); await registry.dispose();
});

test('释放失败时撤销写入保护并向调用方报告，不能误报已准备完成', async () => {
    const registry=createWaveformRegistry(), file=path.join(root,'a.vcd');
    entry(registry,file,Promise.reject(new Error('worker exit failed')));
    await assert.rejects(registry.prepareForSimulation({paths:[file],directory:root}),/worker exit failed/);
    registry.assertAvailable(file); await registry.dispose();
});

async function sourceFixture(t, source, extras={}) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'svtools-dump-paths-'));
    t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});});
    const file=path.join(directory,'tb.sv'); await fs.writeFile(file,source);
    for (const [name, text] of Object.entries(extras)) { await fs.mkdir(path.dirname(path.join(directory,name)),{recursive:true});await fs.writeFile(path.join(directory,name),text); }
    return {directory,file};
}

test('磁盘源码发现字面dumpfile，忽略注释和字符串里的伪调用', async t => {
    const f=await sourceFixture(t, '// $dumpfile("fake.vcd");\ninitial begin $display("$dumpfile(fake)"); $dumpfile(/* comment */ "waves/a.vcd"); $dumpvars; end');
    assert.deepEqual(await simulationWaveforms({files:[f.file],directory:f.directory}),{paths:[path.join(f.directory,'waves','a.vcd'),path.join(f.directory,'dump.vcd')],uncertain:false});
});

test('include路径与循环引用使用同一词法事实，输出路径以仿真cwd为基准', async t => {
    const f=await sourceFixture(t,'`include "dump.svh"\n',{'inc/dump.svh':'`include "dump.svh"\ninitial $dumpfile("run.vcd");'});
    assert.deepEqual(await simulationWaveforms({files:[f.file],directory:f.directory,includePaths:[path.join(f.directory,'inc')]}),{paths:[path.join(f.directory,'run.vcd')],uncertain:false});
});

test('默认dump.vcd、动态表达式、宏调用与超预算均保守标识', async t => {
    for (const [source,expected,uncertain] of [
        ['initial $dumpvars;', 'dump.vcd', false],
        ['initial $dumpfile($sformatf("%s.vcd", name));', null, true],
        ['`define DUMP $dumpfile("macro.vcd");\ninitial `DUMP;', null, true],
        ['x'.repeat(1024*1024+1),null,true]
    ]) {
        const f=await sourceFixture(t,source), result=await simulationWaveforms({files:[f.file],directory:f.directory});
        assert.deepEqual(result.paths,expected?[path.join(f.directory,expected)]:[]); assert.equal(result.uncertain,uncertain);
    }
});

test('路径扫描响应取消，不启动迟到的读文件工作', async () => {
    const controller=new AbortController();controller.abort();
    await assert.rejects(simulationWaveforms({files:[],directory:root,signal:controller.signal}),{name:'AbortError'});
});


for (const statement of ['`ifdef NAMED_DUMP\n$dumpfile("named.vcd");\n`endif', 'if (0) $dumpfile("named.vcd");']) {
    test('条件dumpfile未执行时，默认dump.vcd仍被关闭并保护：' + statement.split('\n')[0], async t => {
        const f = await sourceFixture(t, 'module tb; initial begin\n' + statement + '\n$dumpvars(0,tb); end endmodule');
        const output = await simulationWaveforms({files:[f.file], directory:f.directory});
        const fallback = path.join(f.directory,'dump.vcd');
        assert.ok(output.paths.includes(fallback), JSON.stringify(output));
        const registry = createWaveformRegistry(), old = entry(registry, fallback);
        const lease = await registry.prepareForSimulation({...output,directory:f.directory,sourceFile:f.file});
        assert.equal(old.closed,true);assert.throws(()=>registry.assertAvailable(fallback),/重新仿真/);
        lease.dispose();await registry.dispose();
    });
}


test('运行时默认dumpfile和条件RTL字面路径同时进入关闭屏障', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-dump-override-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'tb.sv'), custom = path.join(directory, 'custom wave.vcd');
    await fs.writeFile(file, 'module tb; initial begin if(0) $dumpfile("named.vcd"); $dumpvars(0,tb); end endmodule');
    const discovery = await simulationWaveforms({ files: [file], directory, defaultDumpfiles: [custom] });
    assert.deepEqual(new Set(discovery.paths), new Set([custom, path.join(directory, 'named.vcd')]));
    const registry = createWaveformRegistry(), target = entry(registry, custom);
    const lease = await registry.prepareForSimulation({ ...discovery, directory });
    assert.equal(target.closed, true); assert.throws(() => registry.assertAvailable(custom), /重新仿真/);
    lease.dispose(); await registry.dispose();
});
