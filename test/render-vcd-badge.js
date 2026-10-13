// 渲染验证：总线值徽章明/暗主题对比度（fix/wave-text-contrast）
// 生成一个含总线跳变的 VCD，走 buildWaveformHtml，输出明暗两个 HTML 供截图
const fs = require('fs');
const path = require('path');
const { parseVcd } = require('../src/waveform/parser');
const { buildWaveformHtml } = require('../src/waveform/view');

const vcdText = `$timescale 1ns $end
$scope module tb $end
$var wire 16 ! i_data [15:0] $end
$var wire 8 # wr_ptr [7:0] $end
$upscope $end
$enddefinitions $end
$dumpvars
b0111100010100001 !
b11000111 #
#100
b1001000110000110 !
b11001000 #
#200
b1001011001011000 !
b11001001 #
#300
b0101100111110101 !
b11001010 #
#400
b1000100000110101 !
b11001011 #
#500
b1000101000101001 !
b11001100 #
#600
b0111010111000001 !
b11001101 #
#700
b0111010011000101 !
b11001110 #
#800
b1000010010001000 !
b11001111 #
#900
$end
`;

const parsed = parseVcd(vcdText);
if (!parsed || !parsed.vars || parsed.vars.length !== 2 || !parsed.changes.get('!')?.length) {
  console.error('parseVcd failed:', parsed);
  process.exit(1);
}
console.log('vars:', parsed.vars.map(s => `${s.name}[${s.width}]`).join(', '));

const nonce = 'badge-preview';
let html = buildWaveformHtml(parsed, { fileName: 'badge_contrast.vcd', nonce });
if (!/rgba\(22,24,27,\.92\)/.test(html)) {
  console.error('FAIL: new badge background not found in html');
  process.exit(1);
}
if (/fillStyle = PAL\.busSoft/.test(html)) {
  console.error('FAIL: badge text still uses PAL.busSoft');
  process.exit(1);
}
// 本地测试适配器只承载这个小 fixture；生产页面从 worker 查询数据。
const fixture = JSON.stringify([...parsed.changes.entries()]).replace(/</g, '\\u003c');
const bridge = `window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:message=>{
    if(!message.requestId)return;
    const events=new Map(${fixture}), p=message.params;
    let result;
    if(message.type==='window')result={series:p.ids.map(id=>({id,changes:events.get(id)||[],dense:[]}))};
    else if(message.type==='values')result={values:Object.fromEntries(p.ids.map(id=>[id,WaveModel.valueAt(events.get(id)||[],p.time)]))};
    else if(message.type==='edge'){
        const changes=events.get(p.id)||[];
        const event=p.direction==='next'?changes.find(e=>e.t>p.time):changes.slice().reverse().find(e=>e.t<p.time);
        result={time:event?event.t:null,value:event?event.value:null};
    }
    Promise.resolve().then(()=>window.postMessage({type:'response',requestId:message.requestId,result},'*'));
}});`;
html=html.replace(`<script nonce="${nonce}">const BOOT=`, `<script nonce="${nonce}">${bridge}</script><script nonce="${nonce}">const BOOT=`);
const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'badge-dark.html'), html);
fs.writeFileSync(path.join(outDir, 'badge-light.html'), html.replace('<body>', '<body data-vscode-theme-kind="vscode-light">'));
console.log('OK: badge-dark.html / badge-light.html written, badge color assertions passed');
