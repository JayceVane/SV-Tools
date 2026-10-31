'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {runProcess}=require('../src/toolchains/process');
const {findIverilogBinDir}=require('../src/toolchains/iverilog');
const {acquireWorkspaceLease}=require('../src/toolchains/workspace-lease');
const tasks=require('../src/agent/tasks');
const {directory,writeJson}=require('../src/agent/storage');
const cli=path.resolve(__dirname,'../src/cli/main.js');
async function fixture(t) {
    const workspace=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-agent-task-')));
    t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
    await fs.writeFile(path.join(workspace,'top.sv'),'module top;endmodule');return workspace;
}
async function until(workspace,id,expected) {
    const deadline=Date.now()+15000;
    while(Date.now()<deadline) {
        const output=await tasks.status({workspace},id);
        if(expected.includes(output.data.task.state)) return output.data;
        await delay(50);
    }
    assert.fail('后台任务未达到预期终态：'+expected);
}
test('启动进程退出后可取回可信失败结果，日志和取消入口有边界',async t=>{
    const workspace=await fixture(t);
    const started=await runProcess(process.execPath,[cli,'task','start','lint','--workspace',workspace,'--file','top.sv','--iverilog','missing-tool'],{timeoutMs:15000});
    assert.equal(started.code,0,started.stderr);
    const {data:{id}}=JSON.parse(started.stdout), output=await until(workspace,id,['failed']);
    assert.equal(output.result.status,'failed');assert.equal(output.result.diagnostics[0].code,'TOOL_NOT_FOUND');
    assert.equal((await tasks.cancel({workspace},id)).data.accepted,false);
    assert.equal((await tasks.list({workspace})).data.items.length,1);
    assert.equal((await tasks.logs({workspace},id)).data.text,'');
    await assert.rejects(tasks.status({workspace},'../../escape'),{code:'INVALID_TASK_ID'});
    await assert.rejects(tasks.logs({workspace,limit:100000},id),{code:'INVALID_ARGUMENT'});
});
test('退出但未完成的任务标记丢失，记录不会靠PID推测成功或误杀进程',async t=>{
    const workspace=await fixture(t),id=randomUUID(),folder=await directory(workspace,'tasks',id);
    await writeJson(path.join(folder,'status.json'),{id,state:'running',pid:process.pid,createdAt:new Date().toISOString()});
    const output=await tasks.status({workspace},id);assert.equal(output.data.task.state,'lost');assert.equal(output.data.result,null);
    assert.equal(process.kill(process.pid,0),true);
});
test('真实后台任务：查询日志，完成后源码变化不会把旧结果冒充当前证据',{skip:!findIverilogBinDir('')},async t=>{
    const workspace=await fixture(t), started=await tasks.start({workspace,file:'top.sv'}),id=started.data.id;
    const output=await until(workspace,id,['succeeded','failed']);assert.equal(output.task.state,'succeeded',JSON.stringify(output));assert.equal(output.sourceCurrent,true);
    const log=await tasks.logs({workspace},id);assert(log.data.logs.length>=2);
    await fs.appendFile(path.join(workspace,'top.sv'),'\n// new revision');
    assert.equal((await tasks.status({workspace},id)).data.sourceCurrent,false);
});
test('真实后台任务：占用两个共享槽时仍可查询并取消排队任务',{skip:!findIverilogBinDir('')},async t=>{
    const workspace=await fixture(t), held=[await acquireWorkspaceLease(workspace,'tool-process',{slots:1}),await acquireWorkspaceLease(workspace,'tool-process',{slots:2})];
    t.after(()=>Promise.all(held.map(release=>release())));
    const {data:{id}}=await tasks.start({workspace,file:'top.sv'});
    await until(workspace,id,['running']);
    // 配置被编辑坏了，也必须仍能控制已启动任务。
    await fs.writeFile(path.join(workspace,'.svtools','cli.json'),'{ invalid json');
    assert.equal((await tasks.cancel({workspace},id)).data.accepted,true);
    const output=await until(workspace,id,['cancelled']);assert.equal(output.result.status,'cancelled');
    await Promise.all(held.map(release=>release()));
});
