'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
async function until(predicate, label) {
    const end=Date.now()+20000;
    while(!predicate()){if(Date.now()>end)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,30));}
}
const sample='$timescale 1ns $end\n$scope module old $end\n$var wire 1 ! value $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n#1\n1!\n';
/** 实际默认文件关联、CustomEditor关闭、Icarus重写和worker重开；所有文件位于隔离夹具。 */
async function run(){
    const root=vscode.workspace.workspaceFolders[0].uri.fsPath,extension=vscode.extensions.getExtension('JayceVane.svtools');
    const api=await extension.activate(),checks=[];
    const file=path.join(root,'waves','trace.vcd'),other=path.join(root,'other.vcd'),tb=path.join(root,'tb.sv');
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,sample);await fs.writeFile(other,sample);
    await fs.writeFile(tb,'`timescale 1ns/1ps\nmodule tb; reg value=0; initial begin $dumpfile("waves/trace.vcd"); $dumpvars(0,tb); #10 value=1; #10 $finish; end endmodule\n');
    const uri=vscode.Uri.file(file),customTabs=()=>vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input instanceof vscode.TabInputCustom&&tab.input.uri.toString()===uri.toString());
    await vscode.commands.executeCommand('vscode.open',uri,{preview:false});
    await until(()=>customTabs().length===1,'普通打开VCD未进入CustomEditor');
    assert.equal(customTabs()[0].input.viewType,'svtoolsWaveViewer');
    const old=await api.waveViewer.openWaveform(file);assert.equal((await old.loaded).endTime,1);
    checks.push('普通vscode.open默认进入VCD波形CustomEditor');
    const untouched=await api.waveViewer.openWaveform(other);
    const source=await vscode.workspace.openTextDocument(tb);await vscode.window.showTextDocument(source);
    const first=await vscode.commands.executeCommand('svtools.iverilog.simulate');assert.equal(first.status,'success',first.message);
    assert.deepEqual(first.waves,[file]);assert.equal(old.getStatus().loaded,false);
    await until(()=>customTabs().length===0,'旧波形CustomEditor标签未关闭');
    assert.equal(untouched.getStatus().loaded,true);
    const fresh=await api.waveViewer.openWaveform(file);assert.equal((await fresh.loaded).endTime,20000);
    checks.push('真实Icarus启动前关闭对应CustomEditor，仿真后子目录新VCD自动加载，其他波形保留');
    await vscode.commands.executeCommand('vscode.openWith',uri,'default',{preview:false});
    const textTabs=()=>vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input instanceof vscode.TabInputText&&tab.input.uri.toString()===uri.toString());
    assert.equal(textTabs().length,1);await vscode.window.showTextDocument(source);
    assert.equal((await vscode.commands.executeCommand('svtools.iverilog.simulate')).status,'success');
    assert.equal(textTabs().length,0);assert.equal(untouched.getStatus().loaded,true);
    checks.push('VCD以文本打开时也在仿真前关闭，其他VCD标签保留');
    const lease=await api.waveViewer.prepareForSimulation({paths:[file],directory:root,sourceFile:tb});
    const handle=await fs.open(file,'w');
    try{
        await handle.write(sample.slice(0,sample.indexOf('#0'))+'#0\n');
        const chunk=Buffer.from('0!\n1!\n'.repeat(174763));
        for(let i=0;i<100;i++)await handle.write(chunk);
    }finally{await handle.close();lease.dispose();}
    const oldBytes=(await fs.stat(file)).size;assert.ok(oldBytes>=100*1024*1024);
    let loadCompleted=false;
    const loading=api.waveViewer.openWaveform(file).then(binding=>{loadCompleted=true;return binding;});loading.catch(()=>{});
    await vscode.window.showTextDocument(source);
    const loadingAtSimulationStart=!loadCompleted;
    const second=await vscode.commands.executeCommand('svtools.iverilog.simulate');assert.equal(second.status,'success',second.message);
    const closed=await loading;assert.equal(closed.getStatus().loaded,false);
    assert.ok((await fs.stat(file)).size<4096);assert.equal(untouched.getStatus().loaded,true);
    const after=await api.waveViewer.openWaveform(file);assert.equal((await after.loaded).endTime,20000);
    checks.push('打开100MiB旧波形期间重新仿真，旧会话终止，磁盘被新VCD覆盖并重新加载');
    await fs.writeFile(path.join(root,'..','host-report.json'),JSON.stringify({vscode:vscode.version,node:process.versions.node,electron:process.versions.electron,
        extensionVersion:extension.packageJSON.version,extensionPath:extension.extensionPath,checks,count:checks.length,oldBytes,loadingAtSimulationStart,newBytes:(await fs.stat(file)).size},null,2));
}
module.exports={run};
