'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readProjectSnapshot, readConfig, keyOf } = require('../project/model');
const { extractDesignUnits, maskSourceText } = require('../workspace/sources');
const { isExcludedSourcePath } = require('../workspace/source-policy');
const { resolveXprPath } = require('../vivado/xpr');
const { fail } = require('./protocol');
const MAX_FILES = 4096, MAX_FILE_BYTES = 8 * 1024 * 1024, MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const hdl = file => /\.(?:sv|v|svh|vh)$/i.test(file);
const skip = new Set(['.git', '.svtools', '.Xil', 'node_modules', 'target', 'bin']);

async function walk(root, accept, { limit = MAX_FILES, maxDepth = 32 } = {}) {
    const found = []; let visits = 0;
    async function visit(directory, depth) {
        if (depth > maxDepth) fail('SCAN_LIMIT', '目录层级超出预算');
        const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const entry of entries) {
            if (++visits > 50000) fail('SCAN_LIMIT', '目录扫描超过50000项，请缩小工作区');
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink() || isExcludedSourcePath(file)) continue;
            if (entry.isDirectory()) { if (!skip.has(entry.name)) await visit(file, depth + 1); }
            else if (entry.isFile() && accept(file)) {
                found.push(file); if (found.length > limit) fail('SCAN_LIMIT', '文件数量超出预算', { limit });
            }
        }
    }
    await visit(root, 0); return found;
}

async function canonicalWorkspace(input = {}) {
    const workspace = await fs.realpath(path.resolve(input.workspace || process.cwd()));
    if (!(await fs.stat(workspace)).isDirectory()) fail('INVALID_WORKSPACE', '工作区必须为目录');
    return workspace;
}
async function readOptions(input = {}) {
    const workspace=await canonicalWorkspace(input);
    const configPath = path.resolve(workspace, input.config || '.svtools/cli.json');
    let config = {};
    try { config = await readConfig(configPath); }
    catch (error) { if (error.code !== 'ENOENT' || input.config) fail('CONFIG_INVALID', 'CLI配置读取失败：' + error.message); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail('CONFIG_INVALID','CLI配置必须为JSON对象');
    const allowed = new Set(['schemaVersion','project','fileset','top','includeDirs','defines','standard','iverilog','cygwin','vivado','timeoutMs','format','budget']);
    if (Object.keys(config).length && (config.schemaVersion !== 1 || Object.keys(config).some(key => !allowed.has(key)))) fail('CONFIG_INVALID', 'CLI配置要求schemaVersion=1，且不能含未知字段');
    const options = { ...config, ...Object.fromEntries(Object.entries(input).filter(([,value]) => value !== undefined)), workspace };
    for (const field of ['project','fileset','file','top','iverilog','cygwin']) if (options[field] !== undefined && options[field] !== null && (typeof options[field] !== 'string' || !options[field] || options[field].length>4096 || /[\0\r\n]/.test(options[field]))) fail('CONFIG_INVALID', field + '必须为不含控制字符的非空字符串');
    for (const field of ['includeDirs','defines']) if (options[field] !== undefined && (!Array.isArray(options[field]) || options[field].length > MAX_FILES || options[field].some(v => typeof v !== 'string' || /[\0\r\n]/.test(v)))) fail('CONFIG_INVALID', field + '必须为字符串数组');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 3600000)) fail('CONFIG_INVALID', 'timeoutMs要求100至3600000毫秒');
    if (options.budget !== undefined) {
        const keys = { textMiB: 4096, initMiB: 4096, binaryMiB: 16384, cacheMiB: 65536, textFileMiB: 256, initFileMiB: 1024, binaryFileMiB: 16384 };
        if (!options.budget || typeof options.budget !== 'object' || Array.isArray(options.budget)) fail('CONFIG_INVALID', 'budget必须为对象');
        for (const [name, value] of Object.entries(options.budget)) {
            if (!(name in keys) || !Number.isSafeInteger(value) || value < 1 || value > keys[name]) fail('CONFIG_INVALID', '无效预算项：' + name);
        }
    }
    if (options.standard !== undefined && !['auto','default','1995','2001','2005','2005-sv','2009','2012'].includes(options.standard)) fail('CONFIG_INVALID','不支持的语言标准');
    if (options.format !== undefined) {
        const names = ['tabSize','indentStyle','useTab','maxConsecutiveEmptyLines','stripEmptyLine','ignoreTick','oneDeclPerLine','oneBindPerLine','alignComma','paramOneLine','importSameLine','instAlignPort','inlineCompact','blankCompact','portNameGap'];
        const sections = require('../../package.json').contributes.configuration;
        const properties = Object.assign({}, ...[sections].flat().map(section => section.properties));
        if (!options.format || Array.isArray(options.format) || typeof options.format !== 'object') fail('CONFIG_INVALID','format必须为配置对象');
        for (const [name,value] of Object.entries(options.format)) {
            const property = properties['svtools.'+name];
            if (!names.includes(name) || !property || typeof value !== typeof property.default || (property.enum && !property.enum.includes(value))
                || (typeof value === 'number' && (!Number.isSafeInteger(value) || value < (property.minimum ?? (name==='tabSize'?1:0)) || value > (property.maximum ?? 64)))) fail('CONFIG_INVALID','无效格式化选项：'+name);
        }
    }
    return { options, configPath, configHash: hash(JSON.stringify(config)) };
}

async function listProjects(workspace) {
    const candidates = (await walk(workspace, file => /\.xpr$/i.test(file))).map(file => ({ kind: 'vivado', path: file }));
    const directory = path.join(workspace, '.svtools', 'projects');
    try { for (const name of (await fs.readdir(directory)).sort()) if (/\.json$/i.test(name)) candidates.push({ kind: 'svtools', path: path.join(directory,name) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if(candidates.length>MAX_FILES) fail('SCAN_LIMIT','工程候选数量超出4096项');
    return candidates;
}

async function resolveContext(input = {}) {
    const { options, configPath, configHash } = await readOptions(input), { workspace } = options;
    // 文本类预算由配置驱动（默认沿用64MiB/8MiB）；二进制输入使用独立预算，见 vivado-inputs。
    const budgetBlock = options.budget || {};
    const fileCap = (Number.isSafeInteger(budgetBlock.textFileMiB) ? budgetBlock.textFileMiB : 8) * 1024 * 1024;
    const totalCap = (Number.isSafeInteger(budgetBlock.textMiB) ? budgetBlock.textMiB : 64) * 1024 * 1024;
    let project;
    if (options.project) project = { kind: /\.xpr$/i.test(options.project) ? 'vivado' : 'svtools', path: path.resolve(workspace, options.project) };
    else {
        const candidates = await listProjects(workspace);
        if (candidates.length > 1) fail('AMBIGUOUS_PROJECT', '工作区存在多个工程，请显式指定--project', { candidates });
        project = candidates[0];
    }
    const snapshot = project ? await readProjectSnapshot(project, { workspaceRoot: workspace, withDocument:true }) : null;
    const sets = snapshot?.sets.filter(set => ['DesignSrcs','SimulationSrcs'].includes(set.type)) || [];
    let selected;
    if (sets.length) {
        const choices = options.fileset ? sets.filter(set => set.name === options.fileset) : sets.filter(set => set.type === 'DesignSrcs');
        if (choices.length !== 1) fail('AMBIGUOUS_FILESET', '请显式选择一个文件集', { candidates: sets.map(({name,type,top}) => ({name,type,top})) });
        selected = choices[0];
    } else if (options.fileset && options.fileset !== 'workspace') fail('FILESET_NOT_FOUND', '工作区模式没有所选文件集');
    const designSets=sets.filter(set=>set.type==='DesignSrcs');
    if(selected?.type==='SimulationSrcs' && designSets.length>1) fail('AMBIGUOUS_SOURCESET','仿真文件集关联了多个候选设计文件集，M1要求唯一设计文件集',{candidates:designSets.map(set=>set.name)});
    const selectedSets=selected ? selected.type==='DesignSrcs'?[selected]:[...designSets,selected] : [];
    const memberMap=new Map(selectedSets.flatMap(set=>set.files).filter(hdl).map(file=>[keyOf(file),file]));
    const members=selected ? [...memberMap.values()] : await walk(workspace,hdl);
    const selectedNames=new Set(selectedSets.map(set=>set.name));
    const projectOptions=(snapshot?.document?.elements || []).filter(element=>!element.closing && element.parents.some(parent=>parent.name==='FileSet' && selectedNames.has(parent.attrs.Name)));
    const projectDirs=projectOptions.filter(element=>element.name==='Option' && element.attrs.Name==='VerilogDir').map(element=>resolveXprPath(element.attrs.Val,path.dirname(snapshot.path),path.basename(snapshot.path,'.xpr')));
    const projectDefines=projectOptions.filter(element=>element.name==='Define').map(element=>element.attrs.Name+(element.attrs.Val?'='+element.attrs.Val:''));
    const includeDirs = [...new Set([...(snapshot?.includeDirs || []), ...projectDirs, ...(options.includeDirs || []).map(dir => path.resolve(workspace,dir))])];
    // 约束文件同样决定"这一轮结果是否还有效"：变更XDC必须改变revision。
    const constraintPaths=[...new Set((snapshot?.sets || []).filter(set=>set.type==='Constrs').flatMap(set=>set.files).map(file=>path.resolve(file)))];
    const constraints=[], auxiliaryContents=new Map();let constraintBytes=0;
    for (const file of constraintPaths) {
        const handle=await fs.open(file,'r');
        try {
            const stat=await handle.stat();constraintBytes+=stat.size;
            if(!stat.isFile() || stat.size>fileCap || constraintBytes>totalCap) fail('SOURCE_LIMIT','约束快照超过安全预算',{file,size:stat.size,limit:fileCap});
            const buffer=Buffer.alloc(stat.size+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
            if(bytesRead!==stat.size) fail('SOURCE_CHANGED','读取期间约束发生变化',{file});
            const bytes=buffer.subarray(0,bytesRead);constraints.push({path:file,sha256:hash(bytes)});auxiliaryContents.set(file,{bytes,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)});
        } finally {await handle.close();}
    }
    const files = new Set(members.map(file => path.resolve(file)));
    for (const directory of includeDirs) for (const file of await walk(directory, file => hdl(file) || /\.(?:inc|h)$/i.test(file))) files.add(file);
    if (files.size+constraints.length > MAX_FILES) fail('SOURCE_LIMIT', '源码和include/约束文件超过4096项');
    const contents = new Map(), entries = new Array(files.size), units = []; let totalBytes = constraintBytes, next = 0;
    const ordered = [...files];
    await Promise.all(Array.from({length: Math.min(8,ordered.length)}, async () => {
        while (next < ordered.length) {
            const index = next++, file = ordered[index], handle = await fs.open(file,'r');
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > fileCap) fail('SOURCE_LIMIT', '源码超出单文件预算', {file,size:stat.size,limit:fileCap});
                totalBytes += stat.size; if (totalBytes > totalCap) fail('SOURCE_LIMIT','源码快照超出总预算',{used:totalBytes,limit:totalCap});
                const buffer = Buffer.alloc(stat.size+1), {bytesRead} = await handle.read(buffer,0,buffer.length,0);
                if (bytesRead !== stat.size) fail('SOURCE_CHANGED','读取期间源码变化',{file});
                const bytes = buffer.subarray(0,bytesRead);
                const text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
                contents.set(file,{bytes,text}); entries[index] = {path:file,bytes:bytes.length,sha256:hash(bytes)};
            } finally { await handle.close(); }
        }
    }));
    // Vivado允许不显式加入工程的字面量include；这些依赖也必须参与身份和隔离输入。
    const known=new Set([...contents.keys()].map(keyOf)), queue=[...contents.keys()];
    for(let cursor=0;cursor<queue.length;cursor++) {
        const parent=queue[cursor],text=contents.get(parent).text,masked=maskSourceText(text);
        for(const match of masked.matchAll(/`include\b/g)) {
            const directive=/^`include[ \t]+"([^"\r\n]+)"/.exec(text.slice(match.index));if(!directive) continue;
            const name=directive[1],candidates=path.isAbsolute(name)?[name]:[path.resolve(path.dirname(parent),name),...includeDirs.map(dir=>path.resolve(dir,name))];
            let file;
            for(const candidate of candidates) if((await fs.stat(candidate).catch(error=>{if(error.code!=='ENOENT') throw error;}))?.isFile()) {file=candidate;break;}
            if(!file || known.has(keyOf(file))) continue;
            if(contents.size+constraints.length>=MAX_FILES) fail('SOURCE_LIMIT','include依赖超过4096项');
            const handle=await fs.open(file,'r');
            try {
                const stat=await handle.stat();totalBytes+=stat.size;
                if(stat.size>fileCap || totalBytes>totalCap) fail('SOURCE_LIMIT','include依赖超过源码预算',{file,limit:fileCap});
                const buffer=Buffer.alloc(stat.size+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
                if(bytesRead!==stat.size) fail('SOURCE_CHANGED','读取include期间文件变化',{file});
                const bytes=buffer.subarray(0,bytesRead),value={bytes,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};
                contents.set(file,value);entries.push({path:file,bytes:bytes.length,sha256:hash(bytes)});known.add(keyOf(file));queue.push(file);
            } finally {await handle.close();}
        }
    }
    for (const file of members) {
        const text = contents.get(path.resolve(file)).text, code = maskSourceText(text); let line = 1, offset = 0;
        for (const unit of extractDesignUnits(text)) {
            line += (text.slice(offset,unit.start).match(/\n/g)||[]).length; offset = unit.start;
            units.push({name:unit.name,kind:code.slice(unit.start,unit.end).trimStart().match(/^\w+/)?.[0],file:path.resolve(file),line});
        }
    }
    const file = options.file ? path.resolve(workspace, options.file) : null;
    if (file && !members.some(member => keyOf(member) === keyOf(file))) fail('FILE_NOT_IN_CONTEXT','目标文件不在当前工程/文件集中',{file});
    const top = options.top || selected?.top || null;
    const context = { id: hash(JSON.stringify([workspace,project?.path || null,selected?.name || 'workspace'])),
        workspace, project: snapshot ? {kind:snapshot.kind,path:snapshot.path,name:snapshot.name} : null,
        fileset:selected?.name || 'workspace', top, files:entries, constraints, units, includeDirs,
        defines:[...(snapshot?.defines || []),...projectDefines,...(options.defines || [])], standard:options.standard || 'auto',
        limitations:['设计单元清单为静态声明索引，宏与生成分支的有效性由实际编译器判断。',
            ...(project?.kind==='vivado'?['M1从XPR提取文件集与top；宏和include目录须通过CLI配置提供，暂不还原Vivado完整编译环境。']:[])] };
    context.revision = hash(JSON.stringify([context, snapshot?.key, configHash]));
    return {context,contents,auxiliaryContents,project:snapshot,options:{...options,file},configPath};
}
async function assertCurrent(resolved) {
    const next = await resolveContext(resolved.options);
    if (next.context.revision !== resolved.context.revision) fail('CONTEXT_CHANGED','工程或源码已变化，本轮结果失效',{},4);
}
function page(items, offset = 0, limit = 100) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('INVALID_ARGUMENT','分页要求offset>=0，limit在1至200之间');
    return {items:items.slice(offset,offset+limit),total:items.length,offset,limit,nextOffset:offset+limit<items.length?offset+limit:null};
}
module.exports = { resolveContext, readOptions, canonicalWorkspace, listProjects, assertCurrent, page, hash, walk };
