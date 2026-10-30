'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createWorkspaceSourceIndex } = require('../src/workspace/sources');

test('工具快照和依赖目录被明确排除，防止重复设计单元污染索引', async () => {
    const calls = [];
    const index = createWorkspaceSourceIndex({ workspace: { workspaceFolders: [{}],
        getConfiguration: () => ({ get: () => true }),
        findFiles: async (pattern, exclude) => { calls.push({ pattern, exclude }); return []; }
    } });
    await index.scan();
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.exclude === '**/{.git,node_modules,.svtools,.Xil}/**'));
});

/** 以内存源码模拟多根工作区；扫描、读文件和时钟均由外部边界注入。 */
function workspaceHarness(sources, { enabled = true, folders = [{ uri: { fsPath: __dirname } }] } = {}) {
    const searches = [];
    const snapshots = new Map(), versions = new Map();
    let timestamp = 100;
    const workspace = {
        workspaceFolders: folders,
        getConfiguration: namespace => {
            assert.equal(namespace, 'svtools.iverilog');
            return { get: (name, fallback) => name === 'scanWorkspace' ? enabled : fallback };
        },
        findFiles: async pattern => {
            searches.push(pattern);
            const extension = pattern.slice(pattern.lastIndexOf('.'));
            return [...sources.keys()].filter(file => file.endsWith(extension)).map(fsPath => ({ fsPath }));
        }
    };
    const index = createWorkspaceSourceIndex({ workspace, readFile: async file => sources.get(file), now: () => timestamp,
        stat: async file => {
            const text = sources.get(file);
            if (snapshots.get(file) !== text) { snapshots.set(file, text); versions.set(file, (versions.get(file) || 0) + 1); }
            return { size: text.length, mtimeMs: versions.get(file) };
        } });
    return { index, searches, advance: milliseconds => { timestamp += milliseconds; } };
}

test('源码索引按实际设计单元名收集 module/interface/package/program', async () => {
    const sourcePath = path.join(__dirname, 'fixtures', 'not_the_module_name.sv');
    const legacyPath = path.join(__dirname, 'fixtures', 'legacy.v');
    const sources = new Map([
        [sourcePath, 'module alpha;\nendmodule\ninterface bus;\nendinterface\npackage defs;\nendpackage\nprogram boot;\nendprogram\n'],
        [legacyPath, 'macromodule legacy;\nendmodule\nmodule alpha;\nendmodule\n']
    ]);
    const { index } = workspaceHarness(sources);
    const result = await index.scan();
    assert.deepEqual([...result.modules.keys()], ['alpha', 'bus', 'defs', 'boot', 'legacy']);
    assert.equal(result.modules.get('alpha'), sourcePath);
    assert.equal(result.modules.get('legacy'), legacyPath);
    assert.deepEqual(result.dirs, [path.dirname(sourcePath)]);
});

test('源码缓存复用结果，force/invalidate/TTL 到期可刷新', async () => {
    const sourcePath = path.join(__dirname, 'fixtures', 'changes.sv');
    const sources = new Map([[sourcePath, 'module first;\nendmodule\n']]);
    const harness = workspaceHarness(sources);
    assert.equal((await harness.index.scan()).modules.has('first'), true);
    const firstSearchCount = harness.searches.length;
    sources.set(sourcePath, 'module second;\nendmodule\n');
    assert.equal((await harness.index.scan()).modules.has('first'), true);
    assert.equal(harness.searches.length, firstSearchCount);
    assert.equal((await harness.index.scan(true)).modules.has('second'), true);
    sources.set(sourcePath, 'module third;\nendmodule\n');
    harness.index.invalidate();
    assert.equal((await harness.index.scan()).modules.has('third'), true);
    sources.set(sourcePath, 'module fourth;\nendmodule\n');
    harness.advance(10001);
    assert.equal((await harness.index.scan()).modules.has('fourth'), true);
});

for (const settings of [{ enabled: false }, { folders: [] }]) {
    test(`源码索引在${settings.enabled === false ? '禁用时' : '空工作区'}不查文件`, async () => {
        const harness = workspaceHarness(new Map(), settings);
        const result = await harness.index.scan();
        assert.deepEqual(result.dirs, []);
        assert.equal(result.modules.size, 0);
        assert.equal(harness.searches.length, 0);
    });
}

test('单个文件或 glob 失败时保留其他结果，并报告具体上下文', async () => {
    const errors = [];
    const brokenPath = path.join(__dirname, 'fixtures', 'broken.v');
    const validPath = path.join(__dirname, 'fixtures', 'valid.v');
    const includePath = path.join(__dirname, 'fixtures', 'defs.svh');
    const workspace = {
        workspaceFolders: [{ uri: { fsPath: __dirname } }],
        getConfiguration: () => ({ get: () => true }),
        findFiles: async pattern => {
            if (pattern === '**/*.sv') throw new Error('pattern denied');
            if (pattern === '**/*.v') return [{ fsPath: brokenPath }, { fsPath: validPath }];
            if (pattern === '**/*.svh') return [{ fsPath: includePath }];
            return [];
        }
    };
    const index = createWorkspaceSourceIndex({ workspace, onError: message => errors.push(message),
        stat: async () => ({ size: 10, mtimeMs: 1 }),
        readFile: async file => {
            if (file === brokenPath) throw new Error('file denied');
            return file === validPath ? 'module still_present;\nendmodule\n' : 'package included;\nendpackage\n';
        } });
    const result = await index.scan();
    assert.equal(result.modules.get('still_present'), validPath);
    assert.equal(result.modules.get('included'), includePath);
    assert.equal(errors.length, 2);
    assert.ok(errors.some(message => message.includes('**/*.sv') && message.includes('pattern denied')));
    assert.ok(errors.some(message => message.includes(brokenPath) && message.includes('file denied')));
});

const { extractDesignUnitNames } = require('../src/workspace/sources');

const mixedDeclarations = String.raw`
/*
module phantomBlock;
*/
// module phantomLine;
string banner = "prefix \
module phantomString; \
";
module automatic timed;
interface static bus;
program automatic runner;
package automatic lifetime_pkg;
module
wrapped;
`;

test('设计单元扫描跳过注释和字符串，支持 lifetime 与名称换行', () => {
    assert.deepEqual(extractDesignUnitNames(mixedDeclarations), ['timed', 'bus', 'runner', 'lifetime_pkg', 'wrapped']);
});

test('完整源码索引不把注释或字符串中的假声明作为依赖', async () => {
    const sourcePath = path.join(__dirname, 'fixtures', 'mixed.sv');
    const { index } = workspaceHarness(new Map([[sourcePath, mixedDeclarations]]));
    const result = await index.scan();
    assert.deepEqual([...result.modules.keys()], ['timed', 'bus', 'runner', 'lifetime_pkg', 'wrapped']);
    assert.equal(result.modules.get('timed'), sourcePath);
    assert.equal(result.modules.has('automatic'), false);
    assert.equal(result.modules.has('phantomBlock'), false);
    assert.equal(result.modules.has('phantomString'), false);
});


test('共享排除策略按完整目录段匹配，兼容Windows大小写及两种分隔符', () => {
    const { isExcludedSourcePath, isGeneratedSourcePath } = require('../src/workspace/source-policy');
    assert.equal(isGeneratedSourcePath('D:/core/.svtools/tasks/top.sv'), true);
    assert.equal(isGeneratedSourcePath('/core/node_modules/sv-lib/real.sv'), false);
    assert.equal(isGeneratedSourcePath('/core/.git/work/top.sv'), false);
    for (const file of ['D:/core/.svtools/circuit/yosys/sources.sv', 'd:\\core\\.SVTOOLS\\tasks\\snapshot.sv',
        '/core/node_modules/pkg/top.sv', '/core/.git/work/top.v', '/core/.Xil/task/top.sv']) assert.equal(isExcludedSourcePath(file), true, file);
    for (const file of ['/core/rtl/top.sv', '/core/rtl/.svtools_impl.sv', '/core/my_node_modules/top.sv',
        '/core/.svtools/../rtl/top.sv']) assert.equal(isExcludedSourcePath(file), false, file);
});
test('工作区扫描对返回结果再次过滤，生成文件不读取、不进入设计单元索引', async () => {
    const normal = path.join(__dirname, 'rtl', 'top.sv'), internal = path.join(__dirname, '.svtools', 'circuit', 'sources.sv');
    const reads = [];
    const index = createWorkspaceSourceIndex({ workspace: { workspaceFolders: [{}],
        getConfiguration: () => ({ get: () => true }), findFiles: async () => [{ fsPath: internal }, { fsPath: normal }] },
        stat: async () => ({ size: 10, mtimeMs: 1 }),
        readFile: async file => { reads.push(file); return file === internal ? 'module wrong; endmodule' : 'module top; endmodule'; } });
    const result = await index.scan();
    assert.equal(result.modules.has('wrong'), false); assert.equal(result.modules.get('top'), normal);
    assert.ok(reads.every(file => file === normal));
});

test('共享清单下两个并发冷扫描只读取3000个文件一次，暖缓存不再读取', async () => {
    const { createSourceCatalog } = require('../src/workspace/source-catalog');
    let searches = 0, reads = 0;
    const uris = Array.from({ length: 3000 }, (_, i) => ({ fsPath: path.join(__dirname, 'virtual', 'u' + i + '.sv') }));
    const workspace = { workspaceFolders: [{}], getConfiguration: () => ({ get: () => true }),
        findFiles: async () => { searches++; await new Promise(resolve => setImmediate(resolve)); return uris; } };
    const catalog = createSourceCatalog({ vscode: { workspace } });
    const index = createWorkspaceSourceIndex({ workspace, sourceCatalog: catalog,
        stat: async () => ({ size: 20, mtimeMs: 1 }),
        readFile: async file => { reads++; return 'module ' + path.basename(file, '.sv') + '; endmodule'; } });
    const [a, b] = await Promise.all([index.scan(), index.scan()]);
    assert.equal(searches, 1); assert.equal(reads, 3000); assert.equal(a, b); assert.equal(a.modules.size, 3000);
    await index.scan(); assert.equal(reads, 3000); catalog.dispose();
});

test('TTL和上下文失效复用未改动文件，仅重读发生变化的源码', async () => {
    const files = [path.join(__dirname, 'incremental-a.sv'), path.join(__dirname, 'incremental-b.sv')];
    const texts = new Map([[files[0], 'module alpha; endmodule'], [files[1], 'module beta; endmodule']]);
    const versions = new Map(files.map(file => [file, 1]));
    let now = 0, reads = 0;
    const index = createWorkspaceSourceIndex({ now: () => now,
        workspace: { workspaceFolders: [{}], getConfiguration: () => ({ get: () => true }),
            findFiles: async pattern => pattern === '**/*.sv' ? files.map(fsPath => ({ fsPath })) : [] },
        stat: async file => ({ size: texts.get(file).length, mtimeMs: versions.get(file) }),
        readFile: async file => { reads++; return texts.get(file); } });
    await index.scan(); assert.equal(reads, 2);
    now += 10001; await index.scan(); assert.equal(reads, 2);
    index.invalidate(); await index.scan(); assert.equal(reads, 2);
    versions.set(files[0], 2); texts.set(files[0], 'module gamma; endmodule');
    index.invalidate({ uri: { fsPath: files[0] } });
    const result = await index.scan(); assert.equal(reads, 3); assert.deepEqual([...result.modules.keys()], ['gamma', 'beta']);
});

test('有界异步读取按发现顺序解决重名，I/O完成顺序不改变优先级', async () => {
    const files = Array.from({ length: 32 }, (_, i) => path.join(__dirname, 'bounded-' + i + '.sv'));
    let active = 0, peak = 0;
    const index = createWorkspaceSourceIndex({ sourceCatalog: { discover: async () => ({ uris: files.map(fsPath => ({ fsPath })) }) },
        workspace: { workspaceFolders: [{}], getConfiguration: () => ({ get: () => true }) },
        stat: async () => ({ size: 20, mtimeMs: 1 }),
        readFile: async file => {
            peak = Math.max(peak, ++active);
            await new Promise(resolve => setTimeout(resolve, file === files[0] ? 30 : 1)); active--;
            return 'module shared; endmodule';
        } });
    const result = await index.scan();
    assert.equal(result.modules.get('shared'), files[0]); assert.ok(peak > 1 && peak <= 8);
});

test('扫描期间失效不会复活旧缓存，等待者获取新代次结果', async () => {
    let release, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const oldFile = path.join(__dirname, 'old.sv'), newFile = path.join(__dirname, 'new.sv');
    const index = createWorkspaceSourceIndex({ workspace: { workspaceFolders: [{}], getConfiguration: () => ({ get: () => true }) },
        sourceCatalog: { async discover() { calls++; return calls === 1 ? gate : { uris: [{ fsPath: newFile }] }; } },
        stat: async () => ({ size: 20, mtimeMs: 1 }), readFile: async file => 'module ' + path.basename(file, '.sv') + '; endmodule' });
    const pending = index.scan(); index.invalidate(); release({ uris: [{ fsPath: oldFile }] });
    const result = await pending;
    assert.deepEqual([...result.modules.keys()], ['new']); assert.equal((await index.scan()), result); assert.equal(calls, 2);
});

test('保存及切换编辑器的连续失效收敛后，扫描仍返回稳定的新代次', async () => {
    let calls = 0;
    const file = path.join(__dirname, 'burst.sv');
    const index = createWorkspaceSourceIndex({ workspace: { workspaceFolders: [{}], getConfiguration: () => ({ get: () => true }) },
        sourceCatalog: { async discover() {
            if (++calls <= 2) index.invalidate();
            return { uris: [{ fsPath: file }] };
        } }, stat: async () => ({ size: 20, mtimeMs: 1 }), readFile: async () => 'module settled; endmodule' });
    const a = await index.scan();
    assert.equal(a.modules.get('settled'), file);
    assert.equal(calls, 3); assert.equal(await index.scan(), a);
});

test('失效中的并发扫描共享重试链，旧代次读取结束前不叠加新一轮I/O', async () => {
    let release, reads = 0, discovers = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const file = path.join(__dirname, 'shared-retry.sv');
    const index = createWorkspaceSourceIndex({ workspace: { workspaceFolders: [{}], getConfiguration: () => ({ get: () => true }) },
        sourceCatalog: { async discover() { discovers++; return { uris: [{ fsPath: file }] }; } },
        stat: async () => ({ size: 20, mtimeMs: 1 }), readFile: async () => {
            if (++reads === 1) await gate;
            return 'module settled; endmodule';
        } });
    const first = index.scan();
    while (!reads) await new Promise(resolve => setImmediate(resolve));
    index.invalidate(); const second = index.scan();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1); assert.equal(discovers, 1);
    release(); const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b); assert.equal(a.modules.get('settled'), file); assert.equal(reads, 2);
});

test('持续失效的扫描有重试上限，失败后可以重新获取稳定结果', async () => {
    let calls = 0, changing = true;
    const file = path.join(__dirname, 'continuous.sv');
    const index = createWorkspaceSourceIndex({ workspace: { workspaceFolders: [{}], getConfiguration: () => ({ get: () => true }) },
        sourceCatalog: { async discover() {
            calls++; if (changing) index.invalidate();
            return { uris: [{ fsPath: file }] };
        } }, stat: async () => ({ size: 20, mtimeMs: 1 }), readFile: async () => 'module settled; endmodule' });
    await assert.rejects(index.scan(), /持续变化/); assert.equal(calls, 4);
    changing = false; assert.equal((await index.scan()).modules.get('settled'), file);
});

test('并发强制刷新共享一次发现，可重新尝试上次读取失败的文件', async () => {
    const file = path.join(__dirname, 'retry.sv'); let discovers = 0, reads = 0, invalidates = 0;
    const index = createWorkspaceSourceIndex({ workspace: { workspaceFolders: [{}], getConfiguration: () => ({ get: () => true }) },
        sourceCatalog: { invalidate() { invalidates++; }, async discover() { discovers++; await new Promise(resolve => setImmediate(resolve)); return { uris: [{ fsPath: file }] }; } },
        onError() {}, stat: async () => ({ size: 20, mtimeMs: 1 }),
        readFile: async () => { if (++reads === 1) throw Error('temporarily locked'); return 'module recovered; endmodule'; } });
    assert.equal((await index.scan()).modules.size, 0);
    const [a, b] = await Promise.all([index.scan(true), index.scan(true)]);
    assert.equal(a, b); assert.equal(a.modules.get('recovered'), file);
    assert.equal(reads, 2); assert.equal(discovers, 2); assert.equal(invalidates, 1);
});
