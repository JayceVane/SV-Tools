'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {fail}=require('../agent/protocol');
const storage=require('../agent/storage');
const {hash}=require('./workflow-contract');
const MAX_TEXT=8*1024*1024,MAX_ARTIFACT=2*1024*1024*1024;
const cache=new Map();
const identity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
function inside(file,root){const rel=path.relative(root,file);return rel!== '..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}
async function safePath(root,value,{missing=false}={}) {
    const realRoot=await fs.realpath(root),file=path.resolve(realRoot,value);
    if(!inside(file,realRoot)||file===realRoot)fail('INVALID_PATH','路径必须位于工作区内',{file:value});
    let current=realRoot;const parts=path.relative(realRoot,file).split(path.sep);
    for(let index=0;index<parts.length;index++){
        current=path.join(current,parts[index]);
        let stat;try{stat=await fs.lstat(current);}catch(error){if(error.code==='ENOENT'&&missing)return file;throw error;}
        if(stat.isSymbolicLink())fail('UNSAFE_PATH','计划、记录或证据路径不能包含链接',{file:value});
        if(index<parts.length-1&&!stat.isDirectory())fail('INVALID_PATH','路径的父级不是目录',{file:value});
    }
    return file;
}
async function fingerprint(root,relative,max=MAX_TEXT){
    const file=await safePath(root,relative),stat=await fs.lstat(file,{bigint:true});
    if(!stat.isFile()||stat.size>BigInt(max))fail('SOURCE_LIMIT','文件超过预算或不是普通文件',{file:relative,max});
    const key=file+':'+identity(stat);
    if(cache.has(key))return {...cache.get(key),path:relative};
    const handle=await fs.open(file,'r');
    try {
        const before=await handle.stat({bigint:true});if(identity(before)!==identity(stat))fail('SOURCE_CHANGED','打开文件时身份变化',{file:relative});
        const digest=createHash('sha256');let bytes=0;
        for await(const chunk of handle.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>max)fail('SOURCE_LIMIT','文件读取超过预算');digest.update(chunk);}
        if(identity(await handle.stat({bigint:true}))!==identity(before)||identity(await fs.lstat(file,{bigint:true}))!==identity(before))fail('SOURCE_CHANGED','文件读取期间变化',{file:relative});
        const result={path:relative,sha256:digest.digest('hex'),bytes,identity:identity(before)};
        cache.set(key,result);if(cache.size>2048)cache.delete(cache.keys().next().value);return result;
    }finally{await handle.close();}
}
async function json(root,relative,max=MAX_TEXT){const file=await safePath(root,relative);return storage.readJson(file,max);}
async function snapshot(root,files){let bytes=0;const result=[];for(const file of [...new Set(files)].sort()){const item=await fingerprint(root,file);bytes+=item.bytes;if(bytes>64*1024*1024)fail('SOURCE_LIMIT','模块输入总量超过64 MiB');result.push(item);}return result;}
async function unchanged(root,items){for(const item of items||[]){try{if((await fingerprint(root,item.path)).sha256!==item.sha256)return false;}catch(error){if(['ENOENT','INVALID_PATH','UNSAFE_PATH','SOURCE_CHANGED'].includes(error.code))return false;throw error;}}return true;}
function stateRelative(plan,planFile){return '.svtools/agent/design-workflow/'+hash(plan.id+'|'+(process.platform==='win32'?planFile.toLowerCase():planFile)).slice(0,24)+'.json';}
async function readState(root,plan,planFile){const relative=stateRelative(plan,planFile);try{const state=await json(root,relative,16*1024*1024);if(state.schemaVersion!==1||state.planId!==plan.id||!Number.isSafeInteger(state.revision)||state.revision<0||!state.modules||Array.isArray(state.modules)||!Array.isArray(state.history)||typeof state.modules!=='object')fail('INVALID_RECORD','任务记录格式无效');return state;}catch(error){if(error.code!=='ENOENT')throw error;return {schemaVersion:1,planId:plan.id,revision:0,modules:{},history:[]};}}
async function transaction(root,plan,planFile,expected,action){
    if(!Number.isSafeInteger(expected)||expected<0)fail('INVALID_ARGUMENT','写操作需要当前 --revision');
    const directory=await storage.directory(root,'design-workflow');
    const file=await safePath(root,stateRelative(plan,planFile),{missing:true}),lock=file+'.lock';let handle;
    const deadline=Date.now()+3000;
    while(!handle){try{handle=await fs.open(lock,'wx');}catch(error){if(error.code!=='EEXIST')throw error;if(Date.now()>=deadline)fail('STATE_BUSY','任务状态正在写入；如进程已异常停止，请确认后清理锁文件',{lock});await new Promise(resolve=>setTimeout(resolve,30));}}
    try {
        const state=await readState(root,plan,planFile);if(state.revision!==expected)fail('STATE_CONFLICT','任务版本已改变，请重新读取清单',{expected,actual:state.revision});
        const value=await action(state);state.revision++;
        if(Buffer.byteLength(JSON.stringify(state))>16*1024*1024)fail('SOURCE_LIMIT','任务历史超过16 MiB');
        await storage.writeJson(file,state);return {state,value};
    }finally{await handle.close();await fs.unlink(lock);}
}
async function create(root,relative,content){const file=await safePath(root,relative,{missing:true});await require('./scaffold-paths').createContainedDirectories(path.dirname(file),root);await fs.writeFile(file,content,{flag:'wx'});return file;}
async function artifactCurrent(root,item){try{return identity(await fs.lstat(await safePath(root,item.path),{bigint:true}))===item.identity;}catch(error){if(['ENOENT','INVALID_PATH','UNSAFE_PATH'].includes(error.code))return false;throw error;}}
module.exports={safePath,fingerprint,json,snapshot,unchanged,readState,transaction,create,artifactCurrent,MAX_TEXT,MAX_ARTIFACT,hash,randomUUID};
