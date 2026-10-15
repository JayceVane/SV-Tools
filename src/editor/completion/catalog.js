'use strict';

const languageData = require('./language-standard.json');

const VERILOG = 'IEEE 1364-2005';
const SYSTEMVERILOG = 'IEEE 1800-2023';
const SYSTEMVERILOG_ONLY = new Set((
    '$bits $typename $isunbounded $low $high $left $right $size $increment $dimensions $unpacked_dimensions ' +
    '$shortrealtobits $bitstoshortreal $coverage_control $coverage_get_max $coverage_get $coverage_merge $coverage_save ' +
    '$get_coverage $set_coverage_db_name $load_coverage_db $countbits $countones $onehot $onehot0 $isunknown ' +
    '$global_clock $sformatf $inferred_clock $inferred_disable $rose $fell $stable $changed $sampled $past ' +
    '$past_gclk $rose_gclk $fell_gclk $stable_gclk $changed_gclk $future_gclk $rising_gclk $falling_gclk $steady_gclk $changing_gclk ' +
    '$urandom $urandom_range $timeunit $timeprecision $fatal $cast $info $warning $error $exit ' +
    '$assertcontrol $asserton $assertoff $assertkill $assertpasson $assertpassoff $assertfailon $assertfailoff $assertnonvacuouson $assertvacuousoff ' +
    '$stacktrace'
).split(/\s+/));
const IMPLEMENTATION_EXTENSIONS = new Set(['$psprintf', '$static_assert', '$deposit', '$showvars']);
const SV2023_SYSTEMS = new Set(['$timeunit', '$timeprecision', '$stacktrace']);
const OPTIONAL_SYSTEMS = new Set('$input $key $nokey $list $log $nolog $reset $reset_count $reset_value $restart $save $incsave $scope $showscopes'.split(' '));

function escapeSnippet(value) {
    return value.replace(/[\\$}]/g, '\\$&');
}

function callable(name, parameters = [], returnType = 'void', standard = SYSTEMVERILOG, extra = {}) {
    return { name, kind: 'function', signature: (returnType === 'void' ? '' : returnType + ' ') + name + '(' + parameters.join(', ') + ')', body: escapeSnippet(name) + '(' + parameters.map((parameter, index) => {
        const parameterName = /([A-Za-z_]\w*)(?:\s*(?:=|\[)[\s\S]*)?$/.exec(parameter)?.[1] || parameter;
        return '${' + (index + 1) + ':' + escapeSnippet(parameterName) + '}';
    }).join(', ') + ')', returnType, standard, ...extra };
}

// 参数中的可选项在签名保留默认值，插入时使用参数名作为编辑点。
const SYSTEM_SIGNATURES = new Map();
function systems(names, parameters, returnType = 'void') {
    for (const name of names.split(/\s+/)) SYSTEM_SIGNATURES.set(name, { parameters, returnType });
}
systems('$bits $isunbounded', ['expression_or_type'], 'int');
systems('$typename', ['expression_or_type'], 'string');
systems('$low $high $left $right $size $increment', ['array_or_type', 'dimension = 1'], 'int');
systems('$dimensions $unpacked_dimensions', ['array_or_type'], 'int');
systems('$rtoi', ['real value'], 'int');
systems('$itor', ['int value'], 'real');
systems('$realtobits', ['real value'], 'bit [63:0]');
systems('$bitstoreal', ['bit [63:0] value'], 'real');
systems('$shortrealtobits', ['shortreal value'], 'bit [31:0]');
systems('$bitstoshortreal', ['bit [31:0] value'], 'shortreal');
systems('$signed $unsigned', ['expression'], 'expression');
systems('$clog2 $countones', ['expression'], 'int');
systems('$countbits', ['expression', 'control_bit', 'additional_control_bits'], 'int');
systems('$onehot $onehot0 $isunknown', ['expression'], 'bit');
systems('$ln $log10 $exp $sqrt $floor $ceil $sin $cos $tan $asin $acos $atan $sinh $cosh $tanh $asinh $acosh $atanh', ['real value'], 'real');
systems('$pow', ['real base', 'real exponent'], 'real');
systems('$atan2', ['real y', 'real x'], 'real');
systems('$hypot', ['real x', 'real y'], 'real');
systems('$test$plusargs', ['string prefix'], 'int');
systems('$value$plusargs', ['string format', 'variable'], 'int');
systems('$sformatf $psprintf', ['string format', 'arguments'], 'string');
systems('$global_clock $inferred_clock $inferred_disable', [], 'event');
systems('$sampled', ['expression'], 'expression');
systems('$rose $fell $stable $changed', ['expression', 'clocking_event = inferred_clock'], 'bit');
systems('$past', ['expression', 'number_of_ticks = 1', 'gating_expression = 1', 'clocking_event = inferred_clock'], 'expression');
systems('$past_gclk $future_gclk', ['expression'], 'expression');
systems('$rose_gclk $fell_gclk $stable_gclk $changed_gclk $rising_gclk $falling_gclk $steady_gclk $changing_gclk', ['expression'], 'bit');
systems('$time $stime', [], 'time');
systems('$realtime', [], 'realtime');
systems('$timeunit $timeprecision', ['scope = current_scope'], 'int');
systems('$random', ['seed = implicit_seed'], 'int');
systems('$urandom', ['seed = implicit_seed'], 'int unsigned');
systems('$urandom_range', ['int unsigned maxval', 'int unsigned minval = 0'], 'int unsigned');
systems('$reset_count $reset_value', [], 'int');
systems('$scale', ['hierarchical_name'], 'real');
systems('$dist_uniform', ['ref int seed', 'int start', 'int end'], 'int');
systems('$dist_normal', ['ref int seed', 'int mean', 'int standard_deviation'], 'int');
systems('$dist_exponential $dist_poisson', ['ref int seed', 'int mean'], 'int');
systems('$dist_chi_square $dist_t', ['ref int seed', 'int degrees_of_freedom'], 'int');
systems('$dist_erlang', ['ref int seed', 'int k_stage', 'int mean'], 'int');
systems('$fopen', ['string filename', 'string mode = ""'], 'int');
systems('$fclose $fflush', ['int descriptor']);
systems('$fgetc $ftell $rewind $feof', ['int descriptor'], 'int');
systems('$ungetc', ['int character', 'int descriptor'], 'int');
systems('$ferror', ['int descriptor', 'string message'], 'int');
systems('$fgets', ['string buffer', 'int descriptor'], 'int');
systems('$fseek', ['int descriptor', 'int offset', 'int operation'], 'int');
systems('$fread', ['variable_or_memory', 'int descriptor', 'start = 0', 'count = remaining_entries'], 'int');
systems('$fscanf', ['int descriptor', 'string format', 'variables'], 'int');
systems('$sscanf', ['string input', 'string format', 'variables'], 'int');
systems('$system', ['string command = ""'], 'int');
systems('$cast', ['destination', 'source'], 'int');
systems('$fatal', ['int finish_number = 1', 'string format', 'arguments']);
systems('$info $warning $error', ['string format', 'arguments']);
systems('$finish $stop', ['int finish_number = 1']);
systems('$exit $monitoron $monitoroff $dumpon $dumpoff $dumpall $dumpflush $nokey $nolog', []);
systems('$dumpfile', ['string filename']);
systems('$dumpvars', ['int levels = 0', 'scopes_or_variables']);
systems('$dumpports', ['scopes', 'string filename']);
systems('$dumplimit', ['int bytes']);
systems('$dumpportson $dumpportsoff $dumpportsall $dumpportsflush', ['string filename']);
systems('$dumpportslimit', ['int bytes', 'string filename']);
systems('$readmemb $readmemh $writememb $writememh', ['string filename', 'memory', 'start = first_address', 'end = last_address']);
systems('$sreadmemb $sreadmemh', ['memory', 'start', 'end', 'string data']);
systems('$timeformat', ['int units', 'int precision', 'string suffix', 'int minimum_field_width']);
systems('$printtimescale', ['scope = current_scope']);
systems('$sdf_annotate', ['string sdf_file', 'module_instance = current_scope', 'string config_file = ""', 'string log_file = ""', 'string mtm_spec = "TOOL_CONTROL"', 'string scale_factors = "1.0:1.0:1.0"', 'string scale_type = "FROM_MTM"']);
systems('$coverage_control', ['int control_constant', 'int coverage_type', 'int scope', 'module_instance'], 'int');
systems('$coverage_get_max $coverage_get', ['int coverage_type', 'int scope', 'module_instance'], 'int');
systems('$coverage_merge $coverage_save', ['int coverage_type', 'string filename'], 'int');
systems('$get_coverage', [], 'real');
systems('$set_coverage_db_name $load_coverage_db', ['string filename']);
systems('$countdrivers', ['net', 'net_is_forced', 'number_of_01x_drivers', 'number_of_0_drivers', 'number_of_1_drivers', 'number_of_x_drivers'], 'bit');
systems('$getpattern', ['memory_element'], 'expression');
systems('$list $scope', ['scope = current_scope']);
systems('$showscopes', ['int levels = 0']);
systems('$input $key $log $save $restart $incsave', ['string filename']);
systems('$reset', ['int stop_value = 0', 'int reset_value = 0', 'int diagnostics_value = 0']);
systems('$q_initialize', ['int q_id', 'int q_type', 'int max_length', 'output int status']);
systems('$q_add', ['int q_id', 'int job_id', 'int inform_id', 'output int status']);
systems('$q_remove', ['int q_id', 'output int job_id', 'output int inform_id', 'output int status']);
systems('$q_exam', ['int q_id', 'int q_stat_code', 'output int q_stat_value', 'output int status']);
systems('$q_full', ['int q_id', 'output int status'], 'int');
systems('$stacktrace', [], 'string');
systems('$setup', ['data_event', 'reference_event', 'limit', 'notifier = omitted']);
systems('$hold $recovery $removal $skew', ['reference_event', 'data_event', 'limit', 'notifier = omitted']);
systems('$setuphold', ['reference_event', 'data_event', 'setup_limit', 'hold_limit', 'notifier = omitted', 'timestamp_condition = omitted', 'timecheck_condition = omitted', 'delayed_reference = omitted', 'delayed_data = omitted']);
systems('$recrem', ['reference_event', 'data_event', 'recovery_limit', 'removal_limit', 'notifier = omitted', 'timestamp_condition = omitted', 'timecheck_condition = omitted', 'delayed_reference = omitted', 'delayed_data = omitted']);
systems('$timeskew', ['reference_event', 'data_event', 'limit', 'notifier = omitted', 'event_based_flag = 0', 'remain_active_flag = 0']);
systems('$fullskew', ['reference_event', 'data_event', 'limit1', 'limit2', 'notifier = omitted', 'event_based_flag = 0', 'remain_active_flag = 0']);
systems('$period', ['reference_event', 'limit', 'notifier = omitted']);
systems('$width', ['reference_event', 'limit', 'threshold = 0', 'notifier = omitted']);
systems('$nochange', ['reference_event', 'data_event', 'start_edge_offset', 'end_edge_offset', 'notifier = omitted']);

function systemEntry(name) {
    let signature = SYSTEM_SIGNATURES.get(name);
    if (/^\$(?:display|write|strobe|monitor)[boh]?$/.test(name)) signature = { parameters: ['string format', 'arguments'], returnType: 'void' };
    if (/^\$f(?:display|write|strobe|monitor)[boh]?$/.test(name)) signature = { parameters: ['int descriptor', 'string format', 'arguments'], returnType: 'void' };
    if (/^\$(?:swrite[boh]?|sformat)$/.test(name)) signature = { parameters: ['string destination', 'string format', 'arguments'], returnType: 'void' };
    if (/^\$assert/.test(name)) signature = { parameters: name === '$assertcontrol' ? ['int control_type', 'int assertion_type = 31', 'int directive_type = 7', 'int levels = 0', 'scopes'] : ['int levels = 0', 'scopes'], returnType: 'void' };
    if (/^\$(?:async|sync)\$/.test(name)) signature = { parameters: ['memory', 'inputs', 'outputs'], returnType: 'void' };
    const standard = SYSTEMVERILOG_ONLY.has(name) ? SYSTEMVERILOG : VERILOG;
    if (!signature) return { name, kind: 'function', signature: name + '(...)', body: escapeSnippet(name) + '(${1})', standard, signatureAccuracy: 'name-only' };
    return callable(name, signature.parameters, signature.returnType, standard, { category: IMPLEMENTATION_EXTENSIONS.has(name) ? 'implementation-extension' : OPTIONAL_SYSTEMS.has(name) ? 'standard-optional' : 'standard', since: SV2023_SYSTEMS.has(name) ? '1800-2023' : undefined, contexts: languageData.timingChecks.includes(name) ? ['specify'] : undefined });
}

const DIRECTIVE_PARAMETERS = {
    begin_keywords: ['"1800-2023"'], celldefine: [], default_nettype: ['none'], define: ['NAME', 'value'], else: [], elsif: ['MACRO'], end_keywords: [], endcelldefine: [], endif: [], ifdef: ['MACRO'], ifndef: ['MACRO'], include: ['"file.svh"'], line: ['number', '"filename"', 'level'], nounconnected_drive: [], pragma: ['pragma_name', 'arguments'], resetall: [], timescale: ['1ns', '/', '1ps'], unconnected_drive: ['pull0'], undef: ['MACRO'], undefineall: [], default_decay_time: ['time'], default_trireg_strength: ['strength'], delay_mode_distributed: [], delay_mode_path: [], delay_mode_unit: [], delay_mode_zero: [], __FILE__: [], __LINE__: [],
};
const SV_ONLY_DIRECTIVES = new Set(['pragma', 'undefineall', '__FILE__', '__LINE__']);
const DIRECTIVES = Object.entries(DIRECTIVE_PARAMETERS).map(([name, parameters]) => ({ name: '`' + name, kind: 'directive', signature: '`' + name + (parameters.length ? ' ' + parameters.join(' ') : ''), body: '`' + name + (parameters.length ? ' ' + parameters.map((parameter, index) => parameter === '/' ? '/' : '${' + (index + 1) + ':' + escapeSnippet(parameter) + '}').join(' ') : ''), standard: SV_ONLY_DIRECTIVES.has(name) ? SYSTEMVERILOG : VERILOG }));

function methods(definitions, extra = {}) {
    return definitions.map(([name, parameters, returnType, attributes]) => callable(name, parameters, returnType, SYSTEMVERILOG, { ...extra, ...attributes }));
}
const ARRAY_LOCATORS = methods([
    ['find', [], 'element[$]'], ['find_index', [], 'index[$]'], ['find_first', [], 'element[$]'], ['find_first_index', [], 'index[$]'], ['find_last', [], 'element[$]'], ['find_last_index', [], 'index[$]'],
].map(([name, args, type]) => [name, args, type, { body: name + '() with (${1:item})', signature: name + '() with (expression)' }]));
const ARRAY_COMMON = [
    ...ARRAY_LOCATORS,
    ...methods(['min', 'max', 'unique'].map(name => [name, [], 'element[$]'])),
    ...methods([['unique_index', [], 'index[$]']]),
    ...methods(['sum', 'product', 'and', 'or', 'xor'].map(name => [name, [], 'element'])),
    ...methods([['map', [], 'self', { since: '1800-2023', body: 'map() with (${1:item})', signature: 'map() with (expression)' }]]),
];
const ARRAY_ORDER = methods(['sort', 'rsort', 'reverse', 'shuffle'].map(name => [name, [], 'void']));
const BUILTINS = {
    string: methods([
        ['len', [], 'int'], ['putc', ['int index', 'byte character'], 'void'], ['getc', ['int index'], 'byte'], ['toupper', [], 'string'], ['tolower', [], 'string'], ['compare', ['string other'], 'int'], ['icompare', ['string other'], 'int'], ['substr', ['int first', 'int last'], 'string'], ['atoi', [], 'int'], ['atohex', [], 'int'], ['atooct', [], 'int'], ['atobin', [], 'int'], ['atoreal', [], 'real'], ['itoa', ['int value'], 'void'], ['hextoa', ['int value'], 'void'], ['octtoa', ['int value'], 'void'], ['bintoa', ['int value'], 'void'], ['realtoa', ['real value'], 'void'],
    ]),
    array: [...ARRAY_COMMON, ...ARRAY_ORDER],
    dynamicArray: [...ARRAY_COMMON, ...ARRAY_ORDER, ...methods([['size', [], 'int'], ['delete', [], 'void']])],
    queue: [...ARRAY_COMMON, ...ARRAY_ORDER, ...methods([['size', [], 'int'], ['insert', ['int index', 'element item'], 'void'], ['delete', ['int index = all'], 'void'], ['pop_front', [], 'element'], ['pop_back', [], 'element'], ['push_front', ['element item'], 'void'], ['push_back', ['element item'], 'void']])],
    associativeArray: [...ARRAY_COMMON, ...methods([['num', [], 'int'], ['size', [], 'int'], ['delete', ['index key = all'], 'void'], ['exists', ['index key'], 'int'], ['first', ['ref index key'], 'int'], ['last', ['ref index key'], 'int'], ['next', ['ref index key'], 'int'], ['prev', ['ref index key'], 'int']])],
    enum: methods([['first', [], 'self'], ['last', [], 'self'], ['next', ['int count = 1'], 'self'], ['prev', ['int count = 1'], 'self'], ['num', [], 'int'], ['name', [], 'string']]),
    mailbox: methods([['new', ['int bound = 0'], 'self'], ['num', [], 'int'], ['put', ['element message'], 'void', { kind: 'task' }], ['try_put', ['element message'], 'int'], ['get', ['ref element message'], 'void', { kind: 'task' }], ['try_get', ['ref element message'], 'int'], ['peek', ['ref element message'], 'void', { kind: 'task' }], ['try_peek', ['ref element message'], 'int']]),
    semaphore: methods([['new', ['int keyCount = 0'], 'self'], ['put', ['int keyCount = 1'], 'void'], ['get', ['int keyCount = 1'], 'void', { kind: 'task' }], ['try_get', ['int keyCount = 1'], 'int']]),
    process: methods([['self', [], 'process', { static: true }], ['status', [], 'process::state'], ['kill', [], 'void'], ['await', [], 'void', { kind: 'task' }], ['suspend', [], 'void'], ['resume', [], 'void'], ['get_randstate', [], 'string'], ['set_randstate', ['string state'], 'void'], ['srandom', ['int seed'], 'void']]),
    weak_reference: methods([['new', ['element referent'], 'self'], ['get', [], 'element'], ['clear', [], 'void'], ['get_id', ['element obj'], 'longint', { static: true }]], { since: '1800-2023' }),
    class: methods([['randomize', ['variables = all'], 'int'], ['pre_randomize', [], 'void'], ['post_randomize', [], 'void'], ['srandom', ['int seed'], 'void'], ['get_randstate', [], 'string'], ['set_randstate', ['string state'], 'void'], ['rand_mode', ['int enabled = query'], 'int'], ['constraint_mode', ['int enabled = query'], 'int']]),
    covergroup: methods([['sample', ['sample_arguments'], 'void'], ['start', [], 'void'], ['stop', [], 'void'], ['set_inst_name', ['string name'], 'void'], ['get_coverage', ['ref int covered = omitted', 'ref int total = omitted'], 'real', { static: true }], ['get_inst_coverage', ['ref int covered = omitted', 'ref int total = omitted'], 'real']]),
    coverpoint: methods([['get_coverage', ['ref int covered = omitted', 'ref int total = omitted'], 'real', { static: true }], ['get_inst_coverage', ['ref int covered = omitted', 'ref int total = omitted'], 'real'], ['start', [], 'void'], ['stop', [], 'void']]),
    cross: methods([['get_coverage', ['ref int covered = omitted', 'ref int total = omitted'], 'real', { static: true }], ['get_inst_coverage', ['ref int covered = omitted', 'ref int total = omitted'], 'real'], ['start', [], 'void'], ['stop', [], 'void']]),
    constraint: methods([['constraint_mode', ['int enabled = query'], 'int', { body: 'constraint_mode(${1:1})' }]]),
    rand: methods([['rand_mode', ['int enabled = query'], 'int', { body: 'rand_mode(${1:1})' }]]),
    event: [{ name: 'triggered', kind: 'property', type: 'bit', returnType: 'bit', signature: 'bit triggered', body: 'triggered', standard: SYSTEMVERILOG }],
    sequence: [{ name: 'triggered', kind: 'property', type: 'bit', signature: 'bit triggered', body: 'triggered', standard: SYSTEMVERILOG }, { name: 'matched', kind: 'property', type: 'bit', signature: 'bit matched', body: 'matched', standard: SYSTEMVERILOG }],
    iterator: methods([['index', ['int dimension = 1'], 'index']]),
};

const COVERAGE_OPTIONS = {
    covergroupOption: { name: 'string', comment: 'string', weight: 'int', goal: 'int', at_least: 'int', auto_bin_max: 'int', detect_overlap: 'bit', cross_num_print_missing: 'int', per_instance: 'bit', get_inst_coverage: 'bit', cross_retain_auto_bins: 'bit' },
    covergroupTypeOption: { comment: 'string', weight: 'int', goal: 'int', strobe: 'bit', merge_instances: 'bit', distribute_first: 'bit', real_interval: 'real' },
    coverpointOption: { weight: 'int', goal: 'int', comment: 'string', at_least: 'int', auto_bin_max: 'int', detect_overlap: 'bit' },
    coverpointTypeOption: { weight: 'int', goal: 'int', comment: 'string', real_interval: 'real' },
    crossOption: { weight: 'int', goal: 'int', comment: 'string', at_least: 'int', cross_num_print_missing: 'int', cross_retain_auto_bins: 'bit' },
    crossTypeOption: { weight: 'int', goal: 'int', comment: 'string' },
};
for (const [kind, properties] of Object.entries(COVERAGE_OPTIONS)) BUILTINS[kind] = Object.entries(properties).map(([name, type]) => ({ name, kind: 'property', type, returnType: type, signature: type + ' ' + name, body: name, standard: SYSTEMVERILOG, since: ['cross_retain_auto_bins', 'real_interval'].includes(name) ? '1800-2023' : undefined }));
for (const kind of ['covergroup', 'coverpoint', 'cross']) for (const [name, suffix] of [['option', 'Option'], ['type_option', 'TypeOption']]) {
    const type = kind + suffix;
    BUILTINS[kind].push({ name, kind: 'property', type, returnType: type, static: name === 'type_option', signature: type + ' ' + name, body: name, standard: SYSTEMVERILOG });
}

const uvmCache = new Map();
function uvmCatalog(profile) {
    if (profile === 'off') return { symbols: [], functions: [], constants: [], macros: [], metadata: { profile: 'off' } };
    const selected = profile === '1800.2' || profile === '1800.2-2020' ? '1800.2' : '1.2';
    if (!uvmCache.has(selected)) uvmCache.set(selected, require(selected === '1.2' ? './uvm-1-2.json' : './uvm-1800-2.json'));
    return uvmCache.get(selected);
}

/**
 * @param {{language?:string,uvm?:string,standard?:string,extensions?:boolean}} [options]
 * @returns {{keywords:string[],systems:object[],directives:object[],builtins:object,uvm:object,standardSymbols:object[],standardFunctions:object[],metadata:object}}
 * 只按请求的语言/标准组合接口目录；UVM 首次请求才读静态 JSON。
 */
function getCatalog(options = {}) {
    const requestedStandard = options.standard === 'auto' ? undefined : options.standard;
    const isVerilog = options.language === 'verilog' || /^1364-/.test(requestedStandard || '');
    const standard = languageData.profiles[requestedStandard] ? requestedStandard : isVerilog ? '1364-2005' : '1800-2023';
    const isPre2023 = standard.startsWith('1800-') && standard !== '1800-2023';
    const builtins = isVerilog ? {} : Object.fromEntries(Object.entries(BUILTINS).map(([kind, entries]) => [kind, entries.filter(entry => !isPre2023 || entry.since !== '1800-2023')]));
    const standardSymbols = isVerilog ? [] : ['process', 'mailbox', 'semaphore', ...(!isPre2023 ? ['weak_reference'] : [])].map(name => ({ name, kind: 'class', parameters: ['mailbox', 'weak_reference'].includes(name) ? [{ name: 'T', type: 'type' }] : [], members: builtins[name], standard: SYSTEMVERILOG, package: 'std' }));
    if (!isVerilog) standardSymbols.push({ name: 'state', kind: 'enum', scope: 'process', members: ['FINISHED', 'RUNNING', 'WAITING', 'SUSPENDED', 'KILLED'].map(name => ({ name, kind: 'enumMember', type: 'process::state', body: name, static: true, standard: SYSTEMVERILOG })) });
    return {
        keywords: languageData.profiles[standard],
        systems: [...languageData.systems, ...languageData.timingChecks].filter(name => (!isVerilog || !SYSTEMVERILOG_ONLY.has(name)) && (options.extensions || !IMPLEMENTATION_EXTENSIONS.has(name)) && (!isPre2023 || !SV2023_SYSTEMS.has(name))).map(systemEntry),
        directives: DIRECTIVES.filter(entry => !isVerilog || !SV_ONLY_DIRECTIVES.has(entry.name.slice(1))),
        builtins,
        uvm: uvmCatalog(isVerilog ? 'off' : options.uvm),
        standardSymbols,
        standardFunctions: isVerilog ? [] : [callable('randomize', ['variables'], 'int', SYSTEMVERILOG, { package: 'std', static: true })],
        metadata: { ...languageData.metadata, standard, uvm: isVerilog ? 'off' : options.uvm || '1.2', historicalApiFiltering: '关键词按各版完整表；系统调用与内建成员按 Verilog-2005/SystemVerilog-2023 分离，并核验 2023 新增项；较旧档位并非逐版完整 API 快照。', policy: '标准关键词完整枚举；系统调用区分可选项和实现扩展；API 签名描述可选/可变参数；UVM 原始 API 类别随条目保存。' },
    };
}

module.exports = { getCatalog };
