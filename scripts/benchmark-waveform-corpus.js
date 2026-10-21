'use strict';
// 与100/500 MiB重复计数器语料互补：多信号、长层级、别名和局部密集跳变。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { VcdSession } = require('../src/waveform/session');
const args=process.argv.slice(2), option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
async function main() {
    const out=path.resolve(option('--out','bin/wave-beta7-corpus'));fs.mkdirSync(out,{recursive:true});
    const file=path.join(out,'many-signals.vcd'), signals=20000, aliases=4000, denseSteps=20000, denseSignals=32;
    if (!fs.existsSync(file)) {
        const stream=fs.createWriteStream(file,{flags:'wx'});let buffer='';
        async function write(text){buffer+=text;if(buffer.length>=65536){if(!stream.write(buffer))await once(stream,'drain');buffer='';}}
        await write('$timescale 1ns $end\n$scope module large_wave_tb $end\n');
        for(let depth=0;depth<6;depth++)await write(`$scope module pipeline_stage_with_long_name_${depth} $end\n`);
        for(let group=0;group<100;group++){
            await write(`$scope module generated_channel_${group} $end\n`);
            for(let n=0;n<200;n++){
                const id=group*200+n,width=id%8===0?1:id%2===0?64:32;
                await write(`$var wire ${width} s${id} signal_with_descriptive_name_${id} ${width>1?'['+(width-1)+':0] ':''}$end\n`);
                if(id%5===0)await write(`$var wire ${width} s${id} alias_signal_${id} ${width>1?'['+(width-1)+':0] ':''}$end\n`);
            }
            await write('$upscope $end\n');
        }
        for(let depth=0;depth<7;depth++)await write('$upscope $end\n');
        await write('$enddefinitions $end\n#0\n');
        for(let id=0;id<signals;id++)await write(`b0 s${id}\n`);
        for(let step=1;step<=denseSteps;step++){
            await write('#'+step+'\n');
            for(let id=0;id<denseSignals;id++)await write(`b${(id%8===0?step%2:step+id).toString(2)} s${id}\n`);
        }
        await write('#20010\n');for(let id=denseSignals;id<signals;id++)await write(`b1 s${id}\n`);
        stream.end(buffer);await once(stream,'finish');
    }
    const session=new VcdSession();let maxDelay=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();maxDelay=Math.max(maxDelay,now-last-10);last=now;},10);
    try {
        const start=performance.now(),metadata=await session.open(file),loadMs=performance.now()-start;
        const ids=Array.from({length:denseSignals},(_,i)=>'s'+i),q=performance.now();
        const window=await session.window({ids,start:0,end:20010,pixels:800}),queryMs=performance.now()-q;
        const values=await session.values({ids,time:10000});
        for(let id=0;id<denseSignals;id++)assert.equal(BigInt('0b'+values.values['s'+id]),BigInt(id%8===0?0:10000+id));
        const edge=await session.edge({id:'s1',time:9999,direction:'next'});assert.equal(edge.time,10000);
        assert.equal(metadata.vars.length,signals+aliases);assert.equal(new Set(metadata.vars.map(s=>s.id)).size,signals);
        assert.ok(metadata.vars.some(s=>s.path.length>240));assert.ok(window.series.some(s=>s.dense.length));
        assert.ok(window.series.reduce((n,s)=>n+s.changes.length,0)<=denseSignals*800*4);
        const report={file,fileBytes:fs.statSync(file).size,signals,aliases,declarations:metadata.vars.length,maxPath:Math.max(...metadata.vars.map(s=>s.path.length)),
            eventCount:metadata.eventCount,storageBytes:metadata.storageBytes,workerHeapBytes:metadata.workerHeapBytes,loadMs:Math.round(loadMs),
            windowMs:Number(queryMs.toFixed(2)),windowBytes:Buffer.byteLength(JSON.stringify(window)),hostMaxDelayMs:Number(maxDelay.toFixed(2)),
            exactValues:true,exactEdge:edge.time,denseExplicit:true};
        fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
    }finally{clearInterval(timer);await session.dispose();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
