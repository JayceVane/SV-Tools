'use strict';
const path=require('node:path');
const workflow=require('../design/workflow');
const {safePath}=require('../design/workflow-files');
/** 页面只接受宿主签发的链接令牌；没有任何任务写入/工具执行入口。 */
async function projectProgress(project,planFile='svtools.design.json'){
    const links=new Map();
    if(!project?.root)return {snapshot:{available:false,message:'选择工程后查看设计进展'},links};
    try{
        const response=await workflow.tasks({workspace:project.root,plan:planFile});const data=response.data;
        const modules=data.modules.map(module=>{
            const entries=[...module.sources.map(file=>({path:file,label:'源码 · '+path.basename(file)})),...module.artifacts.map(file=>({...file,label:'证据 · '+path.basename(file.path)}))];
            const seen=new Set(),references=[];
            for(const entry of entries){if(seen.has(entry.path)||references.length>=24)continue;seen.add(entry.path);const token='progress-link-'+links.size;
                links.set(token,{root:project.root,path:entry.path,projectId:project.id});references.push({id:token,label:entry.label});}
            return {...module,artifacts:undefined,candidateInputs:undefined,references};
        });
        return {snapshot:{...data,modules,history:undefined,root:undefined,available:true,readOnly:true},links};
    }catch(error){return {snapshot:{available:false,message:error.code==='PLAN_NOT_FOUND'?'此工程尚未建立架构计划。使用 design plan --spec 创建模块任务与报告。':error.message,errorCode:error.code||'SERVICE_FAILED'},links};}
}
async function openProgressLink(links,id,project,vscode){const item=links.get(id);if(!item||item.projectId!==project?.id)return;const file=await safePath(item.root,item.path);await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(file));}
module.exports={projectProgress,openProgressLink};
