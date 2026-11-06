'use strict';
const { randomUUID,createHash }=require('node:crypto');
const { fail }=require('../agent/protocol');
const REQUIRED_CHECKS=['compile','simulation','delta-cycle'];
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const text=(value,label,max=4096)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail('INVALID_ARGUMENT',label+' 必须是非空文本（≤'+max+'字符）');return value.trim();};
const id=(value,label)=>{if(typeof value!=='string'||['__proto__','prototype','constructor'].includes(value)||!/^[-A-Za-z0-9_.:]{1,128}$/.test(value))fail('INVALID_ARGUMENT',label+' 不是有效稳定标识');return value;};
function list(value,label,max=256){if(!Array.isArray(value)||value.length>max)fail('INVALID_ARGUMENT',label+' 必须为数组（≤'+max+'）');return value;}
function relative(value,label){text(value,label,1024);if(value.includes('\\')||value.includes('\0')||value.startsWith('/')||value.includes(':')||value.split('/').some(part=>!part||part==='.'||part==='..')||value.split('/').some(part=>part.toLowerCase()==='.git'||/[. ]$/.test(part)))fail('INVALID_PATH',label+' 必须是工作区内的相对文件路径');return value;}
function normalize(raw,{dir='rtl'}={}) {
    if(!raw||raw.schemaVersion!==1)fail('INVALID_ARGUMENT','架构计划需要 schemaVersion=1');
    // 同一份 scaffold spec 可附 workflow 语义，避免维护两份接口/模块名单。
    const scaffold=raw.workflow;
    if(scaffold) {
        const details=new Map(list(scaffold.modules,'workflow.modules').map(module=>[module.name,module]));
        const top=raw.top?.name;text(top,'top.name');
        raw={...scaffold,schemaVersion:1,top,interfaces:raw.interfaces||[],modules:list(raw.modules,'modules').map(module=>({name:module.name,...details.get(module.name),sources:details.get(module.name)?.sources||[relative(dir+'/'+top+'.sv','scaffold source')]}))};
    }
    const requirements=list(raw.requirements,'requirements').map(item=>({id:id(item.id,'需求ID'),text:text(item.text,'需求内容')}));
    if(!requirements.length||new Set(requirements.map(item=>item.id)).size!==requirements.length)fail('INVALID_ARGUMENT','需求必须非空且ID唯一');
    const requirementIds=new Set(requirements.map(item=>item.id));
    const modules=list(raw.modules,'modules').map(module=>{
        if(!module||typeof module!=='object')fail('INVALID_ARGUMENT','模块必须是对象');
        const sources=list(module.sources,'sources',128).map(file=>relative(file,'source'));
        if(!sources.length||new Set(sources.map(file=>process.platform==='win32'?file.toLowerCase():file)).size!==sources.length)fail('INVALID_ARGUMENT','模块源码清单必须非空且不重复');
        const refs=list(module.requirements,'module.requirements').map(value=>id(value,'需求引用'));
        if(!refs.length||refs.some(ref=>!requirementIds.has(ref)))fail('INVALID_ARGUMENT','模块必须关联已定义需求');
        const checks=module.checks||REQUIRED_CHECKS;
        list(checks,'checks',32).forEach(value=>id(value,'检查ID'));
        if(new Set(checks).size!==checks.length||REQUIRED_CHECKS.some(check=>!checks.includes(check)))fail('INVALID_ARGUMENT','模块必须包含 compile/simulation/delta-cycle 检查且不能重复');
        const deltaSignals=list(module.deltaSignals,'deltaSignals',256).map(value=>text(value,'ΔCycle 完整信号路径',1024));
        if(!deltaSignals.length||new Set(deltaSignals).size!==deltaSignals.length)fail('INVALID_ARGUMENT','模块必须指定非空、不重复的 ΔCycle 信号清单');
        const deltaWindow=module.deltaWindow||{from:'0',to:'end'};
        if(typeof deltaWindow.from!=='string'||typeof deltaWindow.to!=='string'||!/^\d+$/.test(deltaWindow.from)||!(deltaWindow.to==='end'||/^\d+$/.test(deltaWindow.to))||!Number.isSafeInteger(Number(deltaWindow.from))||(deltaWindow.to!=='end'&&(!Number.isSafeInteger(Number(deltaWindow.to))||Number(deltaWindow.to)<Number(deltaWindow.from))))fail('INVALID_ARGUMENT','deltaWindow 需要有序的整数 tick 字符串，to 可为 end');
        const dependencies=list(module.dependencies||[],'dependencies').map(dependency=>({module:id(dependency.module,'依赖模块'),gate:dependency.gate||'accepted'}));
        if(dependencies.some(dependency=>!['submitted','accepted'].includes(dependency.gate)))fail('INVALID_ARGUMENT','依赖gate必须为submitted或accepted');
        return {id:id(module.id||module.name,'模块ID'),name:text(module.name,'模块名',128),responsibility:text(module.responsibility,'模块职责'),sources,requirements:refs,
            dependencies,checks,deltaSignals,deltaWindow:{from:deltaWindow.from,to:deltaWindow.to},parameters:module.parameters||{},interfaceVersion:text(module.interfaceVersion||'1','接口版本',128)};
    });
    if(!modules.length||new Set(modules.map(module=>module.id)).size!==modules.length)fail('INVALID_ARGUMENT','模块清单必须非空且ID唯一');
    const byId=new Map(modules.map(module=>[module.id,module])),visiting=new Set(),visited=new Set();
    function visit(module){if(visiting.has(module.id))fail('INVALID_ARGUMENT','任务依赖存在环：'+module.id);if(visited.has(module.id))return;visiting.add(module.id);
        for(const dependency of module.dependencies){if(!byId.has(dependency.module))fail('INVALID_ARGUMENT','依赖模块不存在：'+dependency.module);visit(byId.get(dependency.module));}
        visiting.delete(module.id);visited.add(module.id);}
    modules.forEach(visit);
    return {schemaVersion:1,id:id(raw.id||randomUUID(),'架构ID'),title:text(raw.title,'架构标题'),top:text(raw.top,'顶层',128),
        overview:text(raw.overview,'架构说明'),clocks:list(raw.clocks||[],'clocks').map(value=>text(value,'时钟约定')),
        resets:list(raw.resets||[],'resets').map(value=>text(value,'复位约定')),interfaces:list(raw.interfaces||[],'interfaces'),requirements,modules};
}
function contractHash(plan,module){return hash({module,requirements:plan.requirements.filter(item=>module.requirements.includes(item.id)),interfaces:plan.interfaces,clocks:plan.clocks,resets:plan.resets,top:plan.top});}
const escape=value=>String(value).replaceAll('|','\\|').replaceAll('\n',' ');
function markdown(plan){return ['# '+escape(plan.title),'',plan.overview,'','架构ID：`'+plan.id+'`；顶层：`'+plan.top+'`。这是架构计划与交付约定，功能结论另以验证证据判定。','',
    '## 时钟与复位','',...plan.clocks.map(value=>'- 时钟：'+value),...plan.resets.map(value=>'- 复位：'+value),'','## 需求','',...plan.requirements.map(item=>'- **'+item.id+'**：'+item.text),'',
    '## 模块任务清单','','| 模块ID | 模块 | 职责 | 需求 | 源码 | 依赖 | 必需检查 |','| --- | --- | --- | --- | --- | --- | --- |',
    ...plan.modules.map(module=>'| '+[module.id,module.name,module.responsibility,module.requirements.join(', '),module.sources.join(', '),module.dependencies.map(d=>d.module+' / '+d.gate).join(', '),module.checks.join(', ')].map(escape).join(' | ')+' |'),
    '','## ΔCycle 核验范围','',...plan.modules.map(module=>'- '+module.id+'：'+module.deltaSignals.join(', ')+'；ticks '+module.deltaWindow.from+'..'+module.deltaWindow.to),'','## 接口约定','','```json',JSON.stringify(plan.interfaces,null,2),'```','','设计与验证分别提交；源码、接口或证据变化后重新核验。Agent身份是本地协作标签，不是安全认证。',''].join('\n');}
module.exports={normalize,contractHash,markdown,hash,text,id,relative,list,REQUIRED_CHECKS};
