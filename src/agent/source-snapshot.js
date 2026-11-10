'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { keyOf } = require('../project/model');
const { maskSourceText } = require('../workspace/sources');
const { hash } = require('./context');
const { fail } = require('./protocol');

/** 将本轮输入复制到隔离目录，工具输出映射回原始源码路径。 */
async function snapshotInputs(resolved, runDirectory) {
    const root = path.join(runDirectory,'inputs'), mapped = new Map(), reverse = new Map(), byKey=new Map(), unresolved=new Map();
    const relocate = file => path.join(root,...path.resolve(file).replace(/:/g,'').split(/[\\/]+/).filter(Boolean));
    for (const file of resolved.contents.keys()) { const copy=relocate(file); mapped.set(file,copy); reverse.set(keyOf(copy),file);byKey.set(keyOf(file),copy); }
    const includeDirs=[...new Set([...resolved.context.includeDirs,...resolved.context.files.map(file=>path.dirname(file.path))])];
    for (const [file,{bytes,text}] of resolved.contents) {
        // M1只接受可验证的字面量include；宏include留给后续完整编译上下文适配。
        const masked=maskSourceText(text), chunks=[];let offset=0;
        for(const match of masked.matchAll(/`include\b/g)) {
            const directive=/^`include[ \t]+"([^"\r\n]+)"/.exec(text.slice(match.index));
            if(!directive) fail('UNSUPPORTED_INCLUDE','M1要求include使用双引号字面量',{file});
            const name=directive[1], candidates=path.isAbsolute(name)?[name]:[path.resolve(path.dirname(file),name),...includeDirs.map(dir=>path.resolve(dir,name))];
            // 未收录的include改指向快照内的缺失路径，由编译器判断条件分支是否实际需要它。
            const known=candidates.map(candidate=>byKey.get(keyOf(candidate))).find(Boolean);
            const target=known || path.join(root,'unresolved',hash(name),path.basename(name));
            if(!known) unresolved.set(target,name);
            // include内容不会经过Windows argv路径转换；相对快照根路径兼容Cygwin预处理器。
            chunks.push(text.slice(offset,match.index),'`include "'+path.relative(root,target).replace(/\\/g,'/')+'"');
            offset=match.index+directive[0].length;
        }
        chunks.push(text.slice(offset)); const rewritten=chunks.join('');
        const copy=mapped.get(file); await fs.mkdir(path.dirname(copy),{recursive:true});
        await fs.writeFile(copy,rewritten===text?bytes:rewritten,{flag:'wx'});
    }
    return {root,mapped,reverse,relocate,unresolved};
}
module.exports = { snapshotInputs };
