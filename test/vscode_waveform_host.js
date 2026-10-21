'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
async function until(predicate,label){const end=Date.now()+20000;while(!predicate()){if(Date.now()>end)throw new Error('真实宿主超时：'+label);await new Promise(resolve=>setTimeout(resolve,50));}}
/** 真实IDE扩展宿主与Webview握手；既不替换vscode API，也不使用Electron Node模式。 */
async function run(){
    const root=vscode.workspace.workspaceFolders[0].uri.fsPath,extension=vscode.extensions.getExtension('JayceVane.svtools');
    const api=await extension.activate();assert.ok(api.waveViewer);
    await fs.writeFile(path.join(root,'wave.sv'),'module host_wave(input [7:4] ctrl, output reg flag); endmodule');
    const file=path.join(root,'wave.vcd');await fs.writeFile(file,'$timescale 1ns $end\n$scope module host_wave $end\n$var wire 4 ! ctrl [7:4] $end\n$var reg 1 # flag $end\n$upscope $end\n$enddefinitions $end\n#0\nb1010 !\n0#\n#40\nb1110 !\n1#\n#80\n');
    const binding=await api.waveViewer.openWaveform(file),checks=[];
    try{
        const metadata=await binding.loaded;assert.equal(metadata.vars.length,2);assert.equal(metadata.vars[0].role,'input');assert.equal(metadata.vars[1].role,'output');
        checks.push('真实扩展加载VCD Worker并使用共享RTL上下文匹配输入输出');
        const ready=await Promise.race([binding.initialized,new Promise((_,reject)=>setTimeout(()=>reject(Error('Webview脚本未握手')),20000))]);
        assert.equal(ready.signals,2);assert.equal(ready.rows,2);
        await until(()=>binding.getStatus().activity.window>0&&binding.getStatus().activity.values>0,'真实Canvas窗口与游标查询');
        checks.push('真实IDE Webview执行nonce脚本、初始化分层Canvas并完成window/values查询');
        const {createLayoutFiles}=require(path.join(extension.extensionPath,'src/waveform/layout-files'));
        const {capture}=require(path.join(extension.extensionPath,'src/waveform/layout-state'));
        const {prepareSignals}=require(path.join(extension.extensionPath,'src/waveform/model'));
        const signals=new Map(prepareSignals(metadata.vars).map(s=>[s.key,s]));
        const layout=capture({signals,selected:[...signals.keys()],formats:{},groups:{},view:{start:0,span:80},cursorA:40,cursorB:null,secondsPerTick:1e-9});
        const uri=vscode.Uri.file(path.join(root,'host.svwave.json')),files=createLayoutFiles({vscode,filePath:file});
        assert.equal(await files.save(layout,uri),true);assert.equal((await files.load(uri)).tracks.length,2);
        checks.push('真实VS Code文件系统完成布局保存及读回，VCD保持原文件');
        await fs.writeFile(path.join(root,'..','host-report.json'),JSON.stringify({vscode:vscode.version,appName:vscode.env.appName,
            node:process.versions.node,electron:process.versions.electron,extensionVersion:extension.packageJSON.version,extensionPath:extension.extensionPath,
            checks,count:checks.length,status:binding.getStatus()},null,2));
    }finally{binding.dispose();}
}
module.exports={run};
