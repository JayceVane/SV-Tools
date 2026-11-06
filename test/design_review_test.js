'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildRenderProjection, defaultFileName, layoutArchitecture, renderArchitectureSvg } = require('../src/design/svg');
const { validateSpec } = require('../src/design/scaffold');
const { buildArchitecture } = require('../src/design/arch');

test('完整端口模式的每条连线都连接自己的真实端口，不借用代表端口', () => {
    const nodes = ['a','b'].map(name => ({ id:'instance:'+name, kind:'instance', label:name, name, module:name,
        implementation:'blackbox', ports:['req','rsp'].map(p => ({name:p,width:8,direction:(name==='a')===(p==='req')?'output':'input'})) }));
    const edges = [
        {sourceNode:'instance:a',sourcePort:'req',targetNode:'instance:b',targetPort:'req',width:8,netNames:['req']},
        {sourceNode:'instance:b',sourcePort:'rsp',targetNode:'instance:a',targetPort:'rsp',width:8,netNames:['rsp']}
    ];
    const arch = {graph:{nodes,edges},interfaces:[{id:'pair',from:{kind:'instance',name:'a'},to:{kind:'instance',name:'b'},
        direction:'bidirectional',bits:16,label:'link',signals:[{name:'req',width:8},{name:'rsp',width:8}],fromPorts:['req','rsp'],toPorts:['req','rsp']}]};
    const projection = buildRenderProjection(arch);
    assert.deepEqual(projection.edges.map(edge => [edge.sources[0],edge.targets[0]]).sort(), [
        ['instance:a/req','instance:b/req'],['instance:b/rsp','instance:a/rsp']]);
});

function spec() {
    return {schemaVersion:1,interfaces:[{type:'request',members:[{name:'payload',width:8}]}],buses:[{name:'req',type:'request'}],
        modules:[{name:'producer',ports:[{name:'m_req',type:'request',role:'master',direction:'output'}]},
            {name:'consumer',ports:[{name:'s_req',type:'request',role:'slave',direction:'input'}]}],
        top:{name:'system_top',instances:[{name:'u_a',module:'producer',connections:{m_req:'req'}},
            {name:'u_b',module:'consumer',connections:{s_req:'req'}}]}};
}

test('骨架端口必须显式指定方向，不能把省略方向静默生成为input', () => {
    const input=spec(); delete input.modules[0].ports[0].direction;
    assert.throws(()=>validateSpec(input),{code:'INVALID_ARGUMENT'});
});

test('骨架连接遗漏与多驱动在写文件前返回错误', () => {
    const missing=spec(); missing.top.instances[1].connections={};
    assert.throws(()=>validateSpec(missing),{code:'INVALID_ARGUMENT'});
    const driven=spec(); driven.modules[1].ports[0].direction='output';
    assert.throws(()=>validateSpec(driven),{code:'INVALID_ARGUMENT'});
});

test('架构模型使用已捕获的源码文本，不能读取另一版磁盘源码再绑定旧哈希', async t => {
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-arch-input-')));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const file=path.join(directory,'top.sv');
    const text='module child(output [7:0] data); endmodule module top(output [7:0] data); child u(.data(data)); endmodule';
    await fs.writeFile(file,text.replaceAll('[7:0]','[3:0]'));
    const arch=await buildArchitecture({workspace:directory,files:[{path:file,text}],top:'top'});
    assert.equal(arch.instances[0].ports[0].width,8);
});

test('架构 include 使用已捕获内容，来源映射回原文件', async t => {
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-arch-include-')));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const file=path.join(directory,'top.sv'), header=path.join(directory,'width.svh');
    const text='`include "width.svh"\nmodule child(output [`WIDTH-1:0] data); endmodule module top(output [`WIDTH-1:0] data); child u(.data(data)); endmodule';
    await fs.writeFile(file,text); await fs.writeFile(header,'`define WIDTH 4\n');
    const arch=await buildArchitecture({workspace:directory,files:[{path:file,text},{path:header,text:'`define WIDTH 8\n'}],top:'top'});
    assert.equal(arch.instances[0].ports[0].width,8);
    assert.equal(arch.top.file,'top.sv');
});

test('不同渲染选项拥有不同产物名，避免完整端口图和折叠图相互覆盖', () => {
    const arch={top:{name:'top'},archSha256:'12345678'};
    assert.notEqual(defaultFileName(arch),defaultFileName(arch,'document',{bundle:true}));
    assert.notEqual(defaultFileName(arch),defaultFileName(arch,'document',{title:'标题'}));
});

test('骨架显式悬空与反向响应均保留真实方向，不以master等同output', () => {
    const input=spec(); input.modules[0].ports.push({name:'m_unused',type:'request',role:'master',direction:'input'});
    input.top.instances[0].connections.m_unused=null;
    const model=validateSpec(input);
    assert.equal(model.modules[0].ports[1].direction,'input');
    assert.equal(model.suggestions[0].code,'UNCONNECTED_PORT');
});

test('同接口边界端口合成表格，逐行保留方向、宽度和真实连线锚点', () => {
    const ports=[['ddr_addr',14,'output'],['ddr_ba',3,'output'],['ddr_dq',16,'input'],['irq',1,'output'],['clk_a',1,'input'],['clk_b',1,'input']];
    const boundaries=ports.map(([name,width,direction])=>({id:'boundary:'+name,kind:'boundary',name,direction,
        ports:[{name,width,direction:direction==='input'?'output':'input'}]}));
    const instance={id:'instance:u_mem',kind:'instance',name:'u_mem',label:'u_mem',module:'mem',implementation:'blackbox',
        ports:ports.map(([name,width,direction])=>({name,width,direction}))};
    const edges=ports.map(([name,width,direction])=>direction==='output'
        ? {sourceNode:instance.id,sourcePort:name,targetNode:'boundary:'+name,targetPort:name,width,netNames:[name]}
        : {sourceNode:'boundary:'+name,sourcePort:name,targetNode:instance.id,targetPort:name,width,netNames:[name]});
    const arch={graph:{nodes:[...boundaries,instance],edges},interfaces:[]};
    const before=JSON.stringify(arch), projection=buildRenderProjection(arch,{detail:'signals'});
    const table=projection.nodes.find(node=>node.boundaryTable);
    assert.ok(table); assert.equal(table.name,'ddr');
    assert.deepEqual(table.ports.map(port=>[port.label,port.bitWidth,port.boundaryDirection]),ports.slice(0,3));
    assert.equal(projection.stats.boundaryTables,1);
    assert.equal(projection.stats.ports,projection.stats.fullPorts);
    for (const name of ['irq','clk_a','clk_b']) assert.ok(projection.nodes.some(node=>node.id==='boundary:'+name));
    assert.ok(projection.edges.some(edge=>edge.targets[0]==='boundary:ddr_addr/ddr_addr'));
    assert.ok(projection.edges.some(edge=>edge.sources[0]==='boundary:ddr_dq/ddr_dq'));
    assert.equal(JSON.stringify(arch),before,'展示分组不改领域模型');
});

test('DDR 接口表端到端保留双向DQ行和其余独立引脚', async t => {
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-ddr-table-')));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const file=path.join(directory,'ddr_top.sv');
    await fs.copyFile(path.join(__dirname,'fixtures/design/boundary-table/ddr_top.sv'),file);
    const arch=await buildArchitecture({workspace:directory,files:[{path:file,text:await fs.readFile(file,'utf8')}],top:'ddr_top'});
    const result=await layoutArchitecture(arch,{detail:'signals'}), table=result.layout.nodes.find(node=>node.boundaryTable);
    assert.ok(table); assert.equal(table.ports.length,6); assert.equal(table.bitWidth,36);
    assert.equal(table.ports.find(port=>port.label==='ddr_dq').boundaryDirection,'inout');
    const dq=result.layout.edges.filter(edge=>edge.interface.signals.some(signal=>signal.name==='ddr_dq'));
    assert.equal(dq.length,1); assert.equal(dq[0].bidirectional,true);
    assert.ok(dq[0].sources.includes('boundary:ddr_dq/ddr_dq'));
    assert.ok(dq[0].targets.includes('instance:u_ddr/ddr_dq'));
    assert.equal(result.layout.nodes.find(node=>node.id==='instance:u_ddr').ports.find(port=>port.label==='ddr_dq').side,'EAST');
    assert.equal(dq[0].interface.label,'ddr_dq');
    const image=renderArchitectureSvg(arch,result);
    assert.equal(image.evidence.export.boundaryTableCount,1);
    for (const label of ['Signal','Dir','Bits','io','o','ddr_addr','ddr_dq']) assert.ok(image.svg.includes('>'+label+'</text>'),label);
    assert.ok(image.svg.includes('data-boundary-id="boundary:ddr_dq"'));
    assert.ok(image.svg.includes('>ddr_addr[14]</text>'), '单侧名称按实际列宽显示，不因对半分栏而过早截断');
    const second=renderArchitectureSvg(arch,await layoutArchitecture(arch,{detail:'signals'}));
    assert.equal(second.sha256,image.sha256);
});

test('虚拟请求和响应面对同一侧但保持相反的真实方向', () => {
    const arch={graph:{nodes:[{id:'instance:u',kind:'instance',name:'u',label:'u',module:'logic',implementation:'blackbox',
        ports:[{name:'m_req',direction:'output',width:8},{name:'m_rsp',direction:'input',width:8}]}],edges:[]},interfaces:[]};
    const ports=buildRenderProjection(arch).nodes[0].ports;
    assert.deepEqual(ports.map(port=>[port.label,port.side,port.direction]),[['m_req','EAST','output'],['m_rsp','EAST','input']]);
});

test('顶层inout连接到单向子端口时保留对端方向，不虚构双向驱动', async t => {
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-inout-direction-')));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const file=path.join(directory,'top.sv');
    const text='module pad(input sampled,output driven); endmodule module top(inout io_sampled,inout io_driven); pad u(.sampled(io_sampled),.driven(io_driven)); endmodule';
    await fs.writeFile(file,text);
    const arch=await buildArchitecture({workspace:directory,files:[{path:file,text}],top:'top'});
    const projection=buildRenderProjection(arch,{detail:'signals'});
    assert.equal(projection.edges.length,2);
    assert.ok(projection.edges.every(edge=>!edge.bidirectional));
    assert.ok(projection.edges.some(edge=>edge.sources[0]==='boundary:io_sampled/io_sampled' && edge.targets[0]==='instance:u/sampled'));
    assert.ok(projection.edges.some(edge=>edge.sources[0]==='instance:u/driven' && edge.targets[0]==='boundary:io_driven/io_driven'));
});

test('整体inout struct 接口连接按共享网络保留，不要求拆开请求响应', async t => {
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-virtual-link-')));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const file=path.join(directory,'top.sv');
    const text='typedef struct packed { logic [7:0] request; logic [7:0] response; } link_t; module master(inout link_t m_link); endmodule module slave(inout link_t s_link); endmodule module top; link_t bus; master u_m(.m_link(bus)); slave u_s(.s_link(bus)); endmodule';
    await fs.writeFile(file,text);
    const arch=await buildArchitecture({workspace:directory,files:[{path:file,text}],top:'top'});
    const projection=buildRenderProjection(arch);
    assert.equal(projection.edges.length,1,'一条整体接口连接');
    const edge=projection.edges[0];
    assert.equal(edge.interface.bits,16);
    assert.equal(edge.interface.direction,'connection','共享接口不虚构驱动方向');
    assert.deepEqual([edge.sources[0],edge.targets[0]],['instance:u_m/m_link','instance:u_s/s_link']);
    const image=renderArchitectureSvg(arch,await layoutArchitecture(arch));
    assert.ok(!image.svg.includes('marker-end="url(#arrow)"'),'整体接口线不画电气方向箭头');
});

test('默认接口图中DDR表只有一个外部锚点、一条汇总线，方向箭头留在表内', async t => {
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-ddr-summary-')));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const file=path.join(directory,'ddr_top.sv');
    await fs.copyFile(path.join(__dirname,'fixtures/design/boundary-table/ddr_top.sv'),file);
    const arch=await buildArchitecture({workspace:directory,files:[{path:file,text:await fs.readFile(file,'utf8')}],top:'ddr_top'});
    const result=await layoutArchitecture(arch), table=result.layout.nodes.find(node=>node.boundaryTable);
    assert.equal(table.ports.length,1); assert.equal(table.rows.length,6);
    const links=result.layout.edges.filter(edge=>edge.sources.includes(table.ports[0].id)||edge.targets.includes(table.ports[0].id));
    assert.equal(links.length,1); assert.equal(links[0].interface.bits,36);
    const image=renderArchitectureSvg(arch,result);
    assert.ok(image.svg.includes('>io</text>'), 'inout 行方向缩写'); assert.ok(image.svg.includes('>o</text>'), 'output 行方向缩写');
    const block=image.svg.match(new RegExp('<g data-interface-id="'+links[0].interface.id+'"[\\s\\S]*?</g>'))[0];
    assert.ok(!block.includes('marker-end='));
    assert.equal(arch.graph.nodes.filter(node=>node.kind==='boundary').length,9,'完整事实仍保留在模型');
});

test('共享inout网络连接多个输入时，每个实例均保留接口连接', async t => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-shared-interface-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'top.sv');
    const text = 'module pad(inout [7:0] io); endmodule module sink(input [7:0] m_data); endmodule '
        + 'module top; wire [7:0] bus; pad u_pad(.io(bus)); sink u_a(.m_data(bus)); sink u_b(.m_data(bus)); endmodule';
    await fs.writeFile(file, text);
    const arch = await buildArchitecture({ workspace: directory, files: [{ path: file, text }], top: 'top' });
    const projection = buildRenderProjection(arch);
    assert.equal(arch.interfaces.filter(item => item.direction === 'connection').length, 2);
    const terminals = projection.edges.flatMap(edge => [...edge.sources, ...edge.targets]).filter(id => id.startsWith('instance:'));
    assert.deepEqual(new Set(terminals),
        new Set(['instance:u_pad/io', 'instance:u_a/m_data', 'instance:u_b/m_data']));
    assert.ok(projection.edges.every(edge => edge.interface.direction === 'connection'));
});
