'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), path=require('node:path'),os=require('node:os');
const { createHash }=require('node:crypto');
const { run }=require('../src/cli/main');
const { nativeApi }=require('../src/waveform/rust-backend');
const TRACE=`$timescale 1 ns $end
$scope module tb $end
$var wire 1 AA q $end $var wire 1 AA alias $end
$var wire 1 BB normal $end $var wire 8 CC bus [7:0] $end
$upscope $end $enddefinitions $end
#0 0AA 0BB b0 CC
#10 1AA 0AA b1 CC b0 CC 1BB
#20 1AA 0AA 1AA
#30 xAA 1AA
#40 0AA
#50
`;
async function fixture(t,text=TRACE) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'svtools-delta-tool-'));
    const file=path.join(directory,'trace.vcd');await fs.writeFile(file,text);
    t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('svtools-delta-tool-'));await fs.rm(directory,{recursive:true,force:true});});
    return {directory,file};
}
const query=(f,args=[])=>run(['wave','glitches','--workspace',f.directory,'--file',f.file,'--signals','tb.q',...args]);
test('同刻诊断给出真实记录顺序、前值/终值、分类与文件证据，稳定值查询保持原语义',async t=>{
    const f=await fixture(t), result=await query(f);assert.equal(result.exitCode,0,JSON.stringify(result.output));
    const data=result.output.data;assert.equal(result.output.operation,'wave.glitches');assert.equal(data.complete,true);assert.equal(data.matched,3);
    const findings=data.series[0].findings;
    assert.deepEqual(findings.map(x=>[x.t,x.classification,x.before,x.settled]),[['10','returning','0','0'],['20','settling','0','1'],['30','returning','1','1']]);
    assert.deepEqual(findings[0].sequence,[{recordIndex:0,bits:'1'},{recordIndex:1,bits:'0'}]);
    assert.equal(findings[1].effectiveTransitions,3);assert.equal(findings[2].hasUnknown,true);
    assert.equal(data.evidence.waveformSha256,createHash('sha256').update(TRACE).digest('hex'));assert.equal(data.evidence.sourceBinding,'unverified');
    assert.equal(data.semantics.schedulerDeltaIndices,false);assert.equal(data.semantics.crossSignalOrdering,false);
    assert.equal(data.semantics.recordingCompleteness,'unknown');assert.equal(data.semantics.absenceProvesNoGlitches,false);assert.equal(data.semantics.acceptance,false);
    const stable=await run(['wave','values','--workspace',f.directory,'--file',f.file,'--signals','tb.q','--at','15']);
    assert.equal(stable.output.data.values['tb.q'].bits,'0');assert.equal(await fs.readFile(f.file,'utf8'),TRACE);
});
test('单次正常变化不误报，别名不重复扫描，总线保留真实位宽和原始位串',async t=>{
    const f=await fixture(t), result=await query(f,['--signals','tb.q,tb.alias,tb.normal,tb.bus','--from','10ns','--to','10ns']);
    assert.equal(result.exitCode,0,JSON.stringify(result.output));assert.equal(result.output.data.series.length,3);
    assert.equal(result.output.data.series.find(x=>x.path==='tb.normal').matched,0);
    const bus=result.output.data.series.find(x=>x.path==='tb.bus');assert.equal(bus.width,8);
    assert.deepEqual(bus.findings[0].sequence.map(x=>x.bits),['00000001','00000000']);
    const empty=await query(f,['--from','1','--to','9']);assert.equal(empty.output.data.series[0].windowRecords,0);assert.equal(empty.output.data.matched,0);
    assert.equal(empty.output.data.semantics.absenceProvesNoGlitches,false);
});
test('分页不拆分同刻组且游标不重不漏；扫描未完成时命中数不是精确总数',async t=>{
    const f=await fixture(t), found=[];let from='0', pages=0;
    do {
        const result=await query(f,['--limit','1','--from',from]);assert.equal(result.exitCode,0);
        const series=result.output.data.series[0];found.push(...series.findings.map(x=>x.t));
        assert.equal(result.output.data.matchedIsExact,series.complete);
        from=series.next;assert.ok(++pages<10);
    }while(from!==null);
    assert.deepEqual(found,['10','20','30']);
});
test('初始化活动不冒充运行期毛刺，截断序列保留最终记录及真实序号',async t=>{
    const f=await fixture(t,'$timescale 1ns $end $scope module tb $end $var wire 1 AA q $end $upscope $end $enddefinitions $end #0 0AA 1AA 0AA #10 '+Array.from({length:100},(_,i)=>(i%2?'0':'1')+'AA').join(' '));
    const result=await query(f,['--max-values','3']);assert.equal(result.exitCode,0,JSON.stringify(result.output));
    const findings=result.output.data.series[0].findings;assert.equal(findings[0].classification,'initialization');assert.equal(findings[0].before,null);
    const pulse=findings[1];assert.equal(pulse.sequenceTruncated,true);assert.equal(pulse.recordedChanges,100);
    assert.equal(pulse.sequence.length,3);assert.equal(pulse.sequence.at(-1).recordIndex,99);assert.equal(pulse.sequence.at(-1).bits,pulse.settled);
});
test('超过u16的同刻记录仍完整计数，不用截断的DataOffset.elements取证',async t=>{
    const records=65538;
    const f=await fixture(t,'$timescale 1ns $end $scope module tb $end $var wire 1 AA q $end $upscope $end $enddefinitions $end #0 0AA #10 '+Array.from({length:records},(_,i)=>(i%2?'0':'1')+'AA').join(' '));
    const result=await query(f,['--max-values','2']);assert.equal(result.exitCode,0,JSON.stringify(result.output));
    const pulse=result.output.data.series[0].findings[0];assert.equal(pulse.recordedChanges,records);assert.equal(pulse.effectiveTransitions,records);
    assert.equal(pulse.sequence.at(-1).recordIndex,records-1);assert.equal(pulse.settled,'0');
});
test('译码预算不足明确不完整，不把零命中当通过；下次从整组起点重试',async t=>{
    const f=await fixture(t,'$timescale 1ns $end $scope module tb $end $var wire 5000000 AA q [4999999:0] $end $upscope $end $enddefinitions $end #0 b0 AA #10 b1 AA b0 AA');
    const result=await query(f);assert.equal(result.exitCode,0,JSON.stringify(result.output));
    assert.equal(result.output.data.complete,false);assert.equal(result.output.data.matchedIsExact,false);assert.equal(result.output.data.series[0].next,'10');
    assert.equal(result.output.data.series[0].stopReason,'query-decode-budget');
});
test('真实FST转换产物可以诊断保留下来的同刻顺序，仍不保证记录完整性',async t=>{
    const f=await fixture(t), fst=path.join(f.directory,'trace.fst');
    await nativeApi().waveConvertVcdToFstAsync(f.file,fst);
    const vcd=await query(f), converted=await query(f,['--file',fst]);assert.equal(converted.exitCode,0,JSON.stringify(converted.output));
    const pick=data=>data.series[0].findings.map(x=>({t:x.t,settled:x.settled,before:x.before,sequence:x.sequence}));
    assert.deepEqual(pick(converted.output.data),pick(vcd.output.data));assert.equal(converted.output.data.semantics.recordingCompleteness,'unknown');
});
test('失败/并发路径都释放自身句柄，诊断期间源变化拒绝提供旧证据',async t=>{
    const f=await fixture(t), before=nativeApi().waveSessionCount();
    const responses=await Promise.all([query(f),query(f,['--signals','missing']),query(f,['--max-values','0']),query(f,['--to','99'])]);
    assert.deepEqual(responses.map(x=>x.exitCode),[0,2,2,2]);assert.equal(nativeApi().waveSessionCount(),before);
    const stat=fs.stat;let calls=0;
    t.mock.method(fs,'stat',async(file,...rest)=>{
        if(file===f.file && ++calls===3) await fs.appendFile(f.file,'#60 1AA\n');
        return stat(file,...rest);
    });
    const changed=await query(f);assert.equal(changed.exitCode,2);assert.equal(changed.output.diagnostics[0].code,'SOURCE_CHANGED');assert.equal(nativeApi().waveSessionCount(),before);
});
test('doctor 发现能力且拒绝实数电平毛刺推断',async t=>{
    const f=await fixture(t,'$timescale 1ns $end $scope module tb $end $var real 64 AA q $end $upscope $end $enddefinitions $end #0 r1 AA #1 r2 AA r1 AA');
    const result=await query(f);assert.equal(result.exitCode,2);assert.equal(result.output.diagnostics[0].code,'INVALID_ARGUMENT');
    const doctor=await run(['doctor','--workspace',f.directory]);assert.ok(doctor.output.data.capabilities.includes('wave.glitches'));
});
