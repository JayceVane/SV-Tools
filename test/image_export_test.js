'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const S=require('../src/graphics/svg-canvas');
const W=require('../src/waveform/image-export');
const {createImageFiles}=require('../src/graphics/image-files');
test('SVG画布保留路径、字体、透明度和剪裁，所有设计文字转义',()=>{
    const ctx=S.createContext({prefix:'wave'});ctx.beginPath();ctx.rect(10,20,30,40);ctx.clip();ctx.save();
    ctx.strokeStyle='#123456';ctx.lineWidth=2.8;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(1,2);ctx.lineTo(30,40);ctx.stroke();
    ctx.font='13px Consolas, monospace';ctx.fillText('<script>&"',12,24);ctx.restore();
    const svg=ctx.content();assert.match(svg,/clipPath/);assert.match(svg,/stroke-width="2.8"/);assert.match(svg,/stroke-dasharray="3 3"/);
    assert.match(svg,/&lt;script&gt;&amp;/);assert.doesNotMatch(svg,/<script>/);assert.throws(()=>ctx.setTransform(2,0,0,2,0,0),/1:1/);
});
function state(){return {metadata:{endTime:100},cursorA:80,cursorB:20,view:{start:10,span:30},selected:['a','b'],rows:[
    {key:'a',height:38,signal:{id:'!',key:'a',name:'a',path:'tb.a'}},{key:'b',height:100,signal:{id:'!',key:'b',name:'b',path:'tb.b'}}],multi:new Set(['b'])};}
test('波形导出AB倒序自动归一化，未设置AB可选当前视口，自动画幅保留完整行',()=>{
    const s=state(),plan=W.plan(s,{range:'ab',signals:'all'});assert.equal(plan.start,20);assert.equal(plan.end,80);
    assert.equal(plan.rows.length,2);assert.equal(plan.rows[1].height,100);assert.ok(plan.width>=1000&&plan.names>=270);
    assert.equal(W.plan(s,{range:'view',signals:'selected'}).rows.length,1);
    s.cursorB=null;assert.throws(()=>W.plan(s,{range:'ab'}),/A\/B/);
});
test('图片保存取消不写入，合法SVG落盘，非法格式和覆盖源文件被拒绝',async()=>{
    let picked,written;const uri=file=>({scheme:'file',fsPath:file});
    const files=createImageFiles({vscode:{Uri:{file:uri},window:{showSaveDialog:async()=>picked},workspace:{fs:{writeFile:async(target,data)=>{written={target,data};}}}},sourcePath:'/p/trace.vcd'});
    const payload={format:'svg',name:'trace',data:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>'};
    assert.equal(await files.save(payload),false);picked=uri('/p/trace.svg');assert.equal(await files.save(payload),true);assert.ok(written.data.length>0);
    picked=uri('/p/trace.vcd');await assert.rejects(files.save(payload),/扩展名|覆盖/);
    await assert.rejects(files.save({...payload,format:'html'}),/格式/);
    await assert.rejects(files.save({...payload,data:'<script>alert(1)</script>'}),/SVG/);
});

const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {VcdSession}=require('../src/waveform/session');
const M=require('../src/waveform/model'),L=require('../src/waveform/row-layout'),C=require('../src/waveform/column-layout'),D=require('../src/waveform/signal-display');
test('真实worker导出独立AB时间窗和派生bit，现场缓存/选择/布局保持原样',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'svtools-image-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const file=path.join(root,'sample.vcd');await fs.writeFile(file,'$timescale 1ns $end\n$scope module tb $end\n$var wire 4 ! data [3:0] $end\n$upscope $end\n$enddefinitions $end\n#0\nb1010 !\n#20\nb1110 !\n#50\nbxxxx !\n#100\n');
    const session=new VcdSession();t.after(()=>session.dispose());const metadata=await session.open(file),parent=M.prepareSignals(metadata.vars)[0],bit=D.bitSignals(parent)[1];
    const signals=new Map([[parent.key,parent],[bit.key,bit]]),selected=[parent.key,bit.key];
    const current={metadata,signals,selected,rows:L.buildRows(selected,signals,{},{}),formats:{},groups:{},heights:{},highlights:{},multi:new Set([bit.key]),view:{start:50,span:50},cursorA:0,cursorB:30,secondsPerTick:1e-9,series:new Map([['stale',{}]])};
    const window={document:{body:{},createElement:()=>({getContext:()=>({font:'',measureText:text=>({width:String(text).length*7})})})},WaveModel:M,WaveRowLayout:L,WaveColumnLayout:C};
    vm.runInNewContext(await fs.readFile(path.join(__dirname,'../src/waveform/renderer.js'),'utf8'),{window,getComputedStyle:()=>{throw Error('导出不应读取现场样式');}});
    const calls=[],image=await W.create({state:current,options:{style:'document',range:'ab'},request:(method,params)=>{calls.push({method,params});return session[method](params);},window,renderer:{},title:'chip <&>'});
    assert.match(image.svg,/chip &lt;&amp;&gt;/);assert.match(image.svg,/data\[2\]/);assert.doesNotMatch(image.svg,/0xX/);
    assert.equal(calls[0].params.start,0);assert.equal(calls[0].params.end,30);assert.deepEqual(calls[0].params.ids,['!']);
    assert.equal(current.view.start,50);assert.ok(current.series.has('stale'));assert.equal(current.multi.size,1);
    assert.ok(image.width>=1100);assert.equal(image.height,50+35+76+30);
});
test('复制到剪贴板只接受严格PNG载荷，非法输入不启动系统剪贴板',async()=>{
    const files=createImageFiles({vscode:{}});
    await assert.rejects(files.copy({format:'svg',data:'<svg/>'}),/PNG/);
    await assert.rejects(files.copy({format:'png',data:'%%%'}),/编码/);
    await assert.rejects(files.copy({format:'png',data:'abcdef'}),/无效PNG/);
});

test('图片复制直接交给共享原生写入器，返回成功并保留具体错误',async()=>{
    const png=Buffer.from([137,80,78,71,13,10,26,10,0]);let called=0;
    const files=createImageFiles({vscode:{},writeClipboard:async bytes=>{called++;assert.deepEqual(bytes,png);}});
    assert.equal(await files.copy({format:'png',data:png.toString('base64')}),true);assert.equal(called,1);
    const failing=createImageFiles({vscode:{},writeClipboard:async()=>{throw new Error('剪贴板正被其它程序占用');}});
    await assert.rejects(failing.copy({format:'png',data:png.toString('base64')}),/其它程序占用/);
    await assert.rejects(files.copy({format:'png',data:'A'.repeat(Math.ceil(32*1024*1024/3)*4+1)}),/32 MiB/);
    assert.equal(called,1);
});

test('SVG记录器拒绝非有限坐标，PNG超大图明确拒绝而不创建位图',async()=>{
    const context=S.createContext();assert.throws(()=>context.fillRect(NaN,0,1,1),/有限/);
    const I=require('../src/graphics/image-export');await assert.rejects(I.png('<svg/>',20000,20000,{}),/PNG尺寸过大/);
});
