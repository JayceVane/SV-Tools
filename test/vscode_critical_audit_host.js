'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const vscode=require('vscode');
const execute=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label){const end=Date.now()+20000;while(!predicate()){if(Date.now()>end)throw new Error('严重缺陷验收超时：'+label);await pause(25);}}

/** 真实工具、文件事件与关闭标签，不借用用户工程或更改日常配置。 */
async function run(){
    const root=vscode.workspace.workspaceFolders[0].uri.fsPath;assert.equal(path.basename(root),'workspace');
    const extension=vscode.extensions.getExtension('JayceVane.svtools'),api=await extension.activate(),checks=[];
    const source=await fs.readFile(path.join(__dirname,'fixtures/circuit-wave-link.sv'),'utf8');
    const file=path.join(root,'link_chip.sv'),waveFile=path.join(root,'wave.vcd'),out=path.join(root,'tb.out');
    await fs.writeFile(file,source);
    const env={...process.env,PATH:'D:/DevKit/cygwin64/bin'+path.delimiter+process.env.PATH};
    await execute('D:/DevKit/iverilog/bin/iverilog.exe',['-g2012','-s','tb','-o',out,file],{cwd:root,env,windowsHide:true,timeout:30000});
    await execute('D:/DevKit/iverilog/bin/vvp.exe',[out],{cwd:root,env,windowsHide:true,timeout:30000});
    const config=vscode.workspace.getConfiguration('svtools.circuit');
    await config.update('top','link_chip',vscode.ConfigurationTarget.Workspace);await config.update('sources',[],vscode.ConfigurationTarget.Workspace);
    let document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));await vscode.window.showTextDocument(document,vscode.ViewColumn.One);
    const circuit=await api.circuit.fromSource(document.uri);assert.equal((await circuit.loaded).ok,true);
    const wave=await api.waveViewer.openWaveform(waveFile,{sourceFile:file});assert.ok(await wave.initialized);
    async function closeSource(){const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input?.uri?.fsPath===file);if(tabs.length)await vscode.window.tabGroups.close(tabs,true);}
    async function observe(confirm){
        const node=circuit.getState().graph.nodes.find(node=>node.label==='q0');
        const pending=circuit.watchWave({type:'node',id:node.id});
        if(confirm){await until(()=>api.waveLinks.state().busy,'人工根确认');await pause(450);await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');}
        await pending;await until(()=>circuit.waveProbes()[0]?.a?.status==='value','实际读值');assert.equal(circuit.waveProbes()[0].a.text,"4'hF");
    }
    try{
        await observe(true);checks.push('真实Yosys/Icarus及原生根确认建立有效观察，A=0读值F');
        await closeSource();assert.ok(!vscode.window.tabGroups.all.flatMap(group=>group.tabs).some(tab=>tab.input?.uri?.fsPath===file));
        await fs.writeFile(path.join(root,'audit_extra.sv'),'module audit_extra; endmodule\n');
        await fs.writeFile(file,source.replace('    link_lane u0','    audit_extra extra();\n    link_lane u0')+'\n// external source change\n');
        await until(()=>circuit.getState().sourceStale,'未打开源码的磁盘变化');
        assert.equal(circuit.waveProbes().length,0);checks.push('源码标签已关闭时外部改写仍撤销映射和读值');
        await circuit.reload();assert.equal(circuit.getState().sourceStale,false);assert.ok(circuit.getState().graph,'刷新需要重新读取已关闭源码及其新增依赖');
        await observe(true);checks.push('刷新捕获新快照并重新确认后恢复观察，旧目录监听没有污染新世代');
        document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));const editor=await vscode.window.showTextDocument(document,vscode.ViewColumn.One);
        await editor.edit(edit=>edit.insert(new vscode.Position(0,0),'// save and close\n'));await document.save();await closeSource();
        await until(()=>circuit.getState().sourceStale,'保存后快速关闭标签');assert.equal(circuit.waveProbes().length,0);
        checks.push('保存后立即关闭标签仍使旧电路与读值失效');
        const lease=await api.waveViewer.prepareForSimulation({paths:[waveFile],sourceFile:file,directory:root});assert.equal(api.waveLinks.state().waves,0);assert.equal(api.waveLinks.state().links.length,0);lease.dispose();
        checks.push('写入屏障关闭旧Worker并释放全部关联，仿真可继续写入');
        await fs.writeFile(path.join(root,'..','host-report.json'),JSON.stringify({version:extension.packageJSON.version,extensionPath:extension.extensionPath,vscode:vscode.version,checks},null,2));
    }finally{circuit.dispose();await wave.dispose();}
}
module.exports={run};
