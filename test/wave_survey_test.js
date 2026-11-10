'use strict';
// 借鉴 pywellen-mcp 移植的窗口概览工具：stats/timeline/signed 解码与 CSV 导出的合同测试。
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), path=require('node:path'),os=require('node:os');
const { createHash }=require('node:crypto');
const { run }=require('../src/cli/main');

const TRACE=`$timescale 1 ns $end
$scope module tb $end
$var reg 8 ! neg [7:0] $end $var wire 1 # clk $end $var real 64 % v $end
$upscope $end $enddefinitions $end
#0 $dumpvars b11111111 ! 0# r0.5 % $end
#5 1#
#10 b10000000 ! 0#
#15 1# r1.5 %
#20 0# b00000001 !
#30 x#
#35 1#
`;
async function fixture(t,text=TRACE) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'svtools-survey-'));
    const file=path.join(directory,'trace.vcd');await fs.writeFile(file,text);
    t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('svtools-survey-'));await fs.rm(directory,{recursive:true,force:true});});
    return {directory,file};
}
test('stats：事件/跳变分列、首末跳变、X 标记与空窗口',async t=>{
    const f=await fixture(t);
    const result=await run(['wave','stats','--workspace',f.directory,'--file','trace.vcd','--signals','tb.neg,tb.clk,tb.v']);
    assert.equal(result.exitCode,0,JSON.stringify(result.output));
    const series=Object.fromEntries(result.output.data.series.map(s=>[s.path,s]));
    // neg：3 个事件（t0 初值 + t10 + t20），但只有 2 次终值跳变（t0 无前值不算）。
    assert.equal(series['tb.neg'].events,3);assert.equal(series['tb.neg'].transitions,2);
    assert.equal(series['tb.neg'].firstChange,'10');assert.equal(series['tb.neg'].lastChange,'20');
    assert.equal(series['tb.neg'].hasX,false);
    // clk：t30 到 X，hasX 必须为真；t35 回 1 仍是终值跳变。
    assert.equal(series['tb.clk'].hasX,true);assert.equal(series['tb.clk'].transitions,6);
    assert.equal(result.output.data.complete,true);
    // 空窗口（跳过 t0 初值组）：事件与跳变全 0，不算错误。
    const empty=await run(['wave','stats','--workspace',f.directory,'--file','trace.vcd','--signals','tb.clk','--from','1','--to','4']);
    assert.equal(empty.exitCode,0);assert.equal(empty.output.data.series[0].events,0);
    assert.equal(empty.output.data.series[0].transitions,0);
});
test('timeline：同刻多信号同组、before 取窗口前终值、分页不重不漏',async t=>{
    const f=await fixture(t);
    const full=await run(['wave','timeline','--workspace',f.directory,'--file','trace.vcd','--signals','tb.neg,tb.clk']);
    assert.equal(full.exitCode,0,JSON.stringify(full.output));
    const groups=full.output.data.groups;
    // t0 初值不构成跳变；t10 两信号同刻同组（组内按路径排序）。
    assert.deepEqual(groups.map(g=>g.t),['5','10','15','20','30','35']);
    assert.deepEqual(groups[1].changes.map(c=>c.path),['tb.clk','tb.neg']);
    assert.deepEqual(groups[1].changes.map(c=>[c.before,c.bits]),[['1','0'],['11111111','10000000']]);
    assert.equal(full.output.data.complete,true);assert.equal(full.output.data.next,null);
    // limit=2 逐页续查：收齐后与一次全量完全一致。
    const collected=[];let from='0',pages=0;
    for(;;){
        const page=await run(['wave','timeline','--workspace',f.directory,'--file','trace.vcd','--signals','tb.neg,tb.clk','--limit','2','--from',from]);
        assert.equal(page.exitCode,0,JSON.stringify(page.output));
        collected.push(...page.output.data.groups);
        if(page.output.data.next===null){assert.equal(page.output.data.complete,true);break;}
        from=page.output.data.next;assert.ok(++pages<10);
    }
    assert.deepEqual(collected,groups);
});
test('values：有符号补码解码只给整数类且宽度≥2',async t=>{
    const f=await fixture(t);
    const at=async (signal,tick)=>{
        const r=await run(['wave','values','--workspace',f.directory,'--file','trace.vcd','--signals',signal,'--at',tick]);
        assert.equal(r.exitCode,0,JSON.stringify(r.output));return r.output.data.values[signal];
    };
    assert.equal((await at('tb.neg','5')).signed,'-1');        // 0xFF
    assert.equal((await at('tb.neg','20')).signed,'1');        // 0x01
    assert.equal((await at('tb.neg','15')).signed,'-128');     // 0x80
    assert.equal((await at('tb.v','15')).signed,undefined);    // real 不给
    assert.equal((await at('tb.clk','5')).signed,undefined);   // 1 位标量不给
});
test('export csv：矩阵行=终值跳变时刻、基线与前值填充、产物哈希可核',async t=>{
    const f=await fixture(t);
    const result=await run(['wave','export','--workspace',f.directory,'--file','trace.vcd','--signals','tb.neg,tb.clk','--out','out','--format','csv']);
    assert.equal(result.exitCode,0,JSON.stringify(result.output));
    assert.equal(result.output.data.format,'csv');assert.equal(result.output.data.rows,6);assert.equal(result.output.data.truncated,false);
    const file=result.output.artifacts[0].path;
    const text=await fs.readFile(file,'utf8');
    assert.deepEqual(text.trim().split('\r\n'),[
        'time,tb.neg,tb.clk',
        '5,,1',
        '10,10000000,0',
        '15,10000000,1',
        '20,00000001,0',
        '30,00000001,x',
        '35,00000001,1'
    ]);
    assert.equal(result.output.artifacts[0].sha256,createHash('sha256').update(text).digest('hex'));
    // 带窗口基线：from=12 起，neg 基线为窗口前一时刻终值 0x80。
    const windowed=await run(['wave','export','--workspace',f.directory,'--file','trace.vcd','--signals','tb.neg','--out','out','--from','12','--to','22','--format','csv']);
    assert.equal(windowed.exitCode,0,JSON.stringify(windowed.output));
    assert.deepEqual((await fs.readFile(windowed.output.artifacts[0].path,'utf8')).trim().split('\r\n'),[
        'time,tb.neg','20,00000001'
    ]);
});
test('失败与并发路径释放句柄；stats/timeline 拒绝越界窗口',async t=>{
    const f=await fixture(t), { nativeApi }=require('../src/waveform/rust-backend');
    const before=nativeApi().waveSessionCount();
    const responses=await Promise.all([
        run(['wave','stats','--workspace',f.directory,'--file','trace.vcd','--signals','tb.clk','--to','999']),
        run(['wave','timeline','--workspace',f.directory,'--file','trace.vcd','--signals','tb.clk','--limit','0']),
        run(['wave','stats','--workspace',f.directory,'--file','trace.vcd','--signals','missing']),
    ]);
    assert.deepEqual(responses.map(x=>x.exitCode),[2,2,2]);
    assert.equal(responses[0].output.diagnostics[0].code,'INVALID_ARGUMENT');
    assert.equal(responses[2].output.diagnostics[0].code,'SIGNAL_NOT_FOUND');
    const ok=await run(['wave','stats','--workspace',f.directory,'--file','trace.vcd','--signals','tb.clk']);
    assert.equal(ok.exitCode,0);
    assert.equal(nativeApi().waveSessionCount(),before);
    const doctor=await run(['doctor','--workspace',f.directory]);
    assert.ok(doctor.output.data.capabilities.includes('wave.stats'));
    assert.ok(doctor.output.data.capabilities.includes('wave.timeline'));
});
