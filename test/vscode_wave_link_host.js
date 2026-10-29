'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

async function until(predicate,label,timeout=20000) {
    const deadline = Date.now()+timeout;
    while (!predicate()) {if(Date.now()>deadline)throw new Error('真实关联宿主超时：'+label);await pause(25);}
}

/** 真实Icarus、Yosys、两个Webview与根层级选择器，不安装扩展或改用户工程。 */
async function run() {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    assert.equal(path.basename(root),'workspace');
    const extension = vscode.extensions.getExtension('JayceVane.svtools'), api = await extension.activate(), checks=[];
    assert.ok(api.waveLinks);
    const source = await fs.readFile(path.join(__dirname,'fixtures/circuit-wave-link.sv'),'utf8');
    const file = path.join(root,'link_chip.sv'), waveFile = path.join(root,'wave.vcd'), executable = path.join(root,'wave.out');
    await fs.writeFile(file,source);
    const iverilog = process.env.SVTOOLS_CODEGEN_IVERILOG || 'D:/DevKit/iverilog/bin/iverilog.exe';
    const vvp = process.env.SVTOOLS_CODEGEN_VVP || 'D:/DevKit/iverilog/bin/vvp.exe';
    const env = {...process.env,PATH:(process.env.SVTOOLS_CODEGEN_CYGWIN || 'D:/DevKit/cygwin64/bin')+path.delimiter+process.env.PATH};
    await execute(iverilog,['-g2012','-s','tb','-o',executable,file],{cwd:root,env,windowsHide:true,timeout:30000});
    await execute(vvp,[executable],{cwd:root,env,windowsHide:true,timeout:30000});
    const config = vscode.workspace.getConfiguration('svtools.circuit');
    await config.update('top','link_chip',vscode.ConfigurationTarget.Workspace);
    await config.update('sources',[file],vscode.ConfigurationTarget.Workspace);
    await until(()=>vscode.workspace.getConfiguration('svtools.circuit').get('top')==='link_chip','工作区配置');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc,vscode.ViewColumn.One);
    const circuit = await api.circuit.fromSource(doc.uri), loaded = await circuit.loaded;
    assert.equal(loaded.ok,true,loaded.error); assert.equal(loaded.design.provenance.engine,'yosys');
    const wave = await api.waveViewer.openWaveform(waveFile,{sourceFile:file});
    assert.ok(await wave.initialized); checks.push('真实Icarus生成VCD，Yosys生成含重复子实例和非零起点总线的实际电路');
    async function confirmRoot(action) {
        const pending = action();
        await until(()=>api.waveLinks.state().busy,'关联选择器');
        await pause(450);
        await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        let timer;
        return Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('根层级选择未完成')),20000);})]).finally(()=>clearTimeout(timer));
    }
    try {
        const node = circuit.getState().graph.nodes.find(node=>node.label==='q0'); assert.ok(node);
        const selection = {type:'node',id:node.id};
        const added = await confirmRoot(()=>circuit.linkWave(selection));
        assert.equal(added.ok,true); assert.deepEqual(added.keys,['tb.dut.q0']);
        assert.equal(api.waveLinks.state().links[0].rootId,1); assert.match(added.label,/未验证同次构建/);
        checks.push('通过真实根层级选择器确认tb.dut，电路端口加入波形并收到页面确认');
        const slice = await circuit.linkWave(selection,'6:5');
        assert.equal(slice.ok,true); assert.equal(slice.keys.length,2);
        assert.deepEqual(slice.keys.map(key=>JSON.parse(key)[2]),[2,1]);
        checks.push('电路切片6:5精确映射成原VCD的两个逐位行，复用已有人工确认');
        const drivers = await wave.traceCircuit('tb.dut.u0.dout','drivers');
        assert.equal(drivers.ok,true); assert.deepEqual(drivers.target.instanceNames,['u0']);
        assert.equal(circuit.getState().graph.trace.direction,'drivers');
        const loads = await wave.traceCircuit(JSON.stringify(['$bit','tb.dut.u1.dout',0]),'loads');
        assert.equal(loads.ok,true); assert.deepEqual(loads.target.instanceNames,['u1']);
        assert.deepEqual(circuit.getState().graph.trace.origin.bits.map(bit=>bit.index),[4]);
        checks.push('波形分别反向追踪u0驱动与u1选定位的负载，未混淆重复模块定义');
        const previousGraph = circuit.getState().graph;
        await assert.rejects(wave.traceCircuit('not-present','drivers'),/不存在/);
        assert.equal(circuit.getState().graph,previousGraph); checks.push('未dump或不存在的波形行不改变当前电路追踪');

        const lease = await api.waveViewer.prepareForSimulation({paths:[waveFile],sourceFile:file,directory:root});
        assert.equal(api.waveLinks.state().waves,0); assert.equal(api.waveLinks.state().links.length,0);
        await assert.rejects(wave.traceCircuit('tb.dut.q0','drivers'),/关闭/);
        await execute(vvp,[executable],{cwd:root,env,windowsHide:true,timeout:30000});
        lease.dispose();
        const newWave = await api.waveViewer.openWaveform(waveFile,{sourceFile:file}); assert.ok(await newWave.initialized);
        try {
            const reattached = await confirmRoot(()=>newWave.traceCircuit('tb.dut.u1.dout','drivers'));
            assert.equal(reattached.ok,true); assert.equal(api.waveLinks.state().links.length,1);
            checks.push('重仿真关闭旧Worker并撤销映射，新VCD必须再次人工确认后才恢复联动');
            if(process.env.SVTOOLS_WAVE_LINK_VISUAL==='1') {
                await vscode.commands.executeCommand('workbench.action.closeSidebar');
                const sourceTabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input?.uri?.fsPath===file);
                if(sourceTabs.length)await vscode.window.tabGroups.close(sourceTabs,true);
                await fs.writeFile(path.join(root,'..','visual-ready.json'),JSON.stringify({root,extensionPath:extension.extensionPath,checks},null,2));
                const deadline=Date.now()+180000;
                while(Date.now()<deadline){try{await fs.access(path.join(root,'visual-continue'));break;}catch(error){if(error.code!=='ENOENT')throw error;}await pause(100);}
            }
            const editor = await vscode.window.showTextDocument(doc,vscode.ViewColumn.One);
            await editor.edit(edit=>edit.insert(new vscode.Position(0,0),'// changed source\n'));
            await until(()=>circuit.getState().sourceStale,'源码失效通知');
            assert.equal(api.waveLinks.state().links.length,0);
            await assert.rejects(circuit.linkWave(selection),/变化/);
            assert.equal(await fs.readFile(file,'utf8'),source);
            checks.push('脏源码撤销关联并拒绝旧图，磁盘夹具保持原文');
        } finally {await newWave.dispose();}
        await fs.writeFile(path.join(root,'..','host-report.json'),JSON.stringify({extensionPath:extension.extensionPath,version:extension.packageJSON.version,vscode:vscode.version,checks,loaded,linkState:api.waveLinks.state()},null,2));
    } finally {circuit.dispose();await wave.dispose();}
}
module.exports = {run};
