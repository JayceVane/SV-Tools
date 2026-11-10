'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { postprocessWaveforms } = require('../src/waveform/conversion');
const { nativeApi } = require('../src/waveform/rust-backend');

const TRACE = `$date today $end $version conversion test $end
$timescale 10 ps $end
$scope module tb $end
$var wire 1 ! clk $end
$var logic 8 " data [0:7] $end
$var wire 8 " alias [15:8] $end
$var real 64 # voltage $end
$var reg 4 $ mem[2] [3:0] $end
$scope module empty $end $upscope $end
$upscope $end $enddefinitions $end
#0 $dumpvars 0! bx " r1.25 # b1010 $ $end
#5 1! bZ " r-2.5 # b0 $
#10 0! b10x1 " r3.125 # b1z $
#25
`;
async function fixture(t, text = TRACE, name = 'trace.vcd') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-conversion-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('svtools-conversion-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const file = path.join(directory, name); await fs.writeFile(file, text);
    return { directory, file, target: path.join(directory, 'converted.fst') };
}
const convert = async (source, target) => JSON.parse(await nativeApi().waveConvertVcdToFstAsync(source, target));
const metadata = file => JSON.parse(nativeApi().waveOpen(file));
const values = (file, at) => JSON.parse(nativeApi().waveValues(null, file, 'tb.clk,tb.data,tb.alias,tb.voltage,tb.mem[2]', String(at))).values;

test('内嵌转换跨读取器保真：别名、层级、升序位号、mem、实数、X/Z 与末尾时间', async t => {
    const f = await fixture(t), stats = await convert(f.file, f.target);
    assert.equal(stats.signals, 4); assert.equal(stats.changes, 12);
    assert.equal(stats.sourceBytes, (await fs.stat(f.file)).size);
    const before = metadata(f.file), after = metadata(f.target);
    assert.equal(after.endTime, before.endTime); assert.equal(after.endTime, '25');
    assert.equal(after.timescale.replace(/\s/g, ''), before.timescale.replace(/\s/g, ''));
    const pick = meta => meta.vars.map(v => [v.path, v.width, v.msb, v.lsb]);
    assert.deepEqual(pick(after), pick(before));
    // FST 读取器会为 mem[addr] 建立额外数组作用域；原有空层级必须完整保留。
    const originalScopes = before.scopes.map(scope => scope.path);
    assert.deepEqual(after.scopes.map(scope => scope.path).filter(scope => originalScopes.includes(scope)), originalScopes);
    assert.ok(after.scopes.some(scope => scope.path === 'tb.empty'));
    for (const at of [0, 4, 5, 9, 10, 25]) assert.deepEqual(values(f.target, at), values(f.file, at), 'tick ' + at);
    assert.equal((await fs.readFile(f.file, 'utf8')), TRACE, '底层转换不修改源文件');
});

test('实际 Icarus 层级 VCD 转换后与原波形无差异', async t => {
    const f = await fixture(t, await fs.readFile(path.join(__dirname, 'fixtures/waveform/hierarchy.vcd')));
    await convert(f.file, f.target);
    const diff = JSON.parse(nativeApi().waveDiff(f.file, f.target));
    assert.equal(diff.totalDiffs, 0); assert.equal(diff.firstDiff, null);
});

test('多块转换保持跨块边界值与超 32 位时刻', async t => {
    const f = await fixture(t, '$timescale 1 fs $end $scope module tb $end $var wire 1 ! clk $end $upscope $end $enddefinitions $end\n#0 0!\n');
    const stream = await fs.open(f.file, 'a');
    try {
        let batch = '';
        for (let i = 1; i <= 510000; i++) {
            batch += '#' + (4294967296n + BigInt(i)) + '\n' + (i % 2) + '!\n';
            if (i % 5000 === 0) { await stream.write(batch); batch = ''; }
        }
    } finally { await stream.close(); }
    await convert(f.file, f.target);
    assert.equal(metadata(f.target).endTime, metadata(f.file).endTime);
    for (const at of [0,4294967297,4295467295,4295467296,4295477296]) {
        const get = file => JSON.parse(nativeApi().waveValues(null,file,'tb.clk',String(at))).values;
        assert.deepEqual(get(f.target),get(f.file));
    }
});

for (const [name, source] of [
    ['truncated dump', TRACE.replace('$end\n#5', '\n#5')],
    ['backwards time', TRACE + '#1 0!'],
    ['undefined signal', TRACE + '#26 1MISSING'],
    ['invalid vector', TRACE.replace('bZ "', 'bAB "')],
    ['missing unit', TRACE.replace('$timescale 10 ps $end', '')],
    ['uninitialized signal', TRACE.replace('r1.25 #', '')],
    ['delayed initialization', TRACE.replace('#0 $dumpvars', '#0 #1 $dumpvars')],
    ['string extension', '$timescale 1ns $end $scope module tb $end $var string 0 ! text $end $upscope $end $enddefinitions $end #0 sfoo !'],
    ['unsupported EVCD', TRACE.replace('$var logic 8', '$var port 8')]
]) {
    test('转换失败保留 VCD：' + name, async t => {
        const f = await fixture(t, source), warnings = [];
        assert.deepEqual(await postprocessWaveforms([f.file], { enabled: true, onWarning: text => warnings.push(text) }), [f.file]);
        assert.equal(await fs.readFile(f.file, 'utf8'), source);
        assert.ok(warnings.some(text => text.includes('原波形已保留')));
        assert.deepEqual(await fs.readdir(f.directory), ['trace.vcd']);
    });
}

test('默认关闭：不加载转换器、不碰输入文件', async () => {
    const files = ['does-not-exist.vcd'];
    assert.equal(await postprocessWaveforms(files, { native: { waveConvertVcdToFstAsync() { throw new Error('unexpected converter'); } } }), files);
    assert.equal(require('../package.json').contributes.configuration.properties['svtools.waveform.convertVcdToFst'].default, false);
});

test('默认覆盖同名 FST：rename 原子替换，租约同时覆盖目标，既有文件让位', async t => {
    const f = await fixture(t), existing = path.join(f.directory, 'trace.fst'), progress = [];
    await fs.writeFile(existing, 'stale fst to replace');
    let prepared, released = false;
    const waves = await postprocessWaveforms([f.file], { enabled: true, onProgress: text => progress.push(text),
        prepare: async options => { prepared = options; return { dispose() { released = true; } }; } });
    assert.deepEqual(waves, [existing]);
    // 覆盖模式下租约包含目标 FST：Windows 上被查看器打开的文件无法被 rename 替换。
    assert.deepEqual(prepared.paths, [f.file, existing]);
    assert.ok(released); assert.ok(progress.some(text => text.includes('FST 已保存')));
    await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
    assert.equal(metadata(waves[0]).endTime, '25');
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['trace.fst'], '旧内容被替换，不产生 -2 副本');
});

test('关闭覆盖时保留既有 FST，新输出使用递增编号', async t => {
    const f = await fixture(t), existing = path.join(f.directory, 'trace.fst');
    await fs.writeFile(existing, 'keep existing');
    const waves = await postprocessWaveforms([f.file], { enabled: true, overwrite: false,
        prepare: async () => ({ dispose() {} }) });
    assert.deepEqual(waves, [path.join(f.directory, 'trace-2.fst')]);
    assert.equal(await fs.readFile(existing, 'utf8'), 'keep existing');
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['trace-2.fst', 'trace.fst']);
    await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('已有 FST 按内容跳过转换，即使后缀为 VCD', async t => {
    const f = await fixture(t);
    await convert(f.file, f.target); await fs.copyFile(f.target, f.file);
    const before = await fs.readFile(f.file);
    assert.deepEqual(await postprocessWaveforms([f.file], { enabled: true, native: { waveConvertVcdToFstAsync() { throw new Error('must skip'); } } }), [f.file]);
    assert.deepEqual(await fs.readFile(f.file), before);
});

test('转换期间取消不发布、不删 VCD，临时文件与租约均回收', async t => {
    const f = await fixture(t), controller = new AbortController(); let released = false;
    await assert.rejects(postprocessWaveforms([f.file], { enabled: true, signal: controller.signal,
        native: { async waveConvertVcdToFstAsync(source, target) {
            const result = await nativeApi().waveConvertVcdToFstAsync(source, target); controller.abort(); return result;
        } }, prepare: async () => ({ dispose() { released = true; } }) }), { code: 'TOOL_CANCELLED' });
    assert.ok(released); assert.equal(await fs.readFile(f.file, 'utf8'), TRACE);
    assert.deepEqual(await fs.readdir(f.directory), ['trace.vcd']);
});

test('转换期间源被修改不提交旧波形', async t => {
    const f = await fixture(t), warnings = [];
    const waves = await postprocessWaveforms([f.file], { enabled: true, onWarning: text => warnings.push(text), native: {
        async waveConvertVcdToFstAsync(source, target) {
            const result = await nativeApi().waveConvertVcdToFstAsync(source, target); await fs.appendFile(source, '#50 1!\n'); return result;
        }
    } });
    assert.deepEqual(waves, [f.file]); assert.ok(warnings.some(text => text.includes('发生变化')));
    assert.match(await fs.readFile(f.file,'utf8'), /#50/); assert.deepEqual(await fs.readdir(f.directory), ['trace.vcd']);
});

test('底层转换不能覆盖现有目标或源文件', async t => {
    const f = await fixture(t); await fs.writeFile(f.target, 'keep');
    await assert.rejects(convert(f.file, f.target)); await assert.rejects(convert(f.file, f.file));
    assert.equal(await fs.readFile(f.target, 'utf8'), 'keep'); assert.equal(await fs.readFile(f.file,'utf8'),TRACE);
});


test('关闭覆盖且不支持硬链接时回退排他复制，仍保留既有同名文件', async t => {
    const f=await fixture(t); await fs.writeFile(path.join(f.directory,'trace.fst'),'keep');
    t.mock.method(fs,'link',async () => { throw Object.assign(new Error('hard link unsupported'),{code:'EPERM'}); });
    const waves=await postprocessWaveforms([f.file],{enabled:true,overwrite:false});
    assert.deepEqual(waves,[path.join(f.directory,'trace-2.fst')]);
    assert.equal(await fs.readFile(path.join(f.directory,'trace.fst'),'utf8'),'keep');
    assert.equal(metadata(waves[0]).endTime,'25'); await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
});

test('VCD内容即使使用fst后缀也原地替换为FST，不再产生 -2 副本', async t=>{
    const f=await fixture(t,TRACE,'trace.fst');
    const waves=await postprocessWaveforms([f.file],{enabled:true});
    assert.deepEqual(waves,[f.file]);
    assert.equal(metadata(waves[0]).endTime,'25');
    assert.deepEqual(await fs.readdir(f.directory),['trace.fst'],'目标与源同路径，rename 一步完成发布与替换');
});


test('逐位dump的乱序位号与非零下标转换后仍能逐位精确查询', async t => {
    const indices=[15,13,14,12,11,10,8,9];
    const text='$timescale 1ns $end $scope module tb $end '+indices.map((bit,i)=>'$var wire 1 v'+i+' data ['+bit+'] $end').join(' ')+
        ' $upscope $end $enddefinitions $end #0 '+indices.map((bit,i)=>(bit%2)+'v'+i).join(' ')+
        ' #10 '+indices.map((bit,i)=>((bit+1)%2)+'v'+i).join(' ');
    const f=await fixture(t,text);await convert(f.file,f.target);
    const signals=indices.map(bit=>'tb.data['+bit+']').join(',');
    for(const at of ['0','10']){
        const get=file=>JSON.parse(nativeApi().waveValues(null,file,signals,at)).values;
        assert.deepEqual(get(f.target),get(f.file));
    }
});

test('dumpoff/on 显式X/Z和结束后保持原时间域', async t => {
    const text='$timescale 1ns $end $scope module tb $end $var wire 1 ! clk $end $upscope $end $enddefinitions $end '+
        '#0 0! #5 $dumpoff x! $end #10 $dumpon 1! $end #20';
    const f=await fixture(t,text);await convert(f.file,f.target);
    assert.equal(metadata(f.target).endTime,'20');
    for(const at of ['0','5','7','10','20']){
        const get=file=>JSON.parse(nativeApi().waveValues(null,file,'tb.clk',at)).values;
        assert.deepEqual(get(f.target),get(f.file));
    }
});

test('纯事件波形不因延长时间域伪造事件', async t => {
    const text='$timescale 1ns $end $scope module tb $end $var event 1 ! trigger $end $upscope $end $enddefinitions $end #0 1! #5 1! #20';
    const f=await fixture(t,text);await convert(f.file,f.target);
    assert.equal(metadata(f.target).endTime,metadata(f.file).endTime);
    const get=file=>JSON.parse(nativeApi().waveChanges(null,file,'tb.trigger',-1,null,100)).series;
    assert.deepEqual(get(f.target),get(f.file));
});
