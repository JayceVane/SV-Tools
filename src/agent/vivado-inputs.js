'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { hash } = require('./context');
const { fail } = require('./protocol');
const { keyOf, inside } = require('../project/model');
const { resolveXprPath } = require('../vivado/xpr');
const { maskSourceText } = require('../workspace/sources');

// 预算按输入类别独立计算：文本源码、初始化数据、二进制产物互不挤占；默认值待真实工程基准后定稿。
// 文本默认沿用既有上限（64MiB/8MiB）；二进制单列预算，不受文本上限约束；默认值待真实工程基准后定稿。
const DEFAULT_BUDGET = { textMiB: 64, initMiB: 64, binaryMiB: 2048, cacheMiB: 8192, textFileMiB: 8, initFileMiB: 64, binaryFileMiB: 2048 };
const MAX_COPY_BYTES = 2048 * 1024 * 1024;
const TEXT = /\.(?:sv|v|svh|vh|xdc|tcl|inc|h)$/i, INIT = /\.(?:mem|mif|coe|hex)$/i;
const xml = value => String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fileSet = element => element.parents.find(parent=>parent.name==='FileSet')?.attrs;
const automatic = element => element.attrs?.Type==='Utils' || fileSet(element)?.Type==='Utils';
const runtimeRun = new Set(['State','Dir','AutoIncrementalDir','AutoRQSDir']);
function unsupported(message,details) { fail('SNAPSHOT_UNSUPPORTED',message,details); }
function kindOf(file) { return TEXT.test(file) ? 'text' : INIT.test(file) ? 'init' : 'binary'; }
/** 预算单位MiB；缺省取DEFAULT_BUDGET，非法值在配置层已被拒绝。 */
function budgetOf(options) { const block = options.budget || {}, out = {}; for (const name of Object.keys(DEFAULT_BUDGET)) out[name] = Math.round((Number.isSafeInteger(block[name]) ? block[name] : DEFAULT_BUDGET[name]) * 1024 * 1024); return out; }
function cacheDir(workspace) { return path.join(workspace, '.svtools', 'agent', 'vivado', 'cache'); }
function cachePath(workspace, sha256) { return path.join(cacheDir(workspace), sha256.slice(0, 2), sha256); }

/** 输入配置只含工程/文件集/运行设置；工具生成的缓存、视图与完成状态不属于设计配置。 */
function configuration(document) {
    const tokens=[];
    for(const element of document.elements) {
        if(automatic(element)) continue;
        const section=element.parents.find(parent=>['Configuration','FileSets','Runs'].includes(parent.name));
        if(!section && !['Configuration','FileSets','Runs'].includes(element.name)) continue;
        if(['GeneratedRun','RQSFiles'].includes(element.name) || element.parents.some(parent=>['GeneratedRun','RQSFiles'].includes(parent.name))) continue;
        if(element.name==='Option' && /^(?:WT|DcpsUptoDate$|Id$)/.test(element.attrs?.Name || '')) continue;
        const attrs=Object.entries(element.attrs || {}).filter(([name])=>element.name!=='Run' || (!runtimeRun.has(name) && !(name==='IncrementalCheckpoint' && element.attrs.AutoIncrementalCheckpoint==='true'))).sort(([a],[b])=>a.localeCompare(b));
        tokens.push([element.name,element.closing,element.empty,attrs]);
    }
    return hash(JSON.stringify(tokens));
}
/** 文本/初始化输入按预算整体读入；超预算按类别报错并给出实测值。 */
async function readText(file,budget,kind) {
    const handle=await fs.open(file,'r');
    try {
        const stat=await handle.stat();
        if(!stat.isFile() || stat.size>budget) fail('SOURCE_LIMIT','输入超出预算',{file,class:kind,size:stat.size,limit:budget});
        const buffer=Buffer.alloc(stat.size+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
        if(bytesRead!==stat.size) fail('SOURCE_CHANGED','读取输入时文件变化',{file});
        return buffer.subarray(0,bytesRead);
    } finally {await handle.close();}
}
/** 大文件流式复制并同时计算哈希，避免整块进内存；写入临时文件后原子改名。 */
async function streamToCache(file,workspace,perFile) {
    const temporary=path.join(cacheDir(workspace),'.tmp-'+createHash('sha256').update(file).digest('hex').slice(0,16));
    await fs.mkdir(cacheDir(workspace),{recursive:true});
    const digest=createHash('sha256');let size=0;
    const out=await fs.open(temporary,'w');
    try {
        for await (const chunk of createReadStream(file)) {
            size+=chunk.length;
            if(size>perFile) fail('SOURCE_LIMIT','输入超出预算',{file,class:'binary',size,limit:perFile});
            digest.update(chunk);await out.write(chunk);
        }
    } finally {await out.close();}
    const sha256=digest.digest('hex'),target=cachePath(workspace,sha256);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.rename(temporary,target).catch(async error=>{ if(error.code!=='EEXIST' && error.code!=='EPERM') throw error; await fs.rm(temporary,{force:true}); });
    return {sha256,size};
}
async function cacheWrite(workspace,sha256,bytes) {
    const target=cachePath(workspace,sha256);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,bytes,{flag:'wx'}).catch(error=>{ if(error.code!=='EEXIST') throw error; });
}
function originalPath(document,value) {
    const resolved=resolveXprPath(value,document.parsed.dir,path.basename(document.parsed.path,'.xpr'));
    if(/\$[A-Z_]+/.test(resolved)) unsupported('无法解析工程路径变量',{value});
    return resolved;
}

async function stageFile(file,workspace,budget) {
    const kind=kindOf(file);
    if(kind==='binary') return {kind,...await streamToCache(file,workspace,budget.binaryFileMiB)};
    const bytes=await readText(file,budget[kind+'FileMiB'],kind);
    const sha256=hash(bytes);
    await cacheWrite(workspace,sha256,bytes);
    return {kind,bytes,sha256,size:bytes.length};
}

/** 在运行前捕获所有显式文件和头文件；按类别预算累加，内容写入内容寻址缓存并去重。 */
async function captureInputs(resolved,run) {
    const {context,project,options}=resolved, document=project.document;
    const budget=budgetOf(options), workspace=options.workspace;
    const runElement=document.elements.find(element=>element.name==='Run' && !element.closing && element.attrs.Id===run);
    const synth=runElement?.attrs.SynthRun && document.elements.find(element=>element.name==='Run' && !element.closing && element.attrs.Id===runElement.attrs.SynthRun);
    const srcSet=runElement?.attrs.SrcSet || synth?.attrs.SrcSet;
    if(srcSet && srcSet!==context.fileset) fail('VIVADO_CONTEXT_MISMATCH','所选文件集与run使用的源文件集不同',{selected:context.fileset,actual:srcSet,run});
    const files=new Map(),used={text:0,init:0,binary:0};
    for(const [file,value] of [...resolved.contents,...resolved.auxiliaryContents]) {
        const kind=kindOf(file),bytes=value.bytes;
        if(kind!=='binary' && bytes.length>budget[kind+'FileMiB']) fail('SOURCE_LIMIT','输入超出预算',{file,class:kind,size:bytes.length,limit:budget[kind+'FileMiB']});
        used[kind]+=bytes.length;
        if(used[kind]>budget[kind+'MiB'] && kind!=='binary') fail('SOURCE_LIMIT','输入超出预算',{file,class:kind,size:used[kind],limit:budget[kind+'MiB']});
        const sha256=hash(bytes);await cacheWrite(workspace,sha256,bytes);
        files.set(keyOf(file),{path:file,kind,sha256,size:bytes.length,bytes:kind==='binary'?null:bytes});
    }
    for(const element of document.elements) {
        if(/TCL[._](?:PRE|POST)$/i.test(element.attrs?.Name || element.attrs?.Id || '') && element.attrs?.Val) unsupported('本轮隔离运行暂不接受外部Tcl运行钩子',{property:element.attrs.Name || element.attrs.Id});
        if(element.name==='Run' && element.attrs?.IncrementalCheckpoint && element.attrs.AutoIncrementalCheckpoint!=='true') unsupported('显式增量检查点尚不能可靠隔离',{run:element.attrs.Id});
        if(element.name!=='File' || element.closing) continue;
        const file=originalPath(document,element.attrs?.Path);
        if(/\.(?:xci|xcix|bd|dcp|tcl)$/i.test(file)) unsupported('该工程包含尚未支持隔离的IP/脚本/检查点输入',{file});
        if(files.has(keyOf(file))) continue;
        const staged=await stageFile(file,workspace,budget);
        used[staged.kind]+=staged.size;
        if(used[staged.kind]>budget[staged.kind+'MiB']) fail('SOURCE_LIMIT','输入超出预算',{file,class:staged.kind,size:used[staged.kind],limit:budget[staged.kind+'MiB']});
        files.set(keyOf(file),{path:file,...staged});
    }
    const inputs=[...files.values()].map(file=>({path:file.path,sha256:file.sha256,kind:file.kind,size:file.size})).sort((a,b)=>keyOf(a.path).localeCompare(keyOf(b.path)));
    if(files.size>4096) fail('SOURCE_LIMIT','输入条目超过4096项',{count:files.size});
    const config={policy:'rtl-snapshot-v2',project:configuration(document),fileset:context.fileset,top:context.top,defines:context.defines,includeDirs:context.includeDirs.map(keyOf),run};
    return {document,files,inputs,used,config,synthRun:runElement?.attrs.SynthRun || null,fingerprint:hash(JSON.stringify([config,inputs]))};
}

function rewriteSource(file,text,captured,relocate,context) {
    if(/\.xdc$/i.test(file)) {
        if(/(?:^|[;\n\[{])[ \t]*(?:::)?(?:source|exec|open|read_xdc|read_verilog|read_checkpoint|read_mem|glob|eval|uplevel)\b/im.test(text.replace(/^\s*#.*$/gm,''))) unsupported('XDC包含外部读取或动态脚本，暂不能可靠隔离',{file});
        return text;
    }
    if(!/\.(?:sv|v|svh|vh)$/i.test(file)) return text;
    const masked=maskSourceText(text), edits=[];
    for(const match of masked.matchAll(/`include\b/g)) {
        const directive=/^`include[ \t]+"([^"\r\n]+)"/.exec(text.slice(match.index));
        if(!directive) unsupported('隔离运行要求include使用双引号字面量',{file});
        const name=directive[1], candidates=path.isAbsolute(name)?[name]:[path.resolve(path.dirname(file),name),...context.includeDirs.map(dir=>path.resolve(dir,name))];
        const input=candidates.map(candidate=>captured.files.get(keyOf(candidate))).find(Boolean);
        const target=input?relocate(input.path):path.join(path.dirname(relocate(file)),'missing',hash(name).slice(0,16),path.basename(name));
        edits.push({start:match.index,end:match.index+directive[0].length,text:'`include "'+target.replace(/\\/g,'/')+'"'});
    }
    for(const match of masked.matchAll(/\$readmem[hb]\s*\(/g)) {
        const call=/^\$readmem([hb])\s*\(\s*"([^"\r\n]+)"/.exec(text.slice(match.index));
        if(!call) unsupported('存储器初始化文件必须为可捕获的字面量',{file});
        const input=[path.resolve(path.dirname(file),call[2]),path.resolve(captured.document.parsed.dir,call[2])].map(candidate=>captured.files.get(keyOf(candidate))).find(Boolean);
        if(!input) unsupported('存储器初始化文件未加入工程',{file,data:call[2]});
        edits.push({start:match.index,end:match.index+call[0].length,text:'$readmem'+call[1]+'("'+relocate(input.path).replace(/\\/g,'/')+'"'});
    }
    let output=text;for(const edit of edits.sort((a,b)=>b.start-a.start)) output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
    return output;
}

async function materialize(captured,resolved,buildDirectory) {
    const workspace=resolved.options.workspace;
    const root=path.join(buildDirectory,'project'), project=path.join(root,path.basename(resolved.context.project.path));
    const folder=dir=>path.join(buildDirectory,'inputs',hash(keyOf(dir)).slice(0,16));
    const relocate=file=>path.join(folder(path.dirname(file)),path.basename(file));
    const copies=[];
    for(const input of captured.files.values()) {
        const object=cachePath(workspace,input.sha256), copy=relocate(input.path);
        await fs.mkdir(path.dirname(copy),{recursive:true});
        if(input.kind==='text' && /\.(?:sv|v|svh|vh|xdc)$/i.test(input.path)) {
            const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await fs.readFile(object));
            const bytes=Buffer.from(rewriteSource(input.path,text,captured,relocate,resolved.context));
            await fs.writeFile(copy,bytes,{flag:'wx'});copies.push({original:input.path,path:copy,sha256:hash(bytes)});
        } else {
            await fs.copyFile(object,copy);copies.push({original:input.path,path:copy,sha256:input.sha256});
        }
    }
    const edits=[];
    for(const element of captured.document.elements) {
        if(automatic(element)) {edits.push({...element,text:''});continue;}
        if(element.closing) continue;
        const attrs={...element.attrs};let changed=false;
        if(element.name==='Project') {attrs.Path=project.replace(/\\/g,'/');changed=true;}
        if(element.name==='DefaultLaunch') {attrs.Dir='$PRUNDIR';changed=true;}
        if(element.name==='File') {attrs.Path=relocate(originalPath(captured.document,attrs.Path)).replace(/\\/g,'/');changed=true;}
        if(element.name==='Option' && attrs.Name==='VerilogDir') {attrs.Val=folder(originalPath(captured.document,attrs.Val)).replace(/\\/g,'/');changed=true;}
        if(element.name==='Run') {for(const name of [...runtimeRun,'IncrementalCheckpoint']) delete attrs[name];attrs.AutoIncrementalCheckpoint='false';changed=true;}
        if(changed) edits.push({...element,text:'<'+element.name+Object.entries(attrs).map(([key,value])=>' '+key+'="'+xml(value)+'"').join('')+(element.empty?'/>':'>')});
    }
    let text=captured.document.text;
    for(const edit of edits.sort((a,b)=>b.start-a.start)) text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);
    await fs.mkdir(root,{recursive:true});await fs.writeFile(project,text,{flag:'wx'});
    return {project,root:buildDirectory,copies,includeDirs:resolved.context.includeDirs.map(folder)};
}
async function fileIdentity(file,maxBytes=512*1024*1024) {
    const stat=await fs.lstat(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>maxBytes) fail('ARTIFACT_INVALID','检查点文件不合法或超过512MiB预算',{file});
    const digest=createHash('sha256');let size=0;
    for await(const chunk of createReadStream(file)) {size+=chunk.length;if(size>maxBytes) fail('ARTIFACT_INVALID','读取检查点时超过预算',{file});digest.update(chunk);}
    if(size!==stat.size) fail('ARTIFACT_INVALID','读取检查点时文件变化',{file});
    return {path:file,bytes:size,sha256:digest.digest('hex')};
}
async function verifyCopies(snapshot) {
    for(const file of snapshot.copies) if((await fileIdentity(file.path,MAX_COPY_BYTES)).sha256!==file.sha256) fail('CONTEXT_CHANGED','本轮隔离输入被修改',{file:file.original},4);
}
async function checkpoints(snapshot,paths) {
    if(!paths.length || paths.length>32) fail('VIVADO_NO_RESULT','运行未提供可信的DCP检查点');
    const output=[];
    for(const file of paths) {
        if(!inside(file,snapshot.root) || !/\.dcp$/i.test(file)) fail('ARTIFACT_INVALID','检查点不在隔离构建目录',{file});
        const real=await fs.realpath(file);if(!inside(real,await fs.realpath(snapshot.root))) fail('ARTIFACT_INVALID','检查点链接越界',{file});
        output.push(await fileIdentity(real));
    }
    return output;
}
/** 内容寻址缓存按最近成功构建引用集合剪枝；活动构建与失败记录另由构建目录配额管理。 */
async function pruneCache(workspace,keep=5) {
    const manifests=path.join(workspace,'.svtools','agent','vivado','manifests');
    let entries=[];
    try { entries=(await fs.readdir(manifests)).filter(name=>name.endsWith('.json')); } catch(error) { if(error.code==='ENOENT') return 0; throw error; }
    const referenced=new Set();
    for(const name of entries) {
        let record;
        try { record=JSON.parse(await fs.readFile(path.join(manifests,name),'utf8')); } catch(error) { continue; }
        if(record?.schemaVersion!==2 || record.state!=='complete') continue;
        for(const input of record.inputs || []) referenced.add(input.sha256);
    }
    let removed=0;
    const base=cacheDir(workspace);
    for(const bucket of await fs.readdir(base).catch(()=>[])) {
        const directory=path.join(base,bucket);
        const stat=await fs.lstat(directory).catch(()=>null);
        if(!stat?.isDirectory()) continue;
        for(const name of await fs.readdir(directory)) {
            if(referenced.has(name)) continue;
            await fs.rm(path.join(directory,name),{force:true});removed++;
        }
    }
    return removed;
}

module.exports={captureInputs,materialize,verifyCopies,checkpoints,fileIdentity,pruneCache,budgetOf,kindOf};