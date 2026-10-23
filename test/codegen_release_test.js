'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createNativeLoader } = require('../src/native-loader');
const root = path.join(__dirname, '..');
const native = createNativeLoader({ rootDir: root }).load();
const cases = [
    { name: 'nested', ports: ['d', 'q'], clocks: [] },
    { name: 'integer', ports: ['d', 'b', 'q'], clocks: [] },
    { name: 'split', ports: ['d', 'q', 'r', 'qreg'], clocks: [] },
    { name: 'combinational', ports: ['d', 'q', 'pad'], clocks: [] },
    { name: 'multiclock', ports: ['launch', 'reset_main', 'capture', 'rst_n_b', 'd', 'qa', 'qb'], clocks: ['launch', 'capture'] },
    { name: 'legacy', ports: ['clk', 'rst_n', 'd', 'q'], clocks: ['clk'] },
    { name: 'timed_reset', ports: ['sreset_n', 'd', 'q'], clocks: [] },
    { name: 'negedge', ports: ['trigger_clk', 'd', 'q'], clocks: ['trigger_clk'] }
].map(item => ({ ...item, module: 'codegen_' + item.name,
    source: fs.readFileSync(path.join(__dirname, 'fixtures/codegen', 'codegen_' + item.name + '.sv'), 'utf8') }));

/** 从公开NAPI入口生成骨架；配置中的无关名字不能变成虚构信号。 */
function generate(item, options = {}) {
    const result = native.generateTestbench(item.source, { ...item.options, ...options });
    assert.equal(result.success, true, result.error);
    assert.equal(result.module, item.module);
    return result.result;
}
for (const item of cases) {
    test('发布骨架保留真实端口与时钟：' + item.name, () => {
        const text = generate(item);
        const bindings = [...text.matchAll(/^\s*\.(\w+)\s*\(\s*(\w+)\s*\)/gm)]
            .filter(([, name]) => item.ports.includes(name)).map(([, name, signal]) => [name, signal]);
        assert.deepEqual(bindings, item.ports.map(name => [name, name]), text);
        for (const clock of item.clocks) assert.match(text, new RegExp('forever #\\(0\\.5\\) ' + clock + ' = ~' + clock + ';'));
        if (!item.clocks.length) assert.doesNotMatch(text, /posedge|negedge/);
        assert.doesNotMatch(text, /\$get_initial_random_seed|\b(?:unrelated_clk|unrelated_reset)\b/);
        assert.match(text, new RegExp('\\$dumpvars\\(0, tb_' + item.module + '\\);'));
        assert.doesNotMatch(text, /\$(?:fsdbDump|vcdplus|shm_)|\$test\$plusargs\("vcd"\)/);
    });
}
test('嵌套参数、字符串与继承类型在实例和TB中均完整', () => {
    const item = cases.find(item => item.name === 'nested'), text = generate(item), instance = native.generateModuleInst(item.source, {});
    assert.equal(instance.success, true, instance.error);
    for (const generated of [text, instance.result]) {
        assert.match(generated, /(?:localparam|parameter) integer W = \$clog2\(16\);/);
        assert.match(generated, /(?:localparam|parameter) integer DEPTH = 4;/);
        assert.match(generated, /PAIR\s*=\s*\{8'hA5,\s*8'h3C\};/);
        assert.match(generated, /LABEL\s*=\s*"a,b\)";/);
        assert.ok(generated.includes('URL = "https://example.invalid/a;  b)";'), generated);
        assert.doesNotMatch(generated, /parameter W\s+W|DEPTH\s+integer DEPTH/);
    }
    assert.match(text, /localparam LAST = W-1;/);
});
test('inout仅声明wire；配置列表只筛选实际输入；普通复位名不猜低有效', () => {
    const text = generate(cases.find(item => item.name === 'combinational'), { clock: ['unrelated_clk', 'pad', 'q'], reset: ['unrelated_reset', 'q'] });
    assert.match(text, /^\s*wire pad;/m);
    assert.doesNotMatch(text, /^\s*(?:pad|q)\s*(?:=|<=)/m);
    assert.doesNotMatch(text, /forever|posedge|unrelated/);
    const multi = generate(cases.find(item => item.name === 'multiclock'));
    assert.match(multi, /reset_main = '1;\s*#10;\s*reset_main = '0;/);
    assert.match(multi, /rst_n_b = '0;\s*#10;\s*rst_n_b = '1;/);
});
test('专用仿真器显式波形选项保持原工具调用', () => {
    for (const [kind, task] of [['fsdb', '$fsdbDumpvars'], ['vpd', '$vcdpluson'], ['shm', '$shm_probe']]) {
        const text = generate(cases.find(item => item.name === 'combinational'), { waveType: kind });
        assert.ok(text.includes(task), text);
        assert.doesNotMatch(text, /`ifdef/);
    }
});

for (const declaration of ['input logic [7:0] mem [0:3]', 'input pkg::type_t d', 'axi_if.master bus', 'axi_if bus', 'input real value']) {
    test('不支持的接口明确失败而不生成丢端口模板：' + declaration, () => {
        const source = 'module unsupported(' + declaration + '); endmodule';
        for (const method of ['generateModuleInst', 'generateTestbench']) {
            const result = native[method](source, {});
            assert.equal(result.success, false, JSON.stringify(result));
            assert.ok(!result.result, result.result);
            assert.match(result.error, /不支持|无法生成/);
        }
    });
}
test('整数端口完整宽度和非ANSI同名子程序形参保持正确', () => {
    const integer = native.generateModuleInst(cases.find(item => item.name === 'integer').source, {});
    assert.equal(integer.success, true, integer.error);
    assert.match(integer.result, /reg signed \[31:0\] d;/);
    assert.match(integer.result, /reg \[7:0\] b;/);
    assert.match(integer.result, /wire signed \[63:0\] q;/);
    const legacy = native.generateModuleInst(cases.find(item => item.name === 'legacy').source, {});
    assert.equal(legacy.success, true, legacy.error);
    assert.match(legacy.result, /reg \[WIDTH-1:0\] d;/);
    assert.match(legacy.result, /wire \[WIDTH-1:0\] q;/);
    assert.doesNotMatch(legacy.result, /\[[12]:0\]/);
});

for (const [name, source] of [
    ['数组参数', "module p #(parameter integer A[0:1]='{1,2})(input d, output q); assign q=d; endmodule"],
    ['类型参数', 'module p #(parameter type T=logic)(input d, output q); assign q=d; endmodule'],
    ['不完整参数片段', 'module p #(parameter A=1, B)(input d, output q); assign q=d; endmodule'],
    ['拆分数组端口', 'module p(q); output q; wire [7:0] q [0:3]; endmodule'],
    ['拆分用户类型端口', 'module p(q); output q; pkg::type_t q; endmodule']
]) {
    test('声明补全不能静默省略：' + name, () => {
        for (const method of ['generateModuleInst', 'generateTestbench']) {
            const result = native[method](source, {});
            assert.equal(result.success, false, JSON.stringify(result));
            assert.ok(!result.result, result.result);
            assert.match(result.error, /不支持|无法生成/);
        }
    });
}
test('拆分声明多名称完整补宽度和符号，局部同名声明不参与补全', () => {
    const item = cases.find(item => item.name === 'split');
    for (const text of [generate(item), native.generateModuleInst(item.source, {}).result]) {
        for (const port of ['q', 'r', 'qreg']) {
            assert.match(text, new RegExp('(?:wire|logic) signed \\[7:0\\] ' + port + ';'));
        }
        assert.doesNotMatch(text, /\[[12]:0\]/);
    }
});

// 显式指定工具后，执行夹具中的DUT自检并读取真实VCD；日常合同不依赖本机安装路径。
const iverilog = process.env.SVTOOLS_CODEGEN_IVERILOG, vvp = process.env.SVTOOLS_CODEGEN_VVP;
for (const item of [...cases, { ...cases.find(item => item.name === 'multiclock'), name: 'multiclock_no_tasks', marker: 'multiclock', options: { taskInit: false, taskDrive: false } }]) {
    test('真实Icarus编译运行及VCD：' + item.name, { skip: !iverilog || !vvp, timeout: 30000 }, () => {
        const directory = path.join(process.env.SVTOOLS_CODEGEN_OUTPUT || path.join(root, 'bin/release-codegen-validation'),
            String(process.pid), item.name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'dut.sv'), item.source);
        fs.writeFileSync(path.join(directory, 'tb.sv'), generate(item));
        const env = { ...process.env };
        if (process.env.SVTOOLS_CODEGEN_CYGWIN) env.PATH = process.env.SVTOOLS_CODEGEN_CYGWIN + path.delimiter + env.PATH;
        const options = { cwd: directory, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
        const compiled = spawnSync(iverilog, ['-g2012', '-s', 'tb_' + item.module, '-o', 'case.vvp', 'dut.sv', 'tb.sv'], options);
        fs.writeFileSync(path.join(directory, 'compile.log'), String(compiled.stdout || '') + String(compiled.stderr || '') + String(compiled.error || ''));
        assert.equal(compiled.status, 0, fs.readFileSync(path.join(directory, 'compile.log'), 'utf8'));
        const runtime = spawnSync(vvp, ['case.vvp'], options);
        fs.writeFileSync(path.join(directory, 'runtime.log'), String(runtime.stdout || '') + String(runtime.stderr || '') + String(runtime.error || ''));
        assert.equal(runtime.status, 0, fs.readFileSync(path.join(directory, 'runtime.log'), 'utf8'));
        assert.match(runtime.stdout, new RegExp('CODEGEN_PASS ' + (item.marker || item.name)));
        const wave = fs.readFileSync(path.join(directory, 'tb_' + item.module + '.vcd'), 'utf8');
        assert.match(wave, /\$enddefinitions\s+\$end/);
        for (const clock of item.clocks) {
            const escaped = clock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const id = wave.match(new RegExp('\\$var\\s+\\S+\\s+1\\s+(\\S+)\\s+' + escaped + '\\s+\\$end'))?.[1];
            assert.ok(id, 'VCD缺少时钟：' + clock);
            assert.ok(wave.split(/\s+/).includes('0' + id) && wave.split(/\s+/).includes('1' + id), '时钟没有实际翻转：' + clock);
        }
    });
}
