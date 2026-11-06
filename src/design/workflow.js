'use strict';
const path=require('node:path'),fs=require('node:fs/promises');
const {result,fail}=require('../agent/protocol');
const {readOptions}=require('../agent/context');
const contract=require('./workflow-contract'),files=require('./workflow-files'),evidence=require('./workflow-evidence');
const DEFAULT_PLAN='svtools.design.json';
function planName(input){const name=input.plan||DEFAULT_PLAN;contract.relative(name,'计划文件');if(!name.endsWith('.json'))fail('INVALID_ARGUMENT','计划文件必须使用.json后缀');return name;}
async function load(input){const{options}=await readOptions(input),root=options.workspace,planFile=planName(input);let raw;
    const planRef=await files.fingerprint(root,planFile).catch(error=>{if(error.code==='ENOENT')fail('PLAN_NOT_FOUND','工程尚无架构计划',{plan:planFile});throw error;});
    try{raw=await files.json(root,planFile);}catch(error){if(error.code==='ENOENT')fail('PLAN_NOT_FOUND','工程尚无架构计划',{plan:planFile});throw error;}
    if(!raw.id)fail('INVALID_RECORD','已保存计划缺少稳定架构ID');
    if((await files.fingerprint(root,planFile)).sha256!==planRef.sha256)fail('SOURCE_CHANGED','读取期间架构计划变化');
    const plan=contract.normalize(raw),state=await files.readState(root,plan,planFile);
    return{root,planFile,plan,planRef,state};}
async function createPlan(input){
    const{options}=await readOptions(input),root=options.workspace,planFile=planName(input);
    if(!input.spec)fail('INVALID_ARGUMENT','design plan 需要 --spec');
    let spec;if(typeof input.spec==='string'&&input.spec.trim().startsWith('{')){try{spec=JSON.parse(input.spec);}catch{fail('INVALID_ARGUMENT','规格不是有效JSON');}}
    else spec=await files.json(root,input.spec);
    const plan=contract.normalize(spec,{dir:input.dir||'rtl'}),markdownFile=planFile.replace(/\.json$/,'.md');
    await files.safePath(root,planFile,{missing:true});await files.safePath(root,markdownFile,{missing:true});
    for(const file of [planFile,markdownFile]){try{await fs.lstat(path.resolve(root,file));fail('PLAN_EXISTS','计划或报告已存在，不覆盖',{file});}catch(error){if(error.code!=='ENOENT')throw error;}}
    const text=JSON.stringify(plan,null,2)+'\n';let made=false;
    try{await files.create(root,planFile,text);made=true;await files.create(root,markdownFile,contract.markdown(plan));}
    catch(error){if(made){const actual=await fs.readFile(path.resolve(root,planFile),'utf8');if(actual===text)await fs.unlink(path.resolve(root,planFile));}throw error;}
    return result('design.plan',{plan,planFile,report:markdownFile,revision:0},null,[],[{kind:'plan',path:path.resolve(root,planFile)},{kind:'report',path:path.resolve(root,markdownFile)}]);
}
function record(state,id){return Object.hasOwn(state.modules,id)?state.modules[id]:{stage:'planned'};}
const currentCandidates=new WeakMap();
function candidateCurrent(ctx,module,item){
    let memo=currentCandidates.get(ctx);if(!memo){memo=new Map();currentCandidates.set(ctx,memo);}
    if(!memo.has(module.id))memo.set(module.id,computeCandidateCurrent(ctx,module,item));
    return memo.get(module.id);
}
async function computeCandidateCurrent(ctx,module,item){
    if(!item.candidate||item.candidate.contractHash!==contract.contractHash(ctx.plan,module)||!await files.unchanged(ctx.root,item.candidate.inputs)||!await files.artifactCurrent(ctx.root,item.candidate.report))return false;
    for(const dependency of module.dependencies){
        const target=ctx.plan.modules.find(other=>other.id===dependency.module),saved=record(ctx.state,dependency.module);
        if(item.candidate.dependencies?.[dependency.module]!==saved.candidate?.id||!await candidateCurrent(ctx,target,saved))return false;
        if(dependency.gate==='accepted'&&(saved.stage!=='accepted'||!saved.verification?.valid||!await evidenceCurrent(ctx,saved)))return false;
    }
    return true;
}
async function evidenceCurrent(ctx,item){if(!item.verification)return false;if(!await files.unchanged(ctx.root,item.verification.inputs))return false;for(const artifact of item.verification.artifacts)if(!await files.artifactCurrent(ctx.root,artifact))return false;return true;}
async function progressFrom(ctx){
    const modules=[];
    for(const module of ctx.plan.modules){const item=record(ctx.state,module.id),current=await candidateCurrent(ctx,module,item),verified=current&&await evidenceCurrent(ctx,item);
        const stage=item.stage||'planned';
        const verification=!item.verification?'not_run':!verified?'stale':!item.verification.valid?'failed':stage==='accepted'?'accepted':'submitted';
        modules.push({...module,stage,designCurrent:current,verification,candidateId:item.candidate?.id||null,owner:item.claim?{actor:item.claim.actor,role:item.claim.role}:null,
            designActor:item.designActor||null,verificationActor:item.verificationActor||null,reviewActor:item.reviewActor||null,
            independentActors:Boolean(item.designActor&&item.verificationActor&&item.designActor!==item.verificationActor),reason:item.reason||item.verification?.issues?.map(issue=>issue.message).join('；')||'',
            artifacts:[...(item.candidate?.report?[item.candidate.report]:[]),...(item.verification?.artifacts||[])].map(({path,sha256})=>({path,sha256})),
            candidateInputs:item.candidate?.inputs?.map(({path,sha256})=>({path,sha256}))||[]});
    }
    const map=new Map(modules.map(module=>[module.id,module]));
    for(const module of modules){module.blockedBy=module.dependencies.filter(dep=>{const target=map.get(dep.module);return dep.gate==='submitted'?!target.designCurrent:target.verification!=='accepted';}).map(dep=>dep.module);}
    return {planId:ctx.plan.id,title:ctx.plan.title,top:ctx.plan.top,planFile:ctx.planFile,revision:ctx.state.revision,root:ctx.root,modules,
        summary:{total:modules.length,designSubmitted:modules.filter(module=>module.designCurrent).length,accepted:modules.filter(module=>module.verification==='accepted').length,
            stale:modules.filter(module=>(module.candidateId&&!module.designCurrent)||module.verification==='stale').length,active:modules.filter(module=>module.owner).length,blocked:modules.filter(module=>module.blockedBy.length).length},
        scope:'current-workspace',evidenceTrust:'local-artifact-validation',history:(ctx.state.history||[]).slice(-100)};
}
async function planReport(input){
    const ctx=await load(input),file=input.out||ctx.planFile.replace(/\.json$/,'.md');contract.relative(file,'架构报告');
    if(!file.endsWith('.md'))fail('INVALID_ARGUMENT','架构报告需要 .md 后缀');
    const destination=await files.safePath(ctx.root,file,{missing:true});
    if(input.force){
        if(file!==ctx.planFile.replace(/\.json$/,'.md'))fail('INVALID_ARGUMENT','--force 仅允许更新计划的同名 Markdown 报告');
        const handle=await fs.open(destination,'r+');try{const stat=await handle.stat();if(!stat.isFile())fail('INVALID_PATH','报告不是普通文件');await handle.writeFile(contract.markdown(ctx.plan));await handle.truncate(Buffer.byteLength(contract.markdown(ctx.plan)));}finally{await handle.close();}
    }else await files.create(ctx.root,file,contract.markdown(ctx.plan));
    return result('design.plan-report',{planFile:ctx.planFile,report:file},null,[],[{kind:'report',path:destination}]);
}
async function tasks(input){return result('design.tasks',await progressFrom(await load(input)));}
async function mutate(action,input){
    const ctx=await load(input),module=ctx.plan.modules.find(item=>item.id===input.module);
    if(!module)fail('INVALID_ARGUMENT','需要当前计划中的 --module');
    const actor=contract.text(input.actor,'--actor',128);
    const saved=await files.transaction(ctx.root,ctx.plan,ctx.planFile,input.revision,async state=>{
        const live={...ctx,state},item=structuredClone(record(state,module.id));
        if(['claim','submit','review'].includes(action)){
            const entry=(await progressFrom(live)).modules.find(entry=>entry.id===module.id);
            if(entry.blockedBy.length)fail('TASK_BLOCKED','先完成任务依赖',{blockedBy:entry.blockedBy});
        }
        if(action==='claim'){
            if(!['design','verification'].includes(input.role))fail('INVALID_ARGUMENT','--role 必须为 design|verification');
            if(item.claim)fail('TASK_CLAIMED','任务已被领取',{owner:item.claim.actor});
                        const overlap=ctx.plan.modules.find(other=>other.id!==module.id&&record(state,other.id).claim&&(input.role==='design'||record(state,other.id).claim.role==='design')&&other.sources.some(source=>module.sources.some(file=>(process.platform==='win32'?file.toLowerCase():file)===(process.platform==='win32'?source.toLowerCase():source))));
            if(overlap)fail('TASK_BLOCKED','其他任务正在使用共享源码',{module:overlap.id});
            if(input.role==='verification'&&!await candidateCurrent(live,module,item))fail('EVIDENCE_STALE','先提交当前设计候选');
            item.claim={actor,role:input.role,token:files.randomUUID()};item.stage=input.role==='design'?'designing':'verifying';item.reason='';
        }else if(action==='submit'){
            if(!item.claim||item.claim.token!==input.token||item.claim.actor!==actor)fail('CLAIM_INVALID','领取令牌或负责人不匹配');
            if(item.claim.role==='design'){
                const inputs=await files.snapshot(ctx.root,module.sources),report=await files.fingerprint(ctx.root,contract.relative(input.evidence,'设计说明'));
                item.candidate={id:'candidate:'+contract.hash({contract:contract.contractHash(ctx.plan,module),inputs:inputs.map(({path,sha256})=>({path,sha256})),report:report.sha256,dependencies:module.dependencies.map(dep=>[dep.module,record(state,dep.module).candidate?.id])}),contractHash:contract.contractHash(ctx.plan,module),inputs,report,dependencies:Object.fromEntries(module.dependencies.map(dep=>[dep.module,record(state,dep.module).candidate?.id]))};
                item.designActor=actor;item.stage='design-submitted';delete item.verification;delete item.reviewActor;
            }else{
                if(!await candidateCurrent(live,module,item))fail('EVIDENCE_STALE','设计候选已变化');
                const checked=await evidence.inspect(ctx.root,ctx.plan,module,item.candidate,contract.relative(input.evidence,'验证证据'));
                item.verification={...checked,candidateId:item.candidate.id};item.verificationActor=actor;item.stage=checked.valid?'verification-submitted':'verification-failed';
            }
            delete item.claim;
        }else if(action==='return'){
            item.reason=contract.text(input.reason,'--reason');item.stage='returned';delete item.claim;delete item.verification;delete item.reviewActor;
        }else if(action==='review'){
            if(item.stage!=='verification-submitted'||!item.verification)fail('INVALID_ARGUMENT','尚无待核验的验证提交');
            if(!await candidateCurrent(live,module,item)||!await evidenceCurrent(live,item))fail('EVIDENCE_STALE','候选或证据已过期');
            const checked=await evidence.inspect(ctx.root,ctx.plan,module,item.candidate,item.verification.evidenceRef.path);
            if(!checked.valid)fail('EVIDENCE_INVALID','核验未通过',{issues:checked.issues});
            item.verification={...checked,candidateId:item.candidate.id};item.reviewActor=actor;item.reason=contract.text(input.reason,'核验结论 --reason');item.stage='accepted';
        }else fail('INVALID_ARGUMENT','未知交接动作');
        if((await files.fingerprint(ctx.root,ctx.planFile)).sha256!==ctx.planRef.sha256)fail('STATE_CONFLICT','交接期间架构计划已变化');
        const previous=record(state,module.id),evidenceRef=item.verification?.evidenceRef||previous.verification?.evidenceRef||item.candidate?.report;
        state.modules[module.id]=item;
        state.history.push({evidence:evidenceRef?{path:evidenceRef.path,sha256:evidenceRef.sha256}:null,revision:state.revision+1,module:module.id,action,actor,at:new Date().toISOString(),candidateId:item.candidate?.id||null,reason:input.reason||null});
        if(state.history.length>1000){state.history=state.history.slice(-1000);state.historyTruncated=true;}
        return item.claim?{token:item.claim.token}:{};
    });
    const data=await progressFrom({...ctx,state:saved.state});return result('design.'+action,{...data,...saved.value});
}
async function checkEvidence(input){const ctx=await load(input),module=ctx.plan.modules.find(item=>item.id===input.module),item=module&&record(ctx.state,module.id);
    if(!module||!await candidateCurrent(ctx,module,item))fail('EVIDENCE_STALE','需要当前模块候选');
    const checked=await evidence.inspect(ctx.root,ctx.plan,module,item.candidate,contract.relative(input.evidence,'证据文件'));
    const response=result('design.evidence',checked);if(!checked.valid)response.status='failed';return response;}
module.exports={createPlan,planReport,tasks,mutate,checkEvidence,load,progressFrom,DEFAULT_PLAN};
