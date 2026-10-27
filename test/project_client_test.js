'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; }
    setAttribute(key,value) { this.attributes[key]=value; }
    getAttribute(key) { return this.attributes[key]; }
    contains(target) { return this===target || this.children.some(child=>child.contains?.(target)); }
    style = {};
    addEventListener(key,value) { this.events[key]=value; }
    replaceChildren() { this.children=[]; }
    append(...items) { this.children.push(...items); }
    get childElementCount() { return this.children.length; }
    click() { this.events.click?.({target:this}); }
}
function client() {
    const elements = new Map(['tree','menu','choose','projectName','projectKind','files','instances','add','vivadoTools','tools','toggleTools','addVivado','toolBody','toolActions','toolReports','diagnostics','refresh','actions','trace','traceRoot','pin','clear','message','issues'].map(id=>[id,new Element()]));
    const messages=[],events={}; let saved;
    const document={ getElementById:id=>elements.get(id), createElement:tag=>new Element(tag), createElementNS:(_,tag)=>new Element(tag), querySelectorAll:()=>[], addEventListener(){} };
    const context=vm.createContext({document,window:{addEventListener:(key,fn)=>{events[key]=fn;}},acquireVsCodeApi:()=>({getState:()=>({}),setState:value=>{saved=value;},postMessage:message=>messages.push(message)})});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/project/icons.js'),'utf8'),context);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/project/client.js'),'utf8'),context);
    return {elements,messages,state:()=>saved,receive:data=>events.message({data:{type:'snapshot',revision:2,project:{id:'p',name:'corelib',kind:'svtools'},nodes:[],projection:'files',...data}})};
}
test('真实页面脚本显示节点右侧标记、保留文本和工具提示，清除追踪发送当前世代',()=>{
    const c=client(),node={id:'leaf',label:'leaf.sv',file:'/leaf.sv',kind:'file',flags:[{role:'internal',symbol:'●'},{role:'output',symbol:'→'}],tooltip:'u_tx.r_data[7:0]',children:[],actions:[{id:'remove',label:'移出工程'}]};
    c.receive({tracing:true,traceId:'trace-1',nodes:[{id:'set',label:'sources',kind:'set',flags:[],children:[node]}]});
    const rows=c.elements.get('tree').children;assert.equal(rows.length,2);const row=rows[1];
    assert.equal(row.children[3].textContent,'leaf.sv');assert.equal(row.children[4].children[0].getAttribute('aria-label'),'内部声明');assert.equal(row.children[4].children[1].getAttribute('aria-label'),'输出');assert.ok(row.title.includes('r_data'));
    c.elements.get('clear').click();assert.equal(c.messages.at(-1).action,'clear');assert.equal(c.messages.at(-1).revision,2);
    row.events.contextmenu({preventDefault(){}});assert.equal(c.elements.get('menu').children[0].textContent,'移出工程');c.elements.get('menu').children[0].click();assert.equal(c.messages.at(-1).nodeId,'leaf');
});

test('Vivado流程独立显示，构建和报告分组路由，切换自管理工程恢复添加入口',()=>{
    const c=client(),tools=[{id:'synthesize',label:'综合',icon:'synthesize',group:'build'},{id:'implement',label:'布局布线',icon:'implement',group:'build'},{id:'reportTiming',label:'时序报告',icon:'report',group:'reports'}];
    c.receive({project:{id:'v',name:'top',kind:'vivado'},toolActions:tools});
    assert.equal(c.elements.get('add').hidden,true);
    assert.equal(c.elements.get('vivadoTools').hidden,false);
    assert.equal(c.elements.get('tools').hidden,false);
    assert.equal(c.elements.get('toolActions').children.length,2);
    c.elements.get('toolActions').children[1].click();
    assert.equal(c.messages.at(-1).command,'implement');
    c.elements.get('toolReports').click();
    assert.equal(c.elements.get('menu').children.length,1);
    c.elements.get('menu').children[0].click();
    assert.equal(c.messages.at(-1).command,'reportTiming');
    c.elements.get('toggleTools').click();
    assert.equal(c.elements.get('toolBody').hidden,true);
    c.elements.get('vivadoTools').click();
    assert.equal(c.elements.get('toolBody').hidden,false);
    c.receive({project:{id:'local',name:'local',kind:'svtools'}});
    assert.equal(c.elements.get('add').hidden,false);
    assert.equal(c.elements.get('tools').hidden,true);
});

test('静态分析说明默认隐藏，按需查看，不隐藏实际错误；文件夹名称可展开',()=>{
    const c=client(),leaf={id:'leaf',label:'leaf.sv',kind:'file',children:[],flags:[]},folder={id:'folder',label:'src',file:'/src',kind:'folder',flags:[],children:[leaf]};
    c.receive({issues:['静态RTL边界'],message:'实际错误',nodes:[folder]});
    assert.equal(c.elements.get('diagnostics').hidden,true);
    assert.equal(c.elements.get('message').textContent,'实际错误');
    c.elements.get('actions').click();
    c.elements.get('menu').children.at(-1).click();
    assert.equal(c.elements.get('diagnostics').hidden,false);
    const row=c.elements.get('tree').children[0];
    row.events.click({target:row.children[3]});
    assert.equal(c.elements.get('tree').children.length,1);
    assert.notEqual(c.messages.at(-1).action,'open');
});
test('工程切换分别记忆展开状态，文件名不会作为HTML执行',()=>{
    const c=client(),node={id:'src',label:'<img onerror=alert(1)>',kind:'set',children:[],flags:[]};
    c.receive({project:{id:'first',name:'first'},nodes:[node]});assert.equal(c.elements.get('tree').children[0].children[3].textContent,node.label);
    c.elements.get('instances').click();assert.equal(c.messages.at(-1).projection,'instances');
    c.receive({project:{id:'other',name:'other'},nodes:[{...node,id:'other-src'}]});c.elements.get('files').click();
    assert.equal(c.state().first.projection,'instances');assert.equal(c.state().other.projection,'files');
});
