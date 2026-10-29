'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const S=require('../src/waveform/layout-state');
const {createLayoutFiles}=require('../src/waveform/layout-files');
const {createImageFiles}=require('../src/graphics/image-files');

for(const kind of ['layout','image'])test(kind+'导出不能通过硬链接覆盖原始VCD',async(t)=>{
    const directory=await fs.mkdtemp(path.resolve('bin/audit-export-'));
    t.after(()=>fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
    const original=path.join(directory,'capture.vcd'),target=path.join(directory,kind==='layout'?'alias.json':'alias.svg');
    const text='$timescale 1ns $end\n';await fs.writeFile(original,text);await fs.link(original,target);
    const vscode={workspace:{fs:{async writeFile(uri,bytes){await fs.writeFile(uri.fsPath,bytes);}}}};
    const files=kind==='layout'?createLayoutFiles({vscode,filePath:original}):createImageFiles({vscode,sourcePath:original});
    const payload=kind==='layout'?S.capture({signals:new Map(),selected:[],view:{start:0,span:1},cursorA:0,cursorB:null}):{format:'svg',name:'x',data:'<svg xmlns="http://www.w3.org/2000/svg"></svg>'};
    await assert.rejects(files.save(payload,{scheme:'file',fsPath:target}),/独立|链接/);
    assert.equal(await fs.readFile(original,'utf8'),text);
});
