'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readOptions, resolveContext, listProjects, assertCurrent, page, hash } = require('./context');
const { snapshotInputs } = require('./source-snapshot');
const { keyOf } = require('../project/model');
const { result, fail, identity, ServiceError } = require('./protocol');
const { directory, writeJson } = require('./storage');
const { createNativeLoader } = require('../native-loader');
const { buildFormatOptions } = require('../configuration');
const { preservesCharacters } = require('../editor/format-safety');
const iverilog = require('../toolchains/iverilog');
const { runProcess } = require('../toolchains/process');
const { createToolTaskManager } = require('../toolchains/job');
const { summarizeToolResult, processSucceeded } = require('../toolchains/result');
const { acquireWorkspaceLease } = require('../toolchains/workspace-lease');
const { buildArchitecture } = require('../design/arch');
const { layoutArchitecture, renderArchitectureSvg, defaultFileName, normalizeStyle } = require('../design/svg');
const { validateSpec, generateScaffold } = require('../design/scaffold');
const { createContainedDirectories, cleanupDirectories } = require('../design/scaffold-paths');
const { diffArchitectures } = require('../design/diff');
const { rasterizeSvg, DEFAULT_SCALE } = require('../graphics/rasterize');
const { generateReportMarkdown } = require('../design/report');
const wave = require('./wave');

const capabilities = ['doctor','project.list','project.inspect','project.create','project.add','project.set-top','format.preview','format.check','format.write','lint','vivado.status','vivado.report','vivado.run','task.start','task.list','task.status','task.logs','task.cancel','design.arch','design.scaffold','design.render','design.check','design.diff','design.report','wave.signals','wave.values','wave.changes','wave.edges','wave.sample','wave.diff','wave.export'];
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
/** 未解析的include在诊断中还原为源码中的原始名称，不暴露本轮快照目录。 */
function scrubMissingIncludes(findings, snapshot) {
    const pairs=[];
    for (const [target,name] of snapshot.unresolved) {
        pairs.push([target,name],[target.replace(/\\/g,'/'),name],[path.relative(snapshot.root,target).replace(/\\/g,'/'),name]);
    }
    pairs.sort((a,b)=>b[0].length-a[0].length);
    for (const finding of findings) {
        if (!finding.message) continue;
        let message=finding.message;
        for (const [pattern,replacement] of pairs) message=message.split(pattern).join(replacement);
        finding.message=message;
    }
}
/** 用内置Yosys链接空模块并投影顶层架构；可选落盘供后续比较。 */
async function arch(input) {
    if (!input.top) fail('INVALID_ARGUMENT','design arch需要--top');
    const resolved = await resolveContext(input);
    const { options, context, contents } = resolved;
    const files = [...contents].map(([file, value]) => ({ path: file, text: value.text }));
    const data = await buildArchitecture({ workspace: options.workspace, files, top: input.top, includeDirs: context.includeDirs,
        defines: context.defines, depth: input.depth ?? 1, timeoutMs: options.timeoutMs, contextRevision: context.revision });
    await assertCurrent(resolved);
    let snapshot;
    if (input.save !== undefined) {
        if (typeof input.save !== 'string' || !/^[\w.-]+$/.test(input.save)) fail('INVALID_ARGUMENT','--save名称只能包含字母、数字、下划线、点和短横线');
        const directoryPath = await directory(options.workspace,'design'), file = path.join(directoryPath,input.save + '.json');
        await writeJson(file,data);
        snapshot = { name: input.save, path: file, sha256: data.archSha256 };
    }
    return result('design.arch',{ ...data, ...(snapshot ? { snapshot } : {}) },context);
}
/** 结构检查：把架构数据中的 checks 提升为诊断；有 error 级问题时命令结论为 failed（退出码 1）。 */
async function check(input) {
    if (!input.top) fail('INVALID_ARGUMENT','design check需要--top');
    const resolved = await resolveContext(input);
    const { options, context, contents } = resolved;
    const files = [...contents].map(([file, value]) => ({ path: file, text: value.text }));
    const data = await buildArchitecture({ workspace: options.workspace, files, top: input.top, includeDirs: context.includeDirs,
        defines: context.defines, depth: input.depth ?? 1, timeoutMs: options.timeoutMs, contextRevision: context.revision });
    await assertCurrent(resolved);
    const errors = data.checks.filter(item => item.severity === 'error');
    const warnings = data.checks.filter(item => item.severity === 'warning');
    const response = result('design.check', {
        status: errors.length ? 'errors' : warnings.length ? 'warnings' : 'clean',
        errorCount: errors.length, warningCount: warnings.length,
        top: data.top, designId: data.designId, archSha256: data.archSha256,
        contextRevision: data.contextRevision, sourceFiles: data.sourceFiles,
        unresolved: data.unresolved, checks: data.checks, limitations: data.limitations
    }, context, data.checks);
    if (errors.length) {
        // 对齐 lint：检查完成但工程存在结构错误时结论为 failed，exitCode 1；仅警告不改变结论。
        response.status = 'failed';
        response.message = '工程存在 ' + errors.length + ' 个结构错误';
    }
    return response;
}
/** @param {string} workspace @param {string} value --baseline 参数（save 名或快照路径）。 @returns {Promise<{data:object,path:string,name:string|null}>} 基线快照。 */
async function readBaseline(workspace, value) {
    if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGUMENT','design diff需要--baseline <save名|快照路径>');
    const trimmed = value.trim();
    const byName = /^[\w.-]+$/.test(trimmed) ? path.join(await directory(workspace, 'design'), trimmed + '.json') : null;
    const candidates = [...new Set([byName, path.resolve(workspace, trimmed)].filter(Boolean))];
    let text = null, file = null;
    for (const candidate of candidates) {
        text = await fs.readFile(candidate, 'utf8').catch(error => error.code === 'ENOENT' ? null : fail('INVALID_ARGUMENT', 'design diff 基线读取失败：' + error.message, { baseline: candidate }));
        if (text !== null) { file = candidate; break; }
    }
    if (text === null) {
        fail('INVALID_ARGUMENT', 'design diff 基线快照不存在：' + candidates[candidates.length - 1] + '；先用 design arch --save <name> 保存', { baseline: candidates[candidates.length - 1] });
    }
    let baseline;
    try {
        baseline = JSON.parse(text);
    } catch (error) {
        fail('INVALID_ARGUMENT', 'design diff 基线不是合法 JSON：' + error.message, { baseline: file });
    }
    if (baseline.schemaVersion !== 1 || baseline.stage !== 'source' || !baseline.graph) {
        fail('INVALID_ARGUMENT', 'design diff 基线不是架构快照（要求 schemaVersion=1 且 stage=source）', { baseline: file });
    }
    return { data: baseline, path: file, name: byName === file ? trimmed : null };
}
/** 比较基线快照与当前架构的结构差异（实例/模块/顶层端口/接口/源文件）。 */
async function diff(input) {
    if (!input.top) fail('INVALID_ARGUMENT','design diff需要--top');
    const baseline = await readBaseline((await readOptions(input)).options.workspace, input.baseline);
    const resolved = await resolveContext(input);
    const { options, context, contents } = resolved;
    if (baseline.data.top && baseline.data.top.name !== input.top) {
        fail('INVALID_ARGUMENT','design diff 基线顶层 ' + baseline.data.top.name + ' 与 --top ' + input.top + ' 不一致，比较无意义', { baselineTop: baseline.data.top.name });
    }
    const files = [...contents].map(([file, value]) => ({ path: file, text: value.text }));
    const current = await buildArchitecture({ workspace: options.workspace, files, top: input.top, includeDirs: context.includeDirs,
        defines: context.defines, depth: input.depth ?? 1, timeoutMs: options.timeoutMs, contextRevision: context.revision });
    await assertCurrent(resolved);
    const differences = diffArchitectures(baseline.data, current);
    const changed = Object.values(differences.summary).some(count => count > 0);
    return result('design.diff', {
        status: changed ? 'changed' : 'unchanged', top: current.top, designId: current.designId, archSha256: current.archSha256,
        baseline: { name: baseline.name, path: path.relative(options.workspace, baseline.path).split(path.sep).join('/'),
            top: baseline.data.top ? baseline.data.top.name : null, archSha256: baseline.data.archSha256 || null },
        diff: differences
    }, context);
}
/** @param {string[]} [values] --bundle-name 参数。 @returns {Record<string,string>} 前缀→显示名映射。 */
function parseBundleNames(values = []) {
    const names = {};
    for (const value of values) {
        const match = /^([A-Za-z0-9_.-]+)=([^=\r\n]+)$/.exec(String(value));
        if (!match) fail('INVALID_ARGUMENT','--bundle-name需要 <prefix=display> 形式');
        names[match[1]] = match[2].trim();
    }
    return names;
}
/** @param {string} workspace @param {string} value 规格路径或内联 JSON。 @returns {Promise<{text:string,source:string|null}>} 规格文本。 */
async function readSpec(workspace, value) {
    if (typeof value === 'string' && value.trimStart().startsWith('{')) {
        return { text: value, source: null };
    }
    const candidate = path.resolve(workspace, value);
    try {
        return { text: await fs.readFile(candidate, 'utf8'), source: candidate };
    } catch (error) {
        if (error.code !== 'ENOENT') fail('INVALID_ARGUMENT', 'design scaffold 规格读取失败：' + error.message);
        // 路径不存在时直接说明，不回退把路径当 JSON 解析而报"不是合法 JSON"误导排障方向。
        fail('INVALID_ARGUMENT', 'design scaffold 规格文件不存在：' + candidate + '；内联 JSON 规格需以 { 开头');
    }
}
/** 按 schemaVersion=1 规格生成架构骨架（packed struct 接口 + 空模块 + 顶层连线）。 */
async function scaffold(input) {
    if (!input.spec) fail('INVALID_ARGUMENT', 'design scaffold需要--spec <json|file>');
    const { options } = await readOptions(input);
    const workspace = options.workspace;
    const source = await readSpec(workspace, input.spec);
    let spec;
    try {
        spec = JSON.parse(source.text);
    } catch (error) {
        fail('INVALID_ARGUMENT', 'design scaffold 规格不是合法 JSON：' + error.message);
    }
    const validated = validateSpec(spec);
    const outputDirectory = input.out ? path.resolve(workspace, input.out) : path.join(workspace, 'rtl');
    const relative = path.relative(workspace, outputDirectory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        fail('INVALID_ARGUMENT', 'design scaffold 的 --out 必须位于工作区内');
    }
    const text = generateScaffold(validated);
    const file = path.join(outputDirectory, validated.top.name + '.sv');
    let phase = 'precheck';
    let created = [];
    try {
        // 逐级创建目录，每级 lstat 拒绝链接、realpath 校验仍在工作区内；失败只清理已确认目录。
        const result = await createContainedDirectories(outputDirectory, workspace);
        created = result.created;
        phase = 'target';
        let existing = null;
        try {
            existing = await fs.lstat(file);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (existing) {
            if (existing.isSymbolicLink()) {
                fail('INVALID_ARGUMENT', 'design scaffold 拒绝覆盖符号链接：' + file, { file });
            }
            if (!existing.isFile()) {
                fail('INVALID_ARGUMENT', 'design scaffold 目标路径不是普通文件：' + file, { file });
            }
            if (!input.force) {
                fail('FILE_EXISTS', 'design scaffold 目标文件已存在，使用 --force 覆盖：' + file, { file });
            }
        }
        phase = 'write';
        await fs.writeFile(file, text, { flag: input.force ? 'w' : 'wx' });
    } catch (error) {
        // 包括 ServiceError：本轮创建的目录也必须清理（清理函数自身拒绝沿链接删除）。
        await cleanupDirectories(created, workspace);
        if (error instanceof ServiceError) throw error;
        if (error.code === 'OUTSIDE_WORKSPACE') {
            fail('INVALID_ARGUMENT', 'design scaffold 的 --out 通过符号链接逃逸出工作区', { out: input.out || 'rtl' });
        }
        if (error.code === 'OUT_NOT_DIRECTORY') {
            fail('INVALID_ARGUMENT', 'design scaffold 的 --out 必须是工作区内的目录：' + (input.out || 'rtl'), { out: input.out || 'rtl' });
        }
        if (error.code === 'EEXIST' && phase === 'write') {
            fail('FILE_EXISTS', 'design scaffold 目标文件已存在，使用 --force 覆盖：' + file, { file });
        }
        if (['EEXIST', 'ENOTDIR', 'EISDIR', 'EINVAL'].includes(error.code)) {
            fail('INVALID_ARGUMENT', 'design scaffold 的 --out 必须是工作区内的目录：' + (input.out || 'rtl'), { out: input.out || 'rtl' });
        }
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            fail('DESIGN_FAILED', 'design scaffold 没有写入权限：' + file, { file });
        }
        fail('DESIGN_FAILED', 'design scaffold 写入失败：' + error.message, { file });
    }
    const relativeFile = path.relative(workspace, file).split(path.sep).join('/');
    return result('design.scaffold', {
        workspace, out: relative.split(path.sep).join('/') || '.', file: relativeFile,
        top: validated.top.name,
        suggestions: validated.suggestions,
        interfaces: validated.typedefs.map(item => ({ type: item.type, typedef: item.typedefName, members: item.members })),
        buses: validated.buses, modules: validated.modules, instances: validated.top.instances.length,
        source: source.source ? path.relative(workspace, source.source).split(path.sep).join('/') : null
    }, null, [], [{ kind: 'source', path: file }]);
}
/** 渲染 SVG/PNG 架构图；PNG 用内置 resvg 无宿主栅格化同一份 SVG。 */
async function render(input) {
    if (!input.top) fail('INVALID_ARGUMENT','design render需要--top');
    const format = input.imageFormat || 'svg';
    if (!['svg', 'png'].includes(format)) fail('INVALID_ARGUMENT','不支持的--format：' + format + '（可选 svg|png）');
    const style = normalizeStyle(input.style);
    const detail = input.detail || 'interfaces';
    if (!['interfaces','signals'].includes(detail)) fail('INVALID_ARGUMENT','--detail需要 interfaces|signals');
    const bundle = input.foldPorts === true;
    const bundleNames = parseBundleNames(Array.isArray(input.bundleNames) ? input.bundleNames : []);
    if (!bundle && Object.keys(bundleNames).length) {
        fail('INVALID_ARGUMENT','--bundle-name 需要与 --fold-ports 同时使用');
    }
    const resolved = await resolveContext(input);
    const { options, context, contents } = resolved;
    const files = [...contents].map(([file, value]) => ({ path: file, text: value.text }));
    const arch = await buildArchitecture({ workspace: options.workspace, files, top: input.top, includeDirs: context.includeDirs,
        defines: context.defines, depth: input.depth ?? 1, timeoutMs: options.timeoutMs, contextRevision: context.revision });
    const layoutResult = await layoutArchitecture(arch, { bundle, bundleNames,detail });
    const image = renderArchitectureSvg(arch, layoutResult, { title: typeof input.title === 'string' ? input.title : undefined, style });
    await assertCurrent(resolved);
    const outputDirectory = input.out ? path.resolve(options.workspace, input.out) : await directory(options.workspace,'design','render');
    // 与 design scaffold 同一安全模型：拒绝越界 --out 与 symlink/junction 逃逸，失败清理本轮创建的目录。
    let createdOut = [];
    try {
        createdOut = (await createContainedDirectories(outputDirectory, options.workspace)).created;
    } catch (error) {
        if (error instanceof ServiceError) throw error;
        if (error.code === 'OUTSIDE_WORKSPACE') {
            fail('INVALID_ARGUMENT', 'design render 的 --out 通过符号链接逃逸出工作区', { out: input.out || null });
        }
        if (error.code === 'OUT_NOT_DIRECTORY' || ['EEXIST', 'ENOTDIR', 'EISDIR', 'EINVAL'].includes(error.code)) {
            fail('INVALID_ARGUMENT', 'design render 的 --out 必须是工作区内的目录：' + (input.out || '.svtools/agent/design/render'), { out: input.out || null });
        }
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            fail('DESIGN_FAILED', 'design render 没有输出目录写入权限：' + error.message, { out: input.out || null });
        }
        fail('DESIGN_FAILED', 'design render 创建输出目录失败：' + error.message, { out: input.out || null });
    }
    const file = path.join(outputDirectory,defaultFileName(arch, style, { bundle, bundleNames, title: input.title,detail })
        .replace(/\.svg$/, format === 'png' ? '.png' : '.svg')), temporary = file + '.' + randomUUID() + '.tmp';
    // PNG 用内置 resvg 栅格化同一份 SVG（无编辑器宿主），像素倍率 2 保证报告清晰度。
    const rasterized = format === 'png' ? rasterizeSvg(image.svg, { scale: DEFAULT_SCALE }) : null;
    try {
        await fs.writeFile(temporary, rasterized ? rasterized.png : image.svg, {flag:'wx'});
        await fs.rename(temporary,file);
    } catch (error) {
        await fs.rm(temporary,{force:true});
        await cleanupDirectories(createdOut, options.workspace);
        fail('DESIGN_FAILED','写入架构图失败：' + error.message,{file});
    }
    const artifact = rasterized
        ? { kind:'image', format:'png', path:file, sha256:hash(rasterized.png), bytes:rasterized.png.length,
            width:rasterized.width, height:rasterized.height, sourceSha256:image.sha256, scale:rasterized.scale }
        : { kind:'image', format:'svg', path:file, sha256:image.sha256, bytes:image.bytes, width:image.width, height:image.height };
    return result('design.render',{ format, style, detail, bundled:bundle, bundleNames, path:file, sha256:artifact.sha256, bytes:artifact.bytes,
        width:artifact.width, height:artifact.height, ...(rasterized ? { scale:rasterized.scale, sourceSha256:image.sha256 } : {}),
        title: image.evidence.export.title, stats:image.stats, evidence:image.evidence },context,[],[artifact]);
}
/** 报告图表包：同一架构一次导出 SVG+PNG+architecture.json/md+report.json（C 节证据包）。 */
async function report(input) {
    if (!input.top) fail('INVALID_ARGUMENT','design report需要--top');
    const style = normalizeStyle(input.style);
    const detail = input.detail || 'interfaces';
    if (!['interfaces','signals'].includes(detail)) fail('INVALID_ARGUMENT','--detail需要 interfaces|signals');
    const bundle = input.foldPorts === true;
    const bundleNames = parseBundleNames(Array.isArray(input.bundleNames) ? input.bundleNames : []);
    if (!bundle && Object.keys(bundleNames).length) {
        fail('INVALID_ARGUMENT','--bundle-name 需要与 --fold-ports 同时使用');
    }
    const resolved = await resolveContext(input);
    const { options, context, contents } = resolved;
    const files = [...contents].map(([file, value]) => ({ path: file, text: value.text }));
    const arch = await buildArchitecture({ workspace: options.workspace, files, top: input.top, includeDirs: context.includeDirs,
        defines: context.defines, depth: input.depth ?? 1, timeoutMs: options.timeoutMs, contextRevision: context.revision });
    const layoutResult = await layoutArchitecture(arch, { bundle, bundleNames, detail });
    const title = typeof input.title === 'string' ? input.title : (input.top + ' 架构报告');
    const image = renderArchitectureSvg(arch, layoutResult, { title, style });
    await assertCurrent(resolved);
    const rasterized = rasterizeSvg(image.svg, { scale: DEFAULT_SCALE });
    const outputDirectory = input.out ? path.resolve(options.workspace, input.out) : await directory(options.workspace,'design','report');
    let createdOut = [];
    try {
        createdOut = (await createContainedDirectories(outputDirectory, options.workspace)).created;
    } catch (error) {
        if (error instanceof ServiceError) throw error;
        if (error.code === 'OUTSIDE_WORKSPACE') {
            fail('INVALID_ARGUMENT', 'design report 的 --out 通过符号链接逃逸出工作区', { out: input.out || null });
        }
        if (error.code === 'OUT_NOT_DIRECTORY' || ['EEXIST', 'ENOTDIR', 'EISDIR', 'EINVAL'].includes(error.code)) {
            fail('INVALID_ARGUMENT', 'design report 的 --out 必须是工作区内的目录：' + (input.out || '.svtools/agent/design/report'), { out: input.out || null });
        }
        fail('DESIGN_FAILED', 'design report 创建输出目录失败：' + error.message, { out: input.out || null });
    }
    const base = defaultFileName(arch, style, { bundle, bundleNames, title: input.title, detail }).replace(/\.svg$/, '');
    const entries = [
        { kind: 'image', name: base + '.svg', bytes: Buffer.from(image.svg, 'utf8') },
        { kind: 'image', name: base + '.png', bytes: rasterized.png },
        { kind: 'source', name: 'architecture.json', bytes: Buffer.from(JSON.stringify(arch, null, 2) + '\n', 'utf8') }
    ];
    const shaOf = entry => ({ ...entry, sha256: hash(entry.bytes) });
    const imageEntries = entries.map(shaOf);
    const svgEntry = imageEntries[0], pngEntry = imageEntries[1];
    const markdown = generateReportMarkdown(arch, { svgFile: svgEntry.name, pngFile: pngEntry.name,
        pngSha256: pngEntry.sha256, scale: rasterized.scale, svgSha256: image.sha256 });
    const outputs = [...imageEntries,
        { kind: 'document', name: 'architecture.md', bytes: Buffer.from(markdown, 'utf8') }].map(shaOf);
    const manifest = { generatedBy: 'svtools design report', top: input.top, style, detail, bundled: bundle, bundleNames,
        scale: rasterized.scale, files: outputs.map(item => ({ kind: item.kind, path: item.name, sha256: item.sha256, bytes: item.bytes.length })),
        evidence: image.evidence, checksSummary: { total: (arch.checks || []).length,
            errors: (arch.checks || []).filter(item => item.severity === 'error').length,
            warnings: (arch.checks || []).filter(item => item.severity === 'warning').length } };
    outputs.push(shaOf({ kind: 'manifest', name: 'report.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') }));
    const written = [];
    try {
        for (const item of outputs) {
            const file = path.join(outputDirectory, item.name), temporary = file + '.' + randomUUID() + '.tmp';
            await fs.writeFile(temporary, item.bytes, { flag: 'wx' });
            await fs.rename(temporary, file);
            written.push({ kind: item.kind, format: item.name.endsWith('.svg') ? 'svg' : item.name.endsWith('.png') ? 'png' : null,
                path: file, sha256: item.sha256, bytes: item.bytes.length,
                ...(item.name.endsWith('.png') ? { width: rasterized.width, height: rasterized.height, scale: rasterized.scale, sourceSha256: image.sha256 } : {}) });
        }
    } catch (error) {
        await cleanupDirectories(createdOut, options.workspace);
        fail('DESIGN_FAILED', 'design report 写入产物失败：' + error.message, { out: input.out || null });
    }
    const errors = (arch.checks || []).filter(item => item.severity === 'error').length;
    const response = result('design.report', { style, detail, bundled: bundle, bundleNames, out: outputDirectory, top: arch.top,
        designId: arch.designId, archSha256: arch.archSha256, checksSummary: manifest.checksSummary,
        files: written.map(item => ({ ...item, path: path.relative(options.workspace, item.path).split(path.sep).join('/') })),
        evidence: { ...image.evidence, png: { sha256: pngEntry.sha256, scale: rasterized.scale,
            width: rasterized.width, height: rasterized.height, sourceSha256: image.sha256 } } }, context, [], written);
    return response;
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
        if(snapshot.unresolved.size) scrubMissingIncludes(compiled.result.findings,snapshot);
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
module.exports={doctor,projects,inspect,format,arch,scaffold,render,check,diff,report,lint,capabilities,
    waveSignals:wave.signals,waveValues:wave.values,waveChanges:wave.changes,waveEdges:wave.edges,waveSample:wave.sample,waveDiff:wave.diff,waveExport:wave.exportImage};
