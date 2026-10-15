'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getCatalog } = require('../src/editor/completion/catalog');
const generator = require('../scripts/generate-completion-catalog');

function named(entries, name) {
    const entry = entries.find(candidate => candidate.name === name);
    assert.ok(entry, '未找到公开接口 ' + name);
    return entry;
}

test('Verilog/SV 标准关键词完整并随标准切换，稀有语法不会漏掉', () => {
    const verilog = getCatalog({ language: 'verilog' });
    const sv = getCatalog({ language: 'systemverilog', uvm: 'off' });
    assert.equal(verilog.keywords.length, 124);
    assert.equal(sv.keywords.length, 248);
    assert.equal(new Set(sv.keywords).size, sv.keywords.length);
    for (const keyword of ['bufif0', 'cmos', 'specify', 'pulsestyle_ondetect', 'config', 'uwire']) assert.ok(verilog.keywords.includes(keyword), keyword);
    for (const keyword of ['checker', 'nettype', 'interconnect', 'implements', 'randsequence', 's_until_with', 'forkjoin', 'binsof', 'soft']) assert.ok(sv.keywords.includes(keyword), keyword);
    for (const keyword of ['class', 'logic', 'always_ff', 'covergroup']) assert.ok(!verilog.keywords.includes(keyword), keyword);
    assert.equal(getCatalog({ standard: '1364-1995' }).keywords.length, 102);
    assert.ok(!getCatalog({ standard: '1800-2005' }).keywords.includes('checker'));
    assert.ok(!getCatalog({ standard: '1800-2009' }).keywords.includes('implements'));
});

test('系统任务族及预处理指令正确分离语言与实现扩展', () => {
    const sv = getCatalog({ uvm: 'off' });
    const verilog = getCatalog({ language: 'verilog' });
    assert.equal(sv.systems.length, 236);
    for (const name of ['$displayh', '$fmonitorb', '$readmemh', '$dumpports', '$async$and$plane', '$sync$nor$array', '$assertvacuousoff', '$past_gclk', '$dist_erlang', '$coverage_get_max']) named(sv.systems, name);
    assert.equal(named(sv.systems, '$typename').returnType, 'string');
    assert.match(named(sv.systems, '$readmemh').signature, /filename.*memory.*start.*end/);
    assert.match(named(sv.systems, '$past').signature, /number_of_ticks.*gating_expression.*clocking_event/);
    assert.match(named(sv.systems, '$setuphold').signature, /setup_limit.*hold_limit.*delayed_reference.*delayed_data/);
    assert.deepEqual(named(sv.systems, '$setuphold').contexts, ['specify']);
    assert.ok(!verilog.systems.some(entry => entry.name === '$urandom'));
    for (const name of ['$swrite', '$sformat', '$sscanf', '$fscanf', '$fread', '$ferror', '$fseek', '$fflush']) named(verilog.systems, name);
    for (const name of ['$sformatf', '$bits', '$cast', '$rose', '$coverage_control']) assert.ok(!verilog.systems.some(entry => entry.name === name));
    assert.equal(named(verilog.systems, '$save').category, 'standard-optional');
    assert.ok(!sv.systems.some(entry => entry.name === '$psprintf'));
    assert.equal(named(getCatalog({ extensions: true }).systems, '$psprintf').category, 'implementation-extension');
    assert.ok(sv.systems.every(entry => !entry.signatureAccuracy));
    for (const name of ['`begin_keywords', '`end_keywords', '`line', '`default_nettype', '`unconnected_drive', '`delay_mode_path']) named(verilog.directives, name);
    named(sv.directives, '`__FILE__');
    assert.ok(!verilog.directives.some(entry => entry.name === '`__FILE__'));
});

test('内建类型方法保留返回类型、合法接收者和 2023 新增接口', () => {
    const { builtins, standardSymbols } = getCatalog({ uvm: 'off' });
    assert.equal(builtins.string.length, 18);
    assert.equal(named(builtins.string, 'tolower').returnType, 'string');
    assert.equal(named(builtins.queue, 'pop_front').returnType, 'element');
    named(builtins.queue, 'push_back');
    assert.ok(!builtins.array.some(entry => entry.name === 'push_back'));
    assert.ok(!builtins.associativeArray.some(entry => entry.name === 'sort'));
    assert.match(named(builtins.associativeArray, 'next').signature, /ref index/);
    assert.equal(named(builtins.enum, 'next').returnType, 'self');
    assert.equal(named(builtins.process, 'self').static, true);
    assert.equal(named(builtins.mailbox, 'get').kind, 'task');
    assert.equal(named(builtins.event, 'triggered').body, 'triggered');
    assert.equal(named(builtins.covergroup, 'option').type, 'covergroupOption');
    assert.equal(named(builtins.covergroup, 'type_option').type, 'covergroupTypeOption');
    assert.equal(named(builtins.coverpoint, 'option').type, 'coverpointOption');
    assert.equal(named(builtins.cross, 'option').type, 'crossOption');
    assert.ok(!builtins.coverpointOption.some(entry => entry.name === 'per_instance'));
    assert.ok(!builtins.crossOption.some(entry => entry.name === 'auto_bin_max'));
    assert.equal(named(builtins.covergroupTypeOption, 'distribute_first').type, 'bit');
    assert.equal(named(builtins.coverpointTypeOption, 'real_interval').since, '1800-2023');
    assert.equal(named(builtins.covergroup, 'get_coverage').static, true);
    assert.equal(named(builtins.constraint, 'constraint_mode').returnType, 'int');
    assert.equal(named(builtins.rand, 'rand_mode').returnType, 'int');
    assert.match(named(builtins.queue, 'find').body, /with/);
    named(standardSymbols, 'weak_reference');
    assert.ok(!getCatalog({ standard: '1800-2017' }).standardSymbols.some(entry => entry.name === 'weak_reference'));
    assert.ok(!getCatalog({ standard: '1800-2017' }).builtins.array.some(entry => entry.name === 'map'));
    assert.deepEqual(getCatalog({ language: 'verilog' }).builtins, {});
});

for (const profile of ['1.2', '1800.2']) {
    test('UVM ' + profile + ' 公开类覆盖 RAL/TLM/sequence/phase/factory/config/callback 并保留参数绑定', () => {
        const { uvm } = getCatalog({ uvm: profile });
        for (const name of ['uvm_object', 'uvm_component', 'uvm_sequence', 'uvm_sequencer', 'uvm_driver', 'uvm_monitor', 'uvm_agent', 'uvm_env', 'uvm_test', 'uvm_scoreboard', 'uvm_reg', 'uvm_reg_field', 'uvm_reg_block', 'uvm_mem', 'uvm_reg_map', 'uvm_tlm_generic_payload', 'uvm_callbacks', 'uvm_factory', 'uvm_phase', 'uvm_domain', 'uvm_config_db', 'uvm_resource_db', 'uvm_tlm_fifo', 'uvm_analysis_port', 'uvm_analysis_imp']) named(uvm.symbols, name);
        const driver = named(uvm.symbols, 'uvm_driver');
        assert.equal(driver.base, 'uvm_component');
        assert.deepEqual(driver.parameters, [{ name: 'REQ', type: 'type', default: 'uvm_sequence_item' }, { name: 'RSP', type: 'type', default: 'REQ' }]);
        assert.equal(named(driver.members, 'seq_item_port').type, 'uvm_seq_item_pull_port #(REQ, RSP)');
        assert.equal(named(driver.members, 'rsp_port').type, 'uvm_analysis_port #(RSP)');
        const pull = named(uvm.symbols, 'uvm_seq_item_pull_port');
        assert.match(named(pull.members, 'get_next_item').signature, /output REQ/);
        assert.match(named(pull.members, 'item_done').signature, /input RSP/);
        const config = named(uvm.symbols, 'uvm_config_db');
        assert.equal(named(config.members, 'set').static, true);
        assert.match(named(config.members, 'get').signature, /inout T value/);
        named(named(uvm.symbols, 'uvm_reg').members, 'read');
        named(named(uvm.symbols, 'uvm_phase').members, 'raise_objection');
        named(uvm.constants, 'UVM_ACTIVE');
        named(uvm.constants, 'UVM_MEDIUM');
        const release = named(uvm.functions, 'uvm_hdl_release_and_read');
        assert.match(release.signature, /inout uvm_hdl_data_t/);
        assert.equal(release.requires, 'DPI-C');
        assert.ok(uvm.symbols.every(entry => !entry.members || entry.members.every(member => member.visibility !== 'protected' && member.visibility !== 'local')));
        assert.ok(uvm.symbols.every(entry => !/^uvm_status_container$|^uvm_typed_callbacks$/.test(entry.name)));
    });
    test('UVM ' + profile + ' 宏插入保留参数、字符串和约束花括号', () => {
        const { uvm } = getCatalog({ uvm: profile });
        for (const name of ['uvm_component_utils', 'uvm_component_param_utils', 'uvm_object_utils_begin', 'uvm_field_array_int', 'uvm_field_queue_object', 'uvm_analysis_imp_decl', 'uvm_register_cb', 'uvm_declare_p_sequencer']) named(uvm.macros, name);
        assert.equal(named(uvm.macros, 'uvm_info').body, '`uvm_info(${1:"ID"}, ${2:"message"}, ${3:UVM_MEDIUM})');
        assert.match(named(uvm.macros, 'uvm_do_with').body, /, \{ \$\{2:constraints\} \}\)/);
        assert.match(named(uvm.macros, 'uvm_field_int').body, /UVM_DEFAULT/);
        assert.match(named(uvm.macros, 'uvm_analysis_imp_decl').body, /_suffix/);
        assert.ok(!uvm.macros.some(entry => /_SVH$/.test(entry.name)));
    });
}

test('IEEE UVM 与贡献、兼容、实现扩展分别标注，不冒充 IEEE 内容', () => {
    const { uvm } = getCatalog({ uvm: '1800.2' });
    assert.equal(named(uvm.symbols, 'uvm_object').category, 'ieee');
    assert.equal(named(uvm.macros, 'uvm_info').category, 'ieee');
    assert.match(named(uvm.macros, 'uvm_info').section, /B\.1\.1\.1/);
    assert.equal(named(uvm.macros, 'uvm_do_with').category, 'compat');
    assert.equal(named(uvm.macros, 'uvm_do_with').deprecated, true);
    assert.ok(uvm.symbols.some(entry => entry.category === 'contrib'));
    assert.ok(uvm.symbols.some(entry => entry.category === 'accellera'));
    assert.ok(uvm.symbols.some(entry => entry.category === 'reference'));
    for (const entry of [...uvm.symbols, ...uvm.functions, ...uvm.macros]) if (entry.category !== 'ieee') assert.notEqual(entry.standard, 'IEEE 1800.2-2020');
    assert.equal(getCatalog({ uvm: 'off' }).uvm.symbols.length, 0);
});

test('生成器忽略注释/字符串中的声明，支持嵌套参数和 DPI 原型', () => {
    const source = `// class decoy; endclass
typedef class forward_type;
// @uvm-ieee 1800.2-2020 auto 1.2.3
virtual class demo #(type T = uvm_pool #(int, string)) extends base #(T);
  string text = "class other; function int bogus(); endclass";
  // @uvm-ieee 1800.2-2020 auto 1.2.4
  extern static function T create(string name = "x,y");
  local function void hidden(); endfunction
endclass
// @uvm-ieee 1800.2-2020 auto 1.2.5
import "DPI-C" context function int first(string name);
// @uvm-ieee 1800.2-2020 auto 1.2.6
import "DPI-C" context function int second(string name);`;
    const classes = generator.extractClasses(source);
    assert.equal(classes.length, 1);
    assert.equal(classes[0].name, 'demo');
    assert.equal(classes[0].base, 'base #(T)');
    assert.equal(classes[0].parameters[0].default, 'uvm_pool #(int, string)');
    assert.deepEqual(generator.extractClasses('class plain extends base #(int); endclass')[0].parameters, []);
    const body = source.slice(classes[0].headerEnd + 1, classes[0].end);
    const methods = generator.extractMethods(body, 'fixture.svh', 'demo', '1800.2', new Set()).methods;
    assert.equal(methods.length, 1);
    assert.equal(methods[0].name, 'create');
    assert.equal(methods[0].static, true);
    assert.equal(methods[0].returnType, 'T');
    assert.match(methods[0].signature, /"x,y"/);
    const globals = generator.extractMethods(source.slice(classes[0].end + 'endclass'.length), 'fixture.svh', '', '1800.2', new Set()).methods;
    assert.deepEqual(globals.map(entry => entry.name), ['first', 'second']);
});

test('目录统计与许可随发布数据保存，可独立审计', () => {
    for (const profile of ['1.2', '1800.2']) {
        const { uvm } = getCatalog({ uvm: profile });
        assert.equal(uvm.metadata.counts.classes, uvm.symbols.filter(symbol => symbol.kind === 'class').length);
        assert.equal(uvm.metadata.counts.members, uvm.symbols.reduce((count, symbol) => count + (symbol.members?.length || 0), 0));
        assert.match(uvm.metadata.archiveSha256, /^[a-f0-9]{64}$/);
        assert.equal(uvm.metadata.license, 'Apache-2.0');
        assert.ok(uvm.metadata.excludedClassDeclarations > 0);
    }
    const licenses = require('../src/editor/completion/catalog-licenses.json');
    assert.match(licenses.uvmLicense, /Apache License/);
    assert.match(licenses.uvmNotice, /Copyright/);
    assert.match(licenses.uvm12Notice, /Copyright/);
    assert.match(licenses.slangLicense, /Permission is hereby granted/);
});

const referenceRoot = path.join(__dirname, '..', 'bin', 'completion-reference');
test('固定官方源码重建目录，结果逐项匹配交付数据', { skip: !fs.existsSync(referenceRoot) }, () => {
    const releases = [
        { profile: '1.2', directory: 'uvm-1.2', archive: 'uvm-1.2.tar.gz', sha256: '502a2e605ce552bfd9767803c7e99a053715b00f7a9c4c511c3fbfddfb30157c', url: 'https://accellera.org/images/downloads/standards/uvm/uvm-1.2.tar.gz', output: 'uvm-1-2' },
        { profile: '1800.2', directory: '1800.2-2020.3.2', archive: 'uvm-2020.3.2.tar.gz', sha256: '4664ac015f23c72106dd785906aa874d70932ea63f74b85de1e32fa5339c15eb', url: 'https://accellera.org/images/downloads/standards/uvm/1800.2-2020.3.2%20Release.gz', output: 'uvm-1800-2' },
    ];
    let previousDocs = new Set();
    for (const release of releases) {
        const { result, docs } = generator.generateUvm(referenceRoot, release, previousDocs);
        const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
        assert.equal(digest(result), digest(require('../src/editor/completion/' + release.output + '.json')), release.profile + ' 固定源码生成的接口集合、签名、分类与发布数据一致');
        previousDocs = docs;
    }
    assert.deepEqual(generator.generateLanguage(referenceRoot), require('../src/editor/completion/language-standard.json'));
});
