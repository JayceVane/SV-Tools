'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail } = require('./protocol');
async function directory(workspace, ...parts) {
    let current = await fs.realpath(workspace);
    for (const part of ['.svtools','agent',...parts]) {
        if (!/^[\w.-]+$/.test(part) || part === '.' || part === '..') fail('INVALID_PATH','无效的服务目录名称');
        current = path.join(current,part);
        try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH','服务目录不能为链接或普通文件',{path:current});
    }
    return current;
}
/** Windows 上目标文件被读者打开时 rename 会瞬时EPERM/EACCES/EBUSY；有限重试后仍失败才放弃。 */
async function commit(temporary, file) {
    for (let attempt = 1; ; attempt++) {
        try { await fs.rename(temporary, file); return; }
        catch (error) {
            if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
            await new Promise(resolve => setTimeout(resolve, 10 * attempt));
        }
    }
}
async function writeJson(file, value) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'}); await commit(temporary,file); }
    finally { await fs.rm(temporary,{force:true}); }
}
async function readJson(file, maxBytes = 2*1024*1024) {
    if ((await fs.lstat(file)).isSymbolicLink()) fail('UNSAFE_PATH','服务记录不能为链接');
    const handle = await fs.open(file,'r');
    try {
        const stat=await handle.stat();
        if (!stat.isFile() || stat.size>maxBytes) fail('INVALID_RECORD','服务记录超出预算');
        const buffer=Buffer.alloc(stat.size+1), {bytesRead}=await handle.read(buffer,0,buffer.length,0);
        if (bytesRead!==stat.size) fail('RECORD_CHANGED','服务记录读取期间发生变化');
        return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)));
    }
    finally { await handle.close(); }
}
module.exports = { directory, writeJson, readJson };
