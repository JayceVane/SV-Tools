'use strict';
const files=require('./workflow-files');
const {relative,list,id}=require('./workflow-contract');
const {fail}=require('../agent/protocol');
function sameInputs(left,right){return JSON.stringify((left||[]).map(item=>[item.path,item.sha256]).sort())===JSON.stringify((right||[]).map(item=>[item.path,item.sha256]).sort());}
/** 检查本地提交的证据完整性与当前性；不把文件校验当成独立功能证明。 */
async function inspect(root,plan,module,candidate,evidencePath){
    const evidenceRef=await files.fingerprint(root,evidencePath),data=await files.json(root,evidencePath);
    const issues=[],artifacts=[evidenceRef],reports=new Map();
    if(data.schemaVersion!==1||data.planId!==plan.id||data.moduleId!==module.id||data.candidateId!==candidate.id)fail('EVIDENCE_INVALID','证据不属于当前架构、模块或候选版本');
    if(!sameInputs(data.inputs,candidate.inputs))fail('EVIDENCE_INVALID','证据输入快照与设计候选不一致');
    const verificationInputs=list(data.verificationInputs,'verificationInputs',256);
    if(!verificationInputs.length)fail('EVIDENCE_INVALID','需要 TB/参考模型等验证输入快照');
    const allInputs=[...candidate.inputs,...verificationInputs];
    const key=value=>process.platform==='win32'?value.toLowerCase():value;
    if(new Set(allInputs.map(item=>key(item.path))).size!==allInputs.length)fail('EVIDENCE_INVALID','验证输入必须独立于设计输入且不重复');
    for(const input of verificationInputs){relative(input.path,'验证输入');if(!/^[a-f0-9]{64}$/.test(input.sha256||''))fail('EVIDENCE_INVALID','验证输入缺少 SHA-256');}
    if(!await files.unchanged(root,allInputs))fail('EVIDENCE_STALE','设计或验证输入已改变');
    const rows=list(data.checks,'checks',32),seen=new Set();
    async function artifact(ref){
        if(!ref||typeof ref.path!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256||''))fail('EVIDENCE_INVALID','产物必须含相对路径和 SHA-256');
        relative(ref.path,'证据产物');const current=await files.fingerprint(root,ref.path,files.MAX_ARTIFACT);
        if(current.sha256!==ref.sha256)fail('EVIDENCE_STALE','产物内容已变化',{file:ref.path});artifacts.push(current);return current;
    }
    for(const row of rows){
        if(seen.has(row.id)||!module.checks.includes(row.id))fail('EVIDENCE_INVALID','检查项重复或未在计划中声明');seen.add(row.id);
        if(row.status!=='passed')issues.push({check:row.id,message:'检查尚未通过：'+String(row.status)});
        if(!Array.isArray(row.command)||!row.command.length||row.command.some(value=>typeof value!=='string')||typeof row.toolVersion!=='string'||!row.toolVersion.trim())fail('EVIDENCE_INVALID','检查需提供命令参数和工具版本');
        await artifact(row.report);const report=await files.json(root,row.report.path);reports.set(row.id,report);
        if(['compile','simulation'].includes(row.id)){
            await artifact(row.log);
            if(report.schemaVersion!==1||report.kind!==row.id||report.candidateId!==candidate.id||!sameInputs(report.inputs,allInputs))fail('EVIDENCE_INVALID','运行报告类型、候选或输入身份不一致');
            if(report.status!=='passed'||report.exitCode!==0||report.completed!==true)issues.push({check:row.id,message:'运行未成功完成'});
            if(row.id==='simulation'){
                const cases=list(report.cases,'cases',10000),covered=new Set();
                if(!cases.length)issues.push({check:row.id,message:'没有功能用例结果'});
                const caseIds=new Set();
                for(const item of cases){id(item.id,'用例ID');if(caseIds.has(item.id))fail('EVIDENCE_INVALID','用例ID重复');caseIds.add(item.id);
                    const refs=list(item.requirements,'用例需求');if(!refs.length||refs.some(req=>!module.requirements.includes(req)))fail('EVIDENCE_INVALID','用例需要关联当前模块需求');
                    if(item.status!=='passed'||typeof item.oracle!=='string'||!item.oracle.trim())issues.push({check:row.id,message:'用例未通过或缺少独立期望：'+item.id});
                    for(const req of item.requirements||[])if(module.requirements.includes(req))covered.add(req);}
                for(const req of module.requirements)if(!covered.has(req))issues.push({check:row.id,message:'需求缺少功能用例：'+req});
            }
        }else if(row.id==='delta-cycle'){
            if(report.operation!=='wave.glitches'||report.status!=='success'||!report.data?.complete||report.data?.truncated)issues.push({check:row.id,message:'ΔCycle 查询未完整成功'});
            const waveform=await artifact(row.waveform);
            if(report.data?.evidence?.waveformSha256!==waveform.sha256)issues.push({check:row.id,message:'ΔCycle 证据与波形不一致'});
            const {nativeApi,call}=require('../waveform/rust-backend');
            const opened=call(()=>nativeApi().waveSessionOpen(require('node:path').resolve(root,waveform.path)));
            try{
                const end=String(opened.meta.endTime),expectedEnd=module.deltaWindow.to==='end'?end:module.deltaWindow.to;
                if(report.data?.from!==module.deltaWindow.from||report.data?.to!==expectedEnd||Number(expectedEnd)>Number(end))issues.push({check:row.id,message:'ΔCycle 时间范围未覆盖计划窗口'});
                for(const signal of module.deltaSignals){const variable=opened.meta.vars.find(item=>item.path===signal);
                    if(!variable||!report.data?.series?.some(item=>opened.meta.vars.some(alias=>alias.path===item.path&&alias.id===variable.id)&&item.complete))issues.push({check:row.id,message:'ΔCycle 缺少计划信号：'+signal});}
            }finally{nativeApi().waveSessionClose(opened.handle);}
            const series=report.data?.series;
            if(!Array.isArray(series)||!series.length||series.some(item=>!item.complete))issues.push({check:row.id,message:'ΔCycle 信号/扫描信息不完整'});
            const dispositions=Array.isArray(row.dispositions)?row.dispositions:[];
            for(const signal of series||[])for(const finding of signal.findings||[]){
                const disposition=dispositions.find(item=>item.signal===signal.path&&item.t===finding.t);
                if(!disposition||disposition.status!=='resolved'||typeof disposition.reason!=='string'||!disposition.reason.trim())issues.push({check:row.id,message:'同刻活动尚未处置：'+signal.path+' @ '+finding.t});
                if(finding.sequenceTruncated)issues.push({check:row.id,message:'同刻变化序列被截断：'+signal.path+' @ '+finding.t});
            }
        }else if(report.status!=='passed')issues.push({check:row.id,message:'附加检查未通过'});
    }
    for(const check of module.checks)if(!seen.has(check))issues.push({check,message:'缺少必需检查'});
    const simulation=reports.get('simulation'),delta=rows.find(row=>row.id==='delta-cycle');
    if(!simulation?.waveforms?.some(item=>item.path===delta?.waveform?.path&&item.sha256===delta?.waveform?.sha256))issues.push({check:'delta-cycle',message:'仿真报告未绑定被检查的波形'});
    if(!await files.unchanged(root,allInputs))fail('EVIDENCE_STALE','核验期间输入变化');
    for(const item of artifacts)if(!await files.artifactCurrent(root,item))fail('EVIDENCE_STALE','核验期间产物变化');
    return {valid:!issues.length,issues,inputs:allInputs,artifacts,evidenceRef,scope:'local-artifact-validation',functionalProof:false,recordingCompleteness:'unknown',checkCount:seen.size};
}
module.exports={inspect,sameInputs};
