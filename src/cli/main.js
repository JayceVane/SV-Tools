#!/usr/bin/env node
'use strict';
const { parseArgs } = require('node:util');
const services = require('../agent/operations');
const tasks = require('../agent/tasks');
const vivado = require('../agent/vivado');
const { fail, failure } = require('../agent/protocol');

const help=`SV Tools headless CLI (API 1)
  doctor
  project list|inspect
  format --file <path> [--check|--write]
  lint [--file <path>] [--top <module>]
  vivado status
  vivado report timing|utilization|drc [--run synth_1|impl_1]
  vivado run [--run synth_1|impl_1] [--jobs <n>]
  task start lint [lint options]
  task list|status|logs|cancel [task-id]

Context: --workspace <dir> --config <json> --project <xpr|json>
         --fileset <name> --file <path> --top <module>
Tool:    --iverilog <bin-dir|exe> --cygwin <bin-dir> --standard <standard>
         --vivado <bin-dir|root|vivado.bat> --max-paths <n>
         --include <dir> (repeatable) --define <name[=value]> (repeatable)
         --timeout <milliseconds>
Paging:  --offset <n> --limit <n> --log-index <n>
Output:  JSON on stdout; --help and --version return text.
Node.js >=22. The existing Rust formatter CLI remains available in bin/.
`;
function argumentsFor(argv) {
    const strings=['workspace','config','project','fileset','file','top','iverilog','cygwin','vivado','standard','run','timeout','offset','limit','log-index','max-paths','jobs'];
    const options=Object.fromEntries(strings.map(name=>[name,{type:'string'}]));
    for(const name of ['help','version','json','write','check']) options[name]={type:'boolean'};
    options.include={type:'string',multiple:true}; options.define={type:'string',multiple:true};
    let parsed;
    try { parsed=parseArgs({args:argv,options,allowPositionals:true,strict:true}); }
    catch(error) { fail('INVALID_ARGUMENT',error.message); }
    const input={...parsed.values};
    for(const [from,to] of [['timeout','timeoutMs'],['log-index','logIndex'],['max-paths','maxPaths'],['jobs','jobs']]) if(input[from]!==undefined) {input[to]=input[from]; delete input[from];}
    for(const field of ['timeoutMs','offset','limit','logIndex','maxPaths','jobs']) if(input[field]!==undefined) {
        if(!/^\d+$/.test(input[field]) || !Number.isSafeInteger(Number(input[field]))) fail('INVALID_ARGUMENT',field+'必须为非负整数');
        input[field]=Number(input[field]);
    }
    if(input.include) {input.includeDirs=input.include;delete input.include;}
    if(input.define) {input.defines=input.define;delete input.define;}
    return {input,positionals:parsed.positionals};
}
async function run(argv) {
    let operation='cli';
    try {
        const {input,positionals}=argumentsFor(argv);
        if(input.help || !positionals.length && !input.version) return {text:help,exitCode:0};
        if(input.version) return {text:require('../../package.json').version+' (headless API 1)\n',exitCode:0};
        const [command,action,id,...extra]=positionals; let output;
        if(extra.length) fail('INVALID_ARGUMENT','位置参数过多');
        if(command!=='format' && (input.write || input.check)) fail('INVALID_ARGUMENT','--write与--check仅用于format');
        operation=command==='project' || command==='task'?command+'.'+action:command;
        if(command==='doctor' && !action) output=await services.doctor(input);
        else if(command==='project' && !id && ['list','inspect'].includes(action)) output=await services[action==='list'?'projects':'inspect'](input);
        else if(command==='format' && !action) output=await services.format(input);
        else if(command==='vivado' && action==='status' && !id) output=await vivado.status(input);
        else if(command==='vivado' && action==='report' && ['timing','utilization','drc'].includes(id)) output=await vivado.report({...input,kind:id});
        else if(command==='vivado' && action==='run' && !id) output=await tasks.start({...input,operation:'vivado.run'});
        else if(command==='lint' && !action) {
            const controller=new AbortController(), cancel=()=>controller.abort();
            process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
            try { output=await services.lint(input,{signal:controller.signal}); }
            finally {process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
        } else if(command==='task' && action==='start' && id==='lint') output=await tasks.start(input);
        else if(command==='task' && action==='list' && !id) output=await tasks.list(input);
        else if(command==='task' && ['status','logs','cancel'].includes(action) && id) output=await tasks[action](input,id);
        else fail('INVALID_ARGUMENT','未知命令或参数，请使用--help');
        return {output,exitCode:output.status==='success'?0:output.status==='cancelled'?3:1};
    } catch(error) { return {output:failure(operation,error),exitCode:error.exitCode || 2}; }
}
if(require.main===module) run(process.argv.slice(2)).then(({output,text,exitCode})=>{
    process.stdout.write(text || JSON.stringify(output)+'\n');process.exitCode=exitCode;
});
module.exports={run,argumentsFor};
