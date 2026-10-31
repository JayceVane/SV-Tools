'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { location } = require('./tasks');
const { readJson, writeJson } = require('./storage');
const { lint } = require('./operations');
const { failure } = require('./protocol');
const { acquireWorkspaceLease } = require('../toolchains/workspace-lease');

async function main(workspace,id) {
    const {folder,options}=await location({workspace},id);
    const release=await acquireWorkspaceLease(options.workspace,'task-'+id,{waitMs:0});
    const controller=new AbortController();
    let state=await readJson(path.join(folder,'status.json')), publishing=Promise.resolve(), timer, polling=false;
    function publish(update) {
        state={...state,...update,updatedAt:new Date().toISOString()}; const snapshot=state;
        publishing=publishing.then(()=>writeJson(path.join(folder,'status.json'),snapshot)); return publishing;
    }
    const stop=()=>controller.abort();
    process.once('SIGINT',stop); process.once('SIGTERM',stop);
    async function poll() {
        if(polling) return; polling=true;
        try { if(await fs.stat(path.join(folder,'cancel.json')).catch(error=>{if(error.code!=='ENOENT') throw error;})) stop(); }
        catch(error) { controller.abort(error); }
        finally { polling=false; }
    }
    try {
        const request=await readJson(path.join(folder,'request.json'));
        if(request.operation!=='lint') throw new Error('后台操作未注册');
        await publish({state:'running',pid:process.pid}); await poll();
        timer=setInterval(poll,100);
        let output;
        try { output=await lint(request.options,{signal:controller.signal,onContext:context=>publish({context}),
            onArtifacts:artifacts=>{publish({artifacts}).catch(stop);}}); }
        catch(error) { output=failure('lint',error); }
        clearInterval(timer);
        await writeJson(path.join(folder,'result.json'),output);
        await publish({state:output.status==='success'?'succeeded':output.status==='cancelled'?'cancelled':'failed',finishedAt:new Date().toISOString(),artifacts:output.artifacts});
    } finally {
        clearInterval(timer); process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);
        await publishing; await release();
    }
}
if(require.main===module) main(process.argv[2],process.argv[3]).catch(error=>{console.error(error.message);process.exitCode=2;});
module.exports={main};
