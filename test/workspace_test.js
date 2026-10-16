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
    const index = createWorkspaceSourceIndex({ workspace, readFileSync: file => sources.get(file), now: () => timestamp });
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
        readFileSync: file => {
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
        readFileSync: file => { reads.push(file); return file === internal ? 'module wrong; endmodule' : 'module top; endmodule'; } });
    const result = await index.scan();
    assert.equal(result.modules.has('wrong'), false); assert.equal(result.modules.get('top'), normal);
    assert.ok(reads.every(file => file === normal));
});
