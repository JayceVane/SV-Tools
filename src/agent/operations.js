'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readOptions, resolveContext, listProjects, assertCurrent, page, hash } = require('./context');
const { maskSourceText } = require('../workspace/sources');
const { keyOf } = require('../project/model');
const { result, fail, identity } = require('./protocol');
const { directory, writeJson } = require('./storage');
const { createNativeLoader } = require('../native-loader');
const { buildFormatOptions } = require('../configuration');
const { preservesCharacters } = require('../editor/format-safety');
const iverilog = require('../toolchains/iverilog');
const { runProcess } = require('../toolchains/process');
const { createToolTaskManager } = require('../toolchains/job');
const { summarizeToolResult, processSucceeded } = require('../toolchains/result');
const { acquireWorkspaceLease } = require('../toolchains/workspace-lease');

const capabilities = ['doctor','project.list','project.inspect','format.preview','format.check','format.write','lint','task.start','task.list','task.status','task.logs','task.cancel'];
async function locateIverilog(options) {
    const executable = process.platform === 'win32' ? 'iverilog.exe' : 'iverilog';
    const configured = options.iverilog ? path.resolve(options.workspace,options.iverilog) : null;
    const bin = configured ? iverilog.normalizeToolDirPath(configured) : iverilog.findIverilogBinDir('');
    const command = bin && path.join(bin,executable);
    if (!command || !(await fs.stat(command).catch(()=>null))?.isFile()) fail('TOOL_NOT_FOUND','未找到Icarus Verilog，请设置--iverilog或CLI配置中的iverilog',{configured});
    const cygwin = options.cygwin ? path.resolve(options.workspace,options.cygwin) : null;
    return { iverilog:command, env:iverilog.buildChildEnv(iverilog.findCygwinBinDir(cygwin,bin)) };
}
async function probeTool(tool, task, options) {
    const output = await task.run(tool.iverilog,['-V'],{stage:'version',env:tool.env,timeoutMs:Math.min(options.timeoutMs || 10000,10000)});
    if (!processSucceeded(output)) fail('TOOL_UNAVAILABLE','Icarus Verilog无法启动',{logPath:output.logPath,reason:output.errorMessage || output.logError || output.code});
    return {path:tool.iverilog,version:(output.stdout+'\n'+output.stderr).split(/\r?\n/).find(line=>/Icarus Verilog version/i.test(line)) || 'unknown'};
}
async function doctor(input) {
    const {options} = await readOptions(input), tools = {};
    const native = createNativeLoader();
    try { native.load(); tools.formatter = {available:true,path:native.modulePath}; }
    catch(error) { tools.formatter = {available:false,message:error.message}; }
    try {
        const tool = await locateIverilog(options), release = await acquireWorkspaceLease(options.workspace,'tool-process',{slots:2});
        try {
            const output = await runProcess(tool.iverilog,['-V'],{env:tool.env,timeoutMs:10000});
            tools.iverilog = {available:processSucceeded(output),path:tool.iverilog,
                version:(output.stdout+'\n'+output.stderr).split(/\r?\n/).find(line=>/Icarus Verilog version/i.test(line)) || null,
                message:output.errorMessage || (processSucceeded(output)?null:'工具探测失败')};
        } finally { await release(); }
    } catch(error) { tools.iverilog = {available:false,message:error.message}; }
    return result('doctor',{capabilities,tools,runtime:{node:process.version,platform:process.platform,arch:process.arch},workspace:options.workspace});
}
async function projects(input) {
    const {options} = await readOptions(input);
    return result('project.list',page(await listProjects(options.workspace),input.offset,input.limit));
}
async function inspect(input) {
    const {context} = await resolveContext(input);
    return result('project.inspect',{files:page(context.files,input.offset,input.limit),units:page(context.units,input.offset,input.limit),
        includeDirs:context.includeDirs,defines:context.defines,standard:context.standard,limitations:context.limitations},context);
}
async function format(input) {
    const resolved = await resolveContext(input), {options,context,contents} = resolved;
    if (!options.file) fail('FILE_REQUIRED','格式化需要--file');
    if (input.write && input.check) fail('INVALID_ARGUMENT','--write与--check不能同时使用');
    const source = contents.get(options.file).text;
    const formatter = createNativeLoader().load();
    const formatted = formatter.formatText(source,buildFormatOptions({get:(key,fallback)=>options.format?.[key] ?? fallback}));
    if (!preservesCharacters(source,formatted)) fail('FORMAT_INVARIANT','格式化结果改变了非空白字符，已拒绝写入');
    const changed = source !== formatted;
    let written = false;
    if (input.write && changed) {
        const release = await acquireWorkspaceLease(options.workspace,'format-'+hash(options.file).slice(0,32));
        const temporary = path.join(path.dirname(options.file),'.svtools-format-'+randomUUID()+'.tmp');
        try {
            const stat = await fs.lstat(options.file);
            if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_PATH','格式化写入目标必须为普通文件');
            await assertCurrent(resolved);
            await fs.writeFile(temporary,formatted,{flag:'wx',mode:stat.mode});
            // 写入是显式操作，提交前再次核对原文件和工程身份。
            await assertCurrent(resolved);
            await fs.rename(temporary,options.file); written = true;
        } finally { await fs.rm(temporary,{force:true}); await release(); }
    } else { await assertCurrent(resolved); }
    const response = result(input.write?'format.write':input.check?'format.check':'format.preview',{
        file:options.file,changed,written,sourceSha256:hash(contents.get(options.file).bytes),resultSha256:hash(Buffer.from(formatted)),
        ...(input.check || input.write ? {} : {preview:formatted.slice(0,32768),previewTruncated:formatted.length>32768})},context);
    if (input.check && changed) response.status = 'changes_required';
    return response;
}

function selectTarget(resolved) {
    const {context,options} = resolved;
    const candidates = context.units.filter(unit=>unit.kind==='module' || unit.kind==='macromodule');
    const matching = candidates.filter(unit=>(!options.file || unit.file===options.file) && (!context.top || unit.name===context.top));
    if (matching.length!==1) fail('AMBIGUOUS_TOP','请明确指定唯一的--file与--top',{candidates:matching});
    return matching[0];
}
/** 将本轮输入复制到隔离目录，工具输出映射回原始源码路径。 */
async function snapshotInputs(resolved, runDirectory) {
    const root = path.join(runDirectory,'inputs'), mapped = new Map(), reverse = new Map(), byKey=new Map();
    const relocate = file => path.join(root,...path.resolve(file).replace(/:/g,'').split(/[\\/]+/).filter(Boolean));
    for (const file of resolved.contents.keys()) { const copy=relocate(file); mapped.set(file,copy); reverse.set(keyOf(copy),file);byKey.set(keyOf(file),copy); }
    const includeDirs=[...new Set([...resolved.context.includeDirs,...resolved.context.files.map(file=>path.dirname(file.path))])];
    for (const [file,{bytes,text}] of resolved.contents) {
        // M1只接受可验证的字面量include；宏include留给后续完整编译上下文适配。
        const masked=maskSourceText(text), chunks=[];let offset=0;
        for(const match of masked.matchAll(/`include\b/g)) {
            const directive=/^`include[ \t]+"([^"\r\n]+)"/.exec(text.slice(match.index));
            if(!directive) fail('UNSUPPORTED_INCLUDE','M1要求include使用双引号字面量',{file});
            const name=directive[1], candidates=path.isAbsolute(name)?[name]:[path.resolve(path.dirname(file),name),...includeDirs.map(dir=>path.resolve(dir,name))];
            // 未收录的include改指向快照内的缺失路径，由编译器判断条件分支是否实际需要它。
            const target=candidates.map(candidate=>byKey.get(keyOf(candidate))).find(Boolean) || path.join(root,'unresolved',hash(name),path.basename(name));
            // include内容不会经过Windows argv路径转换；相对快照根路径兼容Cygwin预处理器。
            chunks.push(text.slice(offset,match.index),'`include "'+path.relative(root,target).replace(/\\/g,'/')+'"');
            offset=match.index+directive[0].length;
        }
        chunks.push(text.slice(offset)); const rewritten=chunks.join('');
        const copy=mapped.get(file); await fs.mkdir(path.dirname(copy),{recursive:true});
        await fs.writeFile(copy,rewritten===text?bytes:rewritten,{flag:'wx'});
    }
    return {root,mapped,reverse,relocate};
}
async function lint(input, {signal,onContext,onArtifacts} = {}) {
    const resolved = await resolveContext(input), {context,options} = resolved;
    if (input.expectedRevision && input.expectedRevision!==context.revision) fail('CONTEXT_CHANGED','任务启动前工程或源码已经变化',{},4);
    const target=selectTarget(resolved), tool=await locateIverilog(options);
    const manager=createToolTaskManager({onChange:task=>onArtifacts?.(task.logPaths.map(file=>({kind:'log',path:file})))}), task=manager.start('cli-lint');
    const cancel=()=>task.cancel('CLI请求取消');
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort',cancel,{once:true});
    let response;
    try {
        const base=await directory(options.workspace,'runs');
        const runDirectory=await task.directory(base,'lint');
        const snapshot=await snapshotInputs(resolved,runDirectory);
        await assertCurrent(resolved); await onContext?.(identity(context)); task.throwIfCancelled();
        const version=await probeTool(tool,task,options);
        const includeDirs=[...new Set([...context.includeDirs,...context.files.map(file=>path.dirname(file.path))])];
        const common=iverilog.buildCommonArgs({fileName:target.file,standard:context.standard,
            includePaths:includeDirs.map(snapshot.relocate),libraryPaths:[],extraArgs:['-t','null','-s',target.name,...context.defines.flatMap(value=>['-D',value])]});
        const definitions=new Map();
        for (const unit of context.units) {
            const list=definitions.get(unit.name) || []; list.push(unit.file); definitions.set(unit.name,list);
        }
        const modules=new Map([...definitions].filter(([,files])=>new Set(files).size===1).map(([name,files])=>[name,snapshot.mapped.get(files[0])]));
        const mapLine=line=>line.replace(/^(.+?)(:\d+:)/,(all,file,suffix)=>(snapshot.reverse.get(keyOf(file)) || file)+suffix);
        // package先于引用文件；其余模块仅在实际缺失时补入，避免编译无关设计单元。
        const inputs=[...new Set([...context.units.filter(unit=>unit.kind==='package').map(unit=>unit.file),target.file])].map(file=>snapshot.mapped.get(file));
        const compiled=await iverilog.compileWithModuleResolution(tool,common,inputs,snapshot.root,{task,timeoutMs:options.timeoutMs,
            mapLine,scanSources:async()=>({modules})});
        task.throwIfCancelled(); await assertCurrent(resolved);
        const summary=summarizeToolResult({result:compiled.result,findings:compiled.result.findings,mainFile:target.file,diagnosticsIncomplete:compiled.result.diagnosticsIncomplete});
        response=result('lint',{...summary,runId:task.id,tool:version,top:target.name,files:compiled.files.map(file=>snapshot.reverse.get(keyOf(file))),
            diagnosticsIncomplete:compiled.result.diagnosticsIncomplete,limitations:context.limitations},context,compiled.result.findings,
        task.logPaths.map(file=>({kind:'log',path:file})).concat([{kind:'manifest',path:path.join(runDirectory,'manifest.json')} ]));
        response.status=summary.status;
        await writeJson(path.join(runDirectory,'manifest.json'),{runId:task.id,context:identity(context),tool:version,arguments:common,files:context.files,result:response.status});
    } catch(error) {
        error.details={...error.details,runId:task.id,context:identity(context),artifacts:task.logPaths.map(file=>({kind:'log',path:file}))};
        if (task.signal.aborted) { error.code='TOOL_CANCELLED'; error.exitCode=3; }
        throw error;
    } finally {
        signal?.removeEventListener('abort',cancel); await task.finish({keepArtifacts:true}); await manager.dispose();
    }
    return response;
}
module.exports={doctor,projects,inspect,format,lint,capabilities};
