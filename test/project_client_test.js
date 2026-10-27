'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; }
    setAttribute(key,value) { this.attributes[key]=value; }
    addEventListener(key,value) { this.events[key]=value; }
    replaceChildren() { this.children=[]; }
    append(...items) { this.children.push(...items); }
    get childElementCount() { return this.children.length; }
    click() { this.events.click?.({target:this}); }
}
function client() {
    const elements = new Map(['tree','menu','choose','projectName','projectKind','files','instances','add','refresh','actions','trace','traceRoot','pin','clear','message','issues'].map(id=>[id,new Element()]));
    const messages=[],events={}; let saved;
    const document={ getElementById:id=>elements.get(id), createElement:tag=>new Element(tag), addEventListener(){} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/project/client.js'),'utf8'),{document,window:{addEventListener:(key,fn)=>{events[key]=fn;}},acquireVsCodeApi:()=>({getState:()=>({}),setState:value=>{saved=value;},postMessage:message=>messages.push(message)})});
    return {elements,messages,state:()=>saved,receive:data=>events.message({data:{type:'snapshot',revision:2,project:{id:'p',name:'corelib',kind:'svtools'},nodes:[],projection:'files',...data}})};
}
test('真实页面脚本显示节点右侧标记、保留文本和工具提示，清除追踪发送当前世代',()=>{
    const c=client(),node={id:'leaf',label:'leaf.sv',file:'/leaf.sv',kind:'file',flags:[{role:'internal',symbol:'●'},{role:'output',symbol:'→'}],tooltip:'u_tx.r_data[7:0]',children:[],actions:[{id:'remove',label:'移出工程'}]};
    c.receive({tracing:true,traceId:'trace-1',nodes:[{id:'set',label:'sources',kind:'set',flags:[],children:[node]}]});
    const rows=c.elements.get('tree').children;assert.equal(rows.length,2);const row=rows[1];
    assert.equal(row.children[3].textContent,'leaf.sv');assert.equal(row.children[4].children[0].textContent,'●');assert.equal(row.children[4].children[1].textContent,'→');assert.ok(row.title.includes('r_data'));
    c.elements.get('clear').click();assert.equal(c.messages.at(-1).action,'clear');assert.equal(c.messages.at(-1).revision,2);
    row.events.contextmenu({preventDefault(){}});assert.equal(c.elements.get('menu').children[0].textContent,'移出工程');c.elements.get('menu').children[0].click();assert.equal(c.messages.at(-1).nodeId,'leaf');
});
test('工程切换分别记忆展开状态，文件名不会作为HTML执行',()=>{
    const c=client(),node={id:'src',label:'<img onerror=alert(1)>',kind:'set',children:[],flags:[]};
    c.receive({project:{id:'first',name:'first'},nodes:[node]});assert.equal(c.elements.get('tree').children[0].children[3].textContent,node.label);
    c.elements.get('instances').click();assert.equal(c.messages.at(-1).projection,'instances');
    c.receive({project:{id:'other',name:'other'},nodes:[{...node,id:'other-src'}]});c.elements.get('files').click();
    assert.equal(c.state().first.projection,'instances');assert.equal(c.state().other.projection,'files');
});
