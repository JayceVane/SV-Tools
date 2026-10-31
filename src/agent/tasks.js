'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { canonicalWorkspace, resolveContext, page } = require('./context');
const { directory, writeJson, readJson } = require('./storage');
const { result, fail } = require('./protocol');
const { acquireWorkspaceLease } = require('../toolchains/workspace-lease');
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const terminal = new Set(['succeeded','failed','cancelled','lost']);

async function location(input,id) {
    if (!ID.test(id || '')) fail('INVALID_TASK_ID','任务ID必须为UUID');
    const options={workspace:await canonicalWorkspace(input)}, root=await directory(options.workspace,'tasks');
    const folder=path.join(root,id), stat=await fs.lstat(folder).catch(error=>{if(error.code!=='ENOENT') throw error;});
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('TASK_NOT_FOUND','任务不存在',{id});
    return {options,folder};
}
async function running(workspace,id) {
    try { const release=await acquireWorkspaceLease(workspace,'task-'+id,{waitMs:0}); await release(); return false; }
    catch(error) { if(error.code==='RESOURCE_BUSY') return true; throw error; }
}
async function status(input,id) {
    const {options,folder}=await location(input,id), state=await readJson(path.join(folder,'status.json'));
    if (!terminal.has(state.state) && (state.state!=='queued' || Date.now()-Date.parse(state.createdAt)>10000) && !await running(options.workspace,id)) {
        state.state='lost'; state.message='任务进程已退出，未留下可信的完成记录';
    }
    let output=null, sourceCurrent=null;
    try { output=await readJson(path.join(folder,'result.json')); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    if(['succeeded','failed','cancelled'].includes(state.state) && !output) {state.state='lost';state.message='任务完成记录缺少结果，无法确认执行结论';}
    if (output?.context) {
        try {
            const request=await readJson(path.join(folder,'request.json'));
            sourceCurrent=(await resolveContext(request.options)).context.revision===output.context.revision;
        } catch(error) { state.contextError={code:error.code || 'CONTEXT_UNAVAILABLE',message:error.message}; }
    }
    return result('task.status',{task:state,result:output,sourceCurrent});
}
async function start(input) {
    const resolved=await resolveContext(input), {options,context}=resolved;
    const release=await acquireWorkspaceLease(options.workspace,'task-create');
    let folder,id;
    try {
        const root=await directory(options.workspace,'tasks'), entries=await fs.readdir(root);
        if (entries.filter(name=>ID.test(name)).length>=128) fail('TASK_RECORD_LIMIT','已保存128份任务记录，请归档不再需要的任务目录');
        let active=0;
        for (const name of entries.filter(name=>ID.test(name))) {
            const state=await readJson(path.join(root,name,'status.json'));
            if (!terminal.has(state.state) && ((state.state==='queued' && Date.now()-Date.parse(state.createdAt)<10000) || await running(options.workspace,name))) active++;
        }
        if(active>=16) fail('TASK_LIMIT','同时活动的后台任务上限为16',{},4);
        id=randomUUID(); folder=await directory(options.workspace,'tasks',id);
        await writeJson(path.join(folder,'request.json'),{operation:'lint',options:{...options,expectedRevision:context.revision}});
        await writeJson(path.join(folder,'status.json'),{id,state:'queued',operation:'lint',createdAt:new Date().toISOString(),context:{id:context.id,revision:context.revision}});
        const child=spawn(process.execPath,[path.join(__dirname,'worker.js'),options.workspace,id],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
        await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject);});
        child.unref();
    } finally { await release(); }
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
        const state=await readJson(path.join(folder,'status.json'));
        if(state.state!=='queued') return result('task.start',{id,state:state.state},context);
        await delay(50);
    }
    await writeJson(path.join(folder,'cancel.json'),{requestedAt:new Date().toISOString()});
    fail('WORKER_START_TIMEOUT','后台任务启动超时，已请求取消',{id},4);
}
async function cancel(input,id) {
    const {options,folder}=await location(input,id), state=await readJson(path.join(folder,'status.json'));
    const accepted=!terminal.has(state.state);
    if(accepted) await writeJson(path.join(folder,'cancel.json'),{requestedAt:new Date().toISOString()});
    return result('task.cancel',{id,accepted,running:await running(options.workspace,id)});
}
async function logs(input,id) {
    const {folder}=await location(input,id);
    const state=await readJson(path.join(folder,'status.json'));
    let output;
    try { output=await readJson(path.join(folder,'result.json')); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    const artifacts=(output?.artifacts || state.artifacts || []).filter(artifact=>artifact.kind==='log');
    const index=input.logIndex ?? artifacts.length-1, offset=input.offset ?? 0, limit=input.limit ?? 16384;
    if (!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>65536 || !Number.isSafeInteger(index)) fail('INVALID_ARGUMENT','日志要求非负offset，limit在1至65536字节之间');
    if (!artifacts.length) return result('task.logs',{id,logs:[],text:'',nextOffset:null});
    const artifact=artifacts[index];
    if(!artifact) fail('LOG_NOT_FOUND','日志序号不存在',{count:artifacts.length});
    // 路径只能来自本工作区的受控运行目录，不能将任务记录变成任意文件读取入口。
    const allowed=path.resolve(folder,'..','..','runs'), relative=path.relative(allowed,path.resolve(artifact.path));
    if(relative.startsWith('..') || path.isAbsolute(relative) || !artifact.path.endsWith('.log')) fail('INVALID_RECORD','日志路径不在运行目录');
    let handle;
    try {
        const real=await fs.realpath(artifact.path), actual=path.relative(await fs.realpath(allowed),real);
        if(actual.startsWith('..') || path.isAbsolute(actual)) fail('INVALID_RECORD','日志链接指向运行目录之外');
        handle=await fs.open(real,'r');
    }
    catch(error) {
        if(error.code==='ENOENT') fail(['queued','running'].includes(state.state)?'LOG_NOT_READY':'ARTIFACT_EXPIRED','该次运行日志尚未创建或已经清理');
        throw error;
    }
    try {
        const stat=await handle.stat(), buffer=Buffer.alloc(limit), {bytesRead}=await handle.read(buffer,0,limit,offset);
        return result('task.logs',{id,logs:artifacts,index,offset,text:buffer.subarray(0,bytesRead).toString('utf8'),
            encoding:'utf-8',size:stat.size,nextOffset:offset+bytesRead<stat.size?offset+bytesRead:null});
    } finally { await handle.close(); }
}
async function list(input) {
    const options={workspace:await canonicalWorkspace(input)}, root=await directory(options.workspace,'tasks'), items=[];
    for(const name of await fs.readdir(root)) if(ID.test(name)) {
        const {folder}=await location(input,name); items.push(await readJson(path.join(folder,'status.json')));
    }
    items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return result('task.list',page(items,input.offset,input.limit));
}
module.exports={start,status,cancel,logs,list,location};
