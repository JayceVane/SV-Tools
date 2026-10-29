'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const vscode=require('vscode');
const execute=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,timeout=20000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('读值验收超时：'+label);await pause(25);}}

/** 真实工具和Webview，默认A=0来自页面握手；可选CUA交互改变A/B后继续断言。 */
async function run(){
    const root=vscode.workspace.workspaceFolders[0].uri.fsPath;assert.equal(path.basename(root),'workspace');
    const extension=vscode.extensions.getExtension('JayceVane.svtools'),api=await extension.activate(),checks=[];
    const file=path.join(root,'link_chip.sv'),waveFile=path.join(root,'wave.vcd'),out=path.join(root,'wave.out');
    const source=await fs.readFile(path.join(__dirname,'fixtures/circuit-wave-link.sv'),'utf8');await fs.writeFile(file,source);
    const env={...process.env,PATH:'D:/DevKit/cygwin64/bin'+path.delimiter+process.env.PATH};
    await execute('D:/DevKit/iverilog/bin/iverilog.exe',['-g2012','-s','tb','-o',out,file],{cwd:root,env,windowsHide:true,timeout:30000});
    await execute('D:/DevKit/iverilog/bin/vvp.exe',[out],{cwd:root,env,windowsHide:true,timeout:30000});
    const config=vscode.workspace.getConfiguration('svtools.circuit');
    await config.update('top','link_chip',vscode.ConfigurationTarget.Workspace);await config.update('sources',[file],vscode.ConfigurationTarget.Workspace);
    const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(file));await vscode.window.showTextDocument(doc,vscode.ViewColumn.One);
    const circuit=await api.circuit.fromSource(doc.uri);assert.equal((await circuit.loaded).ok,true);
    let wave=await api.waveViewer.openWaveform(waveFile,{sourceFile:file});assert.ok(await wave.initialized);
    try{
        const q0=circuit.getState().graph.nodes.find(node=>node.label==='q0'),q1=circuit.getState().graph.nodes.find(node=>node.label==='q1');assert.ok(q0&&q1);
        const graph=circuit.getState().graph;
        const pending=circuit.watchWave({type:'node',id:q0.id});await until(()=>api.waveLinks.state().busy,'根选择');await pause(450);
        await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        const first=await pending;assert.ok(first.ok);await until(()=>circuit.waveProbes()[0]?.a?.status==='value','A=0读值');
        assert.equal(circuit.waveProbes()[0].a.text,"4'hF");assert.equal(circuit.waveProbes()[0].b.status,'no-cursor');
        checks.push('真实页面A=0经原VCD Worker读出q0=4\'hF；未设置B保持独立状态');
        await circuit.watchWave({type:'node',id:q0.id},'6:5');await until(()=>circuit.waveProbes().length===2&&circuit.waveProbes()[1]?.a?.status==='value','切片');
        assert.equal(circuit.waveProbes()[1].a.text,"2'h3");assert.deepEqual(circuit.waveProbes()[1].target.indices,[5,6]);
        checks.push('非零起点总线的6:5切片按HDL位序读出2\'h3');
        const other=await circuit.watchWave({type:'node',id:q1.id});await until(()=>circuit.waveProbes().length===3&&circuit.waveProbes()[2]?.a?.status==='value','q1');
        assert.equal(circuit.waveProbes()[2].a.text,"4'h0");assert.equal(circuit.getState().graph,graph);
        checks.push('重复子实例对应q0/q1不同事件，增加观察不重建电路图或布局');
        circuit.removeWaveProbe(other.id);await until(()=>circuit.waveProbes().length===2,'删除观察');
        checks.push('移除单项观察保留其余探针与网表身份');
        if(process.env.SVTOOLS_CURSOR_VALUES_VISUAL==='1'){
            await vscode.commands.executeCommand('workbench.action.closeSidebar');
            const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input?.uri?.fsPath===file);if(tabs.length)await vscode.window.tabGroups.close(tabs,true);
            await fs.writeFile(path.join(root,'..','visual-ready.json'),JSON.stringify({root,checks,extensionPath:extension.extensionPath},null,2));
            const end=Date.now()+240000;let continued=false;
            while(Date.now()<end){try{await fs.access(path.join(root,'visual-continue'));continued=true;break;}catch(error){if(error.code!=='ENOENT')throw error;}await pause(100);}
            assert.ok(continued,'需要实际A/B交互后继续');
            await until(()=>circuit.waveProbes()[0]?.a?.text==="4'hC"&&circuit.waveProbes()[0]?.b?.text==="4'h7",'真实UI的A=10ns/B=30ns');
            assert.deepEqual(circuit.waveProbes()[0].difference.indices,[4,5,7]);assert.equal(circuit.waveProbes()[1].a.text,"2'h2");assert.equal(circuit.waveProbes()[1].b.text,"2'h3");
            assert.equal(circuit.getState().graph,graph);checks.push('实际UI移动A到10ns/B到30ns后精确显示C→7与HDL差异4/5/7，切片2→3且图身份不变');
        }
        await fs.appendFile(waveFile,'\n');await until(()=>circuit.waveProbes().length===0,'外部VCD变化自动失效');
        await assert.rejects(circuit.watchWave({type:'node',id:q0.id}),/已变化/);
        checks.push('外部改写VCD时无需再次移动游标便清空旧值，旧Worker拒绝继续观察');
        const reopenLease=await api.waveViewer.prepareForSimulation({paths:[waveFile],sourceFile:file,directory:root});reopenLease.dispose();
        wave=await api.waveViewer.openWaveform(waveFile,{sourceFile:file});assert.ok(await wave.initialized);
        const rewatch=circuit.watchWave({type:'node',id:q0.id});await until(()=>api.waveLinks.state().busy,'重开根选择');await pause(450);
        await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');await rewatch;
        await until(()=>circuit.waveProbes()[0]?.a?.status==='value','新Worker读值');
        checks.push('重新打开文件并再次人工确认后，新Worker可以恢复观察');
        const editor=await vscode.window.showTextDocument(doc,vscode.ViewColumn.One);await editor.edit(edit=>edit.insert(new vscode.Position(0,0),'// source changed\n'));
        await until(()=>circuit.getState().sourceStale,'源码变化');assert.equal(circuit.waveProbes().length,0);
        assert.equal(await fs.readFile(file,'utf8'),source);checks.push('脏源码撤销映射和读值，磁盘夹具保持原文');
        await fs.writeFile(path.join(root,'..','host-report.json'),JSON.stringify({version:extension.packageJSON.version,extensionPath:extension.extensionPath,vscode:vscode.version,checks},null,2));
    }finally{circuit.dispose();await wave.dispose();}
}
module.exports={run};
