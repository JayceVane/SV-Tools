'use strict';
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

function workspaceFromDirectory(directory) {
    const parts = path.resolve(directory).split(path.sep), index = parts.findIndex(part => part.toLowerCase() === '.svtools');
    return index > 0 ? parts.slice(0,index).join(path.sep) + (index === 1 ? path.sep : '') : null;
}
function bind(name) {
    return new Promise((resolve,reject) => {
        const server = net.createServer(socket => socket.destroy());
        server.once('error',reject);
        server.listen({path:name,exclusive:true},()=>{
            server.removeListener('error',reject); server.unref();
            let released;
            resolve(()=>released ||= new Promise((done,failed)=>server.close(error=>error?failed(error):done())));
        });
    });
}
/** 操作系统拥有的独占IPC端点：进程退出自动释放，不按PID或超时猜测并删除占用。 */
async function acquireWorkspaceLease(workspace, resource, {signal,slots=1,waitMs=30000} = {}) {
    if (!/^[a-z0-9-]{1,100}$/.test(resource)) throw new TypeError('无效资源名称');
    const canonical = await fs.realpath(workspace), owner = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const prefix = process.platform === 'win32' ? '\\\\.\\pipe\\' : process.platform === 'linux' ? '\0' : null;
    if (prefix === null) throw Object.assign(new Error('当前资源协调器仅支持Windows及Linux执行环境'),{code:'UNSUPPORTED_PLATFORM'});
    const started = Date.now();
    while (true) {
        signal?.throwIfAborted();
        for (let slot=0;slot<slots;slot++) {
            const key = createHash('sha256').update(JSON.stringify([os.userInfo().username,owner,resource,slot])).digest('hex').slice(0,40);
            try { return await bind(prefix+'svtools-'+key); }
            catch(error) { if (!['EADDRINUSE','EACCES'].includes(error.code)) throw error; }
        }
        if (Date.now()-started>=waitMs) throw Object.assign(new Error('工作区资源仍被占用'),{code:'RESOURCE_BUSY',details:{resource},exitCode:4});
        await delay(50,undefined,{signal});
    }
}
module.exports = { acquireWorkspaceLease, workspaceFromDirectory };
