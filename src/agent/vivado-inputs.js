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

const MAX_BYTES=64*1024*1024, MAX_FILE_BYTES=8*1024*1024;
const xml = value => String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fileSet = element => element.parents.find(parent=>parent.name==='FileSet')?.attrs;
const automatic = element => element.attrs?.Type==='Utils' || fileSet(element)?.Type==='Utils';
const runtimeRun = new Set(['State','Dir','AutoIncrementalDir','AutoRQSDir']);
function unsupported(message,details) { fail('SNAPSHOT_UNSUPPORTED',message,details); }

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
async function boundedRead(file,remaining) {
    const handle=await fs.open(file,'r');
    try {
        const stat=await handle.stat();
        if(!stat.isFile() || stat.size>MAX_FILE_BYTES || stat.size>remaining) fail('SOURCE_LIMIT','Vivado输入超过单文件8MiB/合计64MiB预算',{file});
        const buffer=Buffer.alloc(stat.size+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
        if(bytesRead!==stat.size) fail('SOURCE_CHANGED','读取Vivado输入时文件变化',{file});
        return buffer.subarray(0,bytesRead);
    } finally {await handle.close();}
}
function originalPath(document,value) {
    const resolved=resolveXprPath(value,document.parsed.dir,path.basename(document.parsed.path,'.xpr'));
    if(/\$[A-Z_]+/.test(resolved)) unsupported('无法解析工程路径变量',{value});
    return resolved;
}

/** 在运行前捕获所有显式文件和头文件。未知的脚本/IP依赖不允许冒充完整快照。 */
async function captureInputs(resolved,run) {
    const {context,project}=resolved, document=project.document;
    const runElement=document.elements.find(element=>element.name==='Run' && !element.closing && element.attrs.Id===run);
    const synth=runElement?.attrs.SynthRun && document.elements.find(element=>element.name==='Run' && !element.closing && element.attrs.Id===runElement.attrs.SynthRun);
    const srcSet=runElement?.attrs.SrcSet || synth?.attrs.SrcSet;
    if(srcSet && srcSet!==context.fileset) fail('VIVADO_CONTEXT_MISMATCH','所选文件集与run使用的源文件集不同',{selected:context.fileset,actual:srcSet,run});
    const files=new Map([...resolved.contents,...resolved.auxiliaryContents].map(([file,value])=>[keyOf(file),{path:file,bytes:value.bytes}]));
    let total=[...files.values()].reduce((sum,file)=>sum+file.bytes.length,0);
    for(const element of document.elements) {
        if(element.closing || automatic(element)) continue;
        if(/TCL[._](?:PRE|POST)$/i.test(element.attrs.Name || element.attrs.Id || '') && element.attrs.Val) unsupported('本轮隔离运行暂不接受外部Tcl运行钩子',{property:element.attrs.Name || element.attrs.Id});
        if(element.name==='Run' && element.attrs.IncrementalCheckpoint && element.attrs.AutoIncrementalCheckpoint!=='true') unsupported('显式增量检查点尚不能可靠隔离',{run:element.attrs.Id});
        if(element.name!=='File') continue;
        const file=originalPath(document,element.attrs.Path);
        if(/\.(?:xci|xcix|bd|dcp|tcl)$/i.test(file)) unsupported('该工程包含尚未支持隔离的IP/脚本/检查点输入',{file});
        if(!files.has(keyOf(file))) {
            const bytes=await boundedRead(file,MAX_BYTES-total);total+=bytes.length;files.set(keyOf(file),{path:file,bytes});
        }
    }
    if(files.size>4096 || total>MAX_BYTES) fail('SOURCE_LIMIT','Vivado输入快照超过4096项/64MiB预算');
    const inputs=[...files.values()].map(file=>({path:file.path,sha256:hash(file.bytes)})).sort((a,b)=>keyOf(a.path).localeCompare(keyOf(b.path)));
    const config={policy:'rtl-snapshot-v1',project:configuration(document),fileset:context.fileset,top:context.top,defines:context.defines,includeDirs:context.includeDirs.map(keyOf),run};
    return {document,files,inputs,config,synthRun:runElement?.attrs.SynthRun || null,fingerprint:hash(JSON.stringify([config,inputs]))};
}
function rewriteSource(file,text,captured,relocate,context) {
    if(/\.xdc$/i.test(file)) {
        // XDC是可执行Tcl；没有捕获到的文件读取/脚本调用不能默认为封闭输入。
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
        // 未启用条件分支可能引用缺失头文件；指向快照内的缺失路径，让编译器判断是否实际需要。
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
    const root=path.join(buildDirectory,'project'), project=path.join(root,path.basename(resolved.context.project.path));
    const folder=dir=>path.join(buildDirectory,'inputs',hash(keyOf(dir)).slice(0,16));
    const relocate=file=>path.join(folder(path.dirname(file)),path.basename(file));
    const copies=[];
    for(const input of captured.files.values()) {
        let bytes=input.bytes;
        if(/\.(?:sv|v|svh|vh|xdc)$/i.test(input.path)) bytes=Buffer.from(rewriteSource(input.path,new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),captured,relocate,resolved.context));
        const copy=relocate(input.path);await fs.mkdir(path.dirname(copy),{recursive:true});await fs.writeFile(copy,bytes,{flag:'wx'});
        copies.push({original:input.path,path:copy,sha256:hash(bytes)});
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
        if(element.name==='Run') {
            // 副本从头构建，不带原工程工具自动维护的运行目录和增量缓存。
            for(const name of [...runtimeRun,'IncrementalCheckpoint']) delete attrs[name];
            attrs.AutoIncrementalCheckpoint='false';changed=true;
        }
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
    for(const file of snapshot.copies) if((await fileIdentity(file.path,MAX_FILE_BYTES)).sha256!==file.sha256) fail('CONTEXT_CHANGED','本轮隔离输入被修改',{file:file.original},4);
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
module.exports={captureInputs,materialize,verifyCopies,checkpoints,fileIdentity};
