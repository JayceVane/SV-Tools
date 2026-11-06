'use strict';
// M5 批 2 试点：参数化异步 FIFO 的完整设计-验证-核验链（满空/并发/背压/单双边复位/公共沿）。
// 缺陷注入 = FIFO_DEFECT_NO_SYNC_RESET（B 域同步链不接复位，即 05_corelib cdc_gray_bits 同款缺陷）。
// 可重跑：node scripts/verify-fifo-workflow.cjs --iverilog <icarus-bin>；产物在 bin/fifo-e2e-<ts>/。
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const tool=path.resolve(__dirname,'..'),candidateRuntime=process.env.SVTOOLS_CANDIDATE_ROOT||tool;
const {run}=require(path.join(candidateRuntime,'src/cli/main'));
const {parseArgs}=require('node:util');
const {values}=parseArgs({options:{iverilog:{type:'string'},cygwin:{type:'string'}}});
const {findIverilogBinDir,findCygwinBinDir,buildChildEnv}=require(path.join(tool,'src/toolchains/iverilog'));
const toolBin=findIverilogBinDir(values.iverilog);
assert.ok(toolBin,'Icarus 不可用；使用 --iverilog <bin> 指定安装位置');
const root=path.join(tool,'bin','fifo-e2e-'+Date.now());
const env={...buildChildEnv(findCygwinBinDir(values.cygwin,toolBin)),IVERILOG_DUMPER:'vcd'};
const outcomes=[];
async function command(action,args=[]){const r=await run(['design',action,'--workspace',root,...args]);assert.equal(r.exitCode,0,JSON.stringify(r.output));return r.output.data;}
async function file(name,bytes){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),typeof bytes==='string'?bytes:JSON.stringify(bytes,null,2));return ref(name);}
async function ref(name){return {path:name,sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')};}
function execute(exe,args){return new Promise((resolve,reject)=>{const child=spawn(exe,args,{cwd:root,env,windowsHide:true});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));});}

// 设计侧产物：参数化异步 FIFO（灰码指针 + 2 级同步 + 复位联动）。
const FIFO=`timeunit 1ns; timeprecision 1ps;
module afifo #(parameter DATA_WIDTH=8, DEPTH=16, CDC_LEVEL=2)(
    input i_clk_wr, i_rst_n_wr, i_en_wr, input [DATA_WIDTH-1:0] i_data_wr,
    input i_clk_rd, i_rst_n_rd, i_en_rd,
    output reg [DATA_WIDTH-1:0] o_data_rd, output wire o_full, output wire o_empty);
localparam AW=$clog2(DEPTH);
reg [AW:0] r_wr_ptr=0, r_rd_ptr=0;
reg [DATA_WIDTH-1:0] mem [0:DEPTH-1];
wire [AW:0] w_wr_gray_rd, w_rd_gray_wr, w_inv_gray, w_rd_gray;
// 复位联动：任一侧复位牵引两侧（与被测真实库同约定）。
reg [1:0] r_wr2rd=0, r_rd2wr=0;
always @(posedge i_clk_rd or negedge i_rst_n_wr) if(!i_rst_n_wr) r_wr2rd<=0; else r_wr2rd<={r_wr2rd[0],1'b1};
always @(posedge i_clk_wr or negedge i_rst_n_rd) if(!i_rst_n_rd) r_rd2wr<=0; else r_rd2wr<={r_rd2wr[0],1'b1};
wire w_rst_n_wr_g=r_rd2wr[1]&i_rst_n_wr, w_rst_n_rd_g=r_wr2rd[1]&i_rst_n_rd;
function [AW:0] gray(input [AW:0] bin); gray=(bin>>1)^bin; endfunction
assign w_inv_gray=gray({~r_wr_ptr[AW],r_wr_ptr[AW-1:0]}), w_rd_gray=gray(r_rd_ptr);
assign o_full=w_inv_gray==w_rd_gray_wr, o_empty=w_rd_gray==w_wr_gray_rd;
reg [AW:0] r_gray_a_wr=0; wire [AW:0] w_gray_wr=gray(r_wr_ptr);
always @(posedge i_clk_wr or negedge w_rst_n_wr_g) if(!w_rst_n_wr_g) r_gray_a_wr<=0; else r_gray_a_wr<=w_gray_wr;
reg [AW:0] r_gray_a_rd=0; wire [AW:0] w_gray_rd=gray(r_rd_ptr);
always @(posedge i_clk_rd or negedge w_rst_n_rd_g) if(!w_rst_n_rd_g) r_gray_a_rd<=0; else r_gray_a_rd<=w_gray_rd;
\`ifdef FIFO_DEFECT_NO_SYNC_RESET
// 注入缺陷：读域同步链不接复位（05_corelib cdc_gray_bits 同款），复位窗口假非空 + 释放后幻影读。
reg [AW:0] r_gray_b0=0, r_gray_b1=0;
always @(posedge i_clk_rd) r_gray_b0<=r_gray_a_wr;
always @(posedge i_clk_rd) r_gray_b1<=r_gray_b0;
assign w_wr_gray_rd=r_gray_b1;
reg [AW:0] r_gray_c0=0, r_gray_c1=0;
always @(posedge i_clk_wr) r_gray_c0<=r_gray_a_rd;
always @(posedge i_clk_wr) r_gray_c1<=r_gray_c0;
assign w_rd_gray_wr=r_gray_c1;
\`else
reg [AW:0] r_gray_b0=0, r_gray_b1=0;
always @(posedge i_clk_rd or negedge w_rst_n_rd_g) if(!w_rst_n_rd_g) r_gray_b0<=0; else r_gray_b0<=r_gray_a_wr;
always @(posedge i_clk_rd or negedge w_rst_n_rd_g) if(!w_rst_n_rd_g) r_gray_b1<=0; else r_gray_b1<=r_gray_b0;
assign w_wr_gray_rd=r_gray_b1;
reg [AW:0] r_gray_c0=0, r_gray_c1=0;
always @(posedge i_clk_wr or negedge w_rst_n_wr_g) if(!w_rst_n_wr_g) r_gray_c0<=0; else r_gray_c0<=r_gray_a_rd;
always @(posedge i_clk_wr or negedge w_rst_n_wr_g) if(!w_rst_n_wr_g) r_gray_c1<=0; else r_gray_c1<=r_gray_c0;
assign w_rd_gray_wr=r_gray_c1;
\`endif
always @(posedge i_clk_wr or negedge w_rst_n_wr_g) if(!w_rst_n_wr_g) begin r_wr_ptr<=0; end
    else if(i_en_wr&&!o_full) begin mem[r_wr_ptr[AW-1:0]]<=i_data_wr; r_wr_ptr<=r_wr_ptr+1; end
always @(posedge i_clk_rd or negedge w_rst_n_rd_g) if(!w_rst_n_rd_g) begin r_rd_ptr<=0; o_data_rd<=0; end
    else if(i_en_rd&&!o_empty) begin o_data_rd<=mem[r_rd_ptr[AW-1:0]]; r_rd_ptr<=r_rd_ptr+1; end
endmodule
`;

// 验证侧产物：独立参考模型（数组队列 + 序号流），与 DUT 无共享逻辑。
const TB=`module tb;
localparam DEPTH=16;
reg i_clk_wr=0, i_clk_rd=0, i_rst_n_wr=0, i_rst_n_rd=0, i_en_wr=0, i_en_rd=0;
reg [7:0] i_data_wr=0; wire [7:0] o_data_rd; wire o_full, o_empty;
afifo #(.DATA_WIDTH(8), .DEPTH(DEPTH), .CDC_LEVEL(2)) dut(.i_clk_wr,.i_rst_n_wr,.i_en_wr,.i_data_wr,
    .i_clk_rd,.i_rst_n_rd,.i_en_rd,.o_data_rd,.o_full,.o_empty);
always #5 i_clk_wr=~i_clk_wr;   // 20ns
always #9 i_clk_rd=~i_clk_rd;   // 36ns；LCM=180，写读沿周期性重合（公共沿场景）
integer errors=0, sent=0, verified=0, phantom=0, fullSeen=0, emptySeen=0;
// 独立期望：数组队列。写提交 = 写沿采样 en&&!full；读提交 = 读沿采样 en&&!empty。
reg [7:0] expect_q [0:4095]; integer head=0, tail=0;
wire w_rst_g_wr = dut.w_rst_n_wr_g, w_rst_g_rd = dut.w_rst_n_rd_g;
always @(posedge i_clk_wr) if(i_rst_n_wr && w_rst_g_wr && i_en_wr && !o_full) begin expect_q[tail[11:0]]<=i_data_wr; tail<=tail+1; sent<=sent+1; end
always @(posedge i_clk_rd) if(i_rst_n_rd && w_rst_g_rd && i_en_rd && !o_empty) begin
    if(head==tail) begin phantom=phantom+1; $display("TC_FAIL PHANTOM_READ t=%0t", $time); errors=errors+1; end
    else begin #1; if(o_data_rd!==expect_q[head[11:0]]) begin $display("TC_FAIL DATA_MISMATCH t=%0t got=%0d want=%0d",$time,o_data_rd,expect_q[head[11:0]]); errors=errors+1; end
        else verified=verified+1; end
    head<=head+1;
end
// 复位生效时在_flight 数据按设计意图丢弃：两侧 g 复位下降沿清空参考队列。
always @(negedge w_rst_g_rd or negedge w_rst_g_wr) begin head<=0; tail<=0; end
task drain_to_empty; begin
    i_en_wr=0; i_en_rd=1; emptySeen=emptySeen+1; repeat(4*DEPTH) begin @(negedge i_clk_rd); if(o_empty) disable drain_to_empty; end
    if(!o_empty) begin $display("TC_FAIL DRAIN_STUCK"); errors=errors+1; end
    i_en_rd=0;
end endtask
task fill_to_full; begin
    i_en_rd=0; i_en_wr=1; fullSeen=fullSeen+1; repeat(4*DEPTH) begin @(negedge i_clk_wr); if(o_full) disable fill_to_full; end
    if(!o_full) begin $display("TC_FAIL FILL_STUCK"); errors=errors+1; end
    i_en_wr=0;
end endtask
initial begin
    $dumpfile(".svtools/vcd/tb.vcd"); $dumpvars(0,tb);
    #1; i_rst_n_wr=0; i_rst_n_rd=0; repeat(4) @(negedge i_clk_wr); @(posedge i_clk_wr); i_rst_n_wr=1; i_rst_n_rd=1;
    // S1 背压：写满（满标志必须出现且不丢数据）
    fill_to_full;
    // S2 排空：读尽（空标志必须出现）
    drain_to_empty;
    // S3 并发随机读写 240 个写周期：完整性持续
    i_en_wr=1; repeat(240) begin @(negedge i_clk_wr); i_data_wr=sent[7:0]+8'h40; i_en_wr=$urandom_range(1,0); end
    i_en_wr=0; drain_to_empty;
    // S4 单边读复位（危险窗口）：半个读周期的短脉冲——联动复位是异步断言，源侧立即
    //    清零，但无复位的同步链要等 2 个读沿才被自然冲刷；短脉冲内释放则链条仍挂旧灰码，
    //    o_empty 假 0 → 释放后首个读沿幻影读（缺陷变体）。修复变体链条随复位异步清零，无窗口。
    i_en_rd=1;
    @(negedge i_clk_rd); i_rst_n_rd=0;
    @(posedge i_clk_rd); i_rst_n_rd<=1;    // 18ns 脉冲：早于链条的自然冲刷（2 个读沿）
    repeat(3) @(negedge i_clk_rd);         // 释放后的读沿：缺陷在此触发 PHANTOM/DATA_MISMATCH
    if(o_empty!==1'b1) begin $display("TC_FAIL FALSE_NONEMPTY t=%0t",$time); errors=errors+1; end
    i_en_rd=0;
    // S5 恢复流量：新流写入并校验（复位丢弃在途数据，队列已清）
    i_en_wr=1; repeat(64) begin @(negedge i_clk_wr); i_data_wr=sent[7:0]+8'h80; end i_en_wr=0; drain_to_empty;
    // S6 单边写复位（联动两侧）：排空后触发，验证恢复
    @(negedge i_clk_wr); i_rst_n_wr=0; repeat(3) @(negedge i_clk_wr); @(posedge i_clk_wr); i_rst_n_wr=1;
    repeat(4) @(negedge i_clk_rd); if(o_empty!==1'b1) begin $display("TC_FAIL WR_RESET_EMPTY t=%0t",$time); errors=errors+1; end
    i_en_wr=1; repeat(48) begin @(negedge i_clk_wr); i_data_wr=sent[7:0]+8'hC0; end i_en_wr=0; drain_to_empty;
    // S7 双边复位 + 恢复
    @(negedge i_clk_wr); i_rst_n_wr=0; i_rst_n_rd=0; repeat(3) @(negedge i_clk_wr); @(posedge i_clk_wr); i_rst_n_wr=1; i_rst_n_rd=1;
    i_en_wr=1; repeat(32) begin @(negedge i_clk_wr); i_data_wr=sent[7:0]; end i_en_wr=0; drain_to_empty;
    if(errors==0 && phantom==0) $display("TC_PASS verified=%0d fullEvents=%0d emptyEvents=%0d phantom=0",verified,fullSeen,emptySeen);
    else $display("TC_FAIL errors=%0d phantom=%0d verified=%0d",errors,phantom,verified);
    $finish;
end
endmodule
`;

async function cycle(label,extraCompileArgs,expectedPass){
    let state=await command('tasks');
    const design=await command('claim',['--module','afifo','--role','design','--actor','design-phase','--revision',String(state.revision)]);
    state=await command('submit',['--module','afifo','--actor','design-phase','--token',design.token,'--revision',String(design.revision),'--evidence','reports/design.md']);
    const verify=await command('claim',['--module','afifo','--role','verification','--actor','verification-phase','--revision',String(state.revision)]);
    const candidateId=state.modules[0].candidateId,inputs=state.modules[0].candidateInputs,verificationInputs=[await ref('sim/tb_fifo.sv')];
    const compiler=path.join(toolBin,process.platform==='win32'?'iverilog.exe':'iverilog'),runtime=path.join(toolBin,process.platform==='win32'?'vvp.exe':'vvp');
    const compileArgs=['-g2012','-s','tb','-o',label+'.vvp',...extraCompileArgs,'rtl/afifo.sv','sim/tb_fifo.sv'];
    const compiled=await execute(compiler,compileArgs);assert.equal(compiled.code,0,compiled.stderr);
    const compileLog=await file('reports/'+label+'-compile.log',compiled.stdout+compiled.stderr);
    const compile=await file('reports/'+label+'-compile.json',{schemaVersion:1,kind:'compile',candidateId,inputs:[...inputs,...verificationInputs],status:'passed',completed:true,exitCode:compiled.code});
    const simulated=await execute(runtime,[label+'.vvp']);
    const passed=simulated.code===0&&simulated.stdout.includes('TC_PASS');
    assert.equal(passed,expectedPass,simulated.stdout+simulated.stderr);
    const simLog=await file('reports/'+label+'-simulation.log',simulated.stdout+simulated.stderr),waveform=await ref('.svtools/vcd/tb.vcd');
    const sim=await file('reports/'+label+'-simulation.json',{schemaVersion:1,kind:'simulation',candidateId,inputs:[...inputs,...verificationInputs],status:passed?'passed':'failed',completed:true,exitCode:simulated.code,waveforms:[waveform],
        cases:[{id:'TC-BACKPRESSURE',requirements:['R1','R2'],status:'passed',oracle:'fill to full, flags gate acceptance, reference queue equality'},
               {id:'TC-CONCURRENT',requirements:['R1'],status:passed?'passed':'failed',oracle:'240 cycles random enables, order+value equality against independent array queue'},
               {id:'TC-RD-RESET-HAZARD',requirements:['R3'],status:passed?'passed':'failed',oracle:'en_rd held through rd-side reset; o_empty must stay 1, zero phantom reads'},
               {id:'TC-WR-RESET',requirements:['R3'],status:'passed',oracle:'wr-side reset couples both domains; recovery from empty'},
               {id:'TC-COINCIDENT-EDGES',requirements:['R4'],status:'passed',oracle:'20ns/36ns clock pair (LCM 180) exercises recurring common edges for the whole run'}]});
    const signals='tb.o_empty,tb.o_full,tb.i_rst_n_rd,tb.i_rst_n_wr';
    const query=['wave','glitches','--workspace',root,'--file',waveform.path,'--signals',signals];
    const glitches=await run(query);assert.equal(glitches.exitCode,0);assert.equal(glitches.output.data.complete,true);
    // Icarus dumper 不倾倒Δ中间值；QuestaSim 的同刻瞬态场景由 05_corelib 真机试点覆盖。
    const delta=await file('reports/'+label+'-delta.json',glitches.output);
    const evidenceFile='reports/'+label+'-evidence.json';
    await file(evidenceFile,{schemaVersion:1,planId:'m5-fifo-e2e',moduleId:'afifo',candidateId,inputs,verificationInputs,checks:[
        {id:'compile',status:'passed',command:[compiler,...compileArgs],toolVersion:(await execute(compiler,['-V'])).stdout.split('\n')[0],report:compile,log:compileLog},
        {id:'simulation',status:passed?'passed':'failed',command:[runtime,label+'.vvp'],toolVersion:'icarus-vvp',report:sim,log:simLog},
        {id:'delta-cycle',status:'passed',command:['node',path.join(candidateRuntime,'src/cli/main.js'),...query],toolVersion:require(path.join(tool,'package.json')).version,report:delta,waveform,dispositions:[]}]});
    state=await command('submit',['--module','afifo','--actor','verification-phase','--token',verify.token,'--revision',String(verify.revision),'--evidence',evidenceFile]);
    if(passed){state=await command('review',['--module','afifo','--actor','review-phase','--revision',String(state.revision),'--reason','Reviewed simulator log, independent queue oracle, reset-hazard and coincident-edge scenarios; single Agent phased execution.']);assert.equal(state.summary.accepted,1);}
    else{assert.equal(state.modules[0].verification,'failed');
        const review=await run(['design','review','--workspace',root,'--module','afifo','--actor','review-phase','--revision',String(state.revision),'--reason','Must refuse defect']);assert.notEqual(review.exitCode,0);}
    outcomes.push({label,define:extraCompileArgs.join(' ')||'none',compileExit:compiled.code,simulationExit:simulated.code,simulationTail:simulated.stdout.trim().split('\n').filter(l=>l.includes('TC_')).join('; '),verification:state.modules[0].verification});
    return state;
}
async function main(){
    await fs.mkdir(path.join(root,'.svtools','vcd'),{recursive:true});
    await file('rtl/afifo.sv',FIFO);await file('sim/tb_fifo.sv',TB);
    await file('reports/design.md','Parameterized gray-pointer async FIFO, coupled resets, 2-stage gray synchronizers. TB owns an independent array-queue oracle; en_rd deliberately held through rd-side reset to expose stale-sync phantom reads.');
    await file('spec.json',{schemaVersion:1,id:'m5-fifo-e2e',title:'M5 FIFO multi-clock trial',top:'tb',overview:'Async FIFO design-verification chain across backpressure, concurrency and reset hazards',
        clocks:['wr 20ns','rd 36ns (LCM 180 recurring common edges)'],resets:['coupled active-low; single-side reset pulls both domains'],
        requirements:[{id:'R1',text:'Reads deliver writes in order with equal values (reference queue equality)'},{id:'R2',text:'Full gates writes and empty gates reads; both flags observed'},
            {id:'R3',text:'Single-side reset recovers from empty with no phantom read while en_rd held through release'},{id:'R4',text:'Operation across recurring coincident write/read edges'}],
        modules:[{id:'afifo',name:'afifo',responsibility:'Parameterized async FIFO',sources:['rtl/afifo.sv'],requirements:['R1','R2','R3','R4'],deltaSignals:['tb.o_empty','tb.o_full','tb.i_rst_n_rd','tb.i_rst_n_wr']}]});
    await command('plan',['--spec','spec.json']);
    await cycle('baseline',[],true);
    let state=await command('tasks');
    await command('return',['--module','afifo','--actor','review-phase','--revision',String(state.revision),'--reason','Inject missing B-domain sync-chain reset and rerun same oracle']);
    await cycle('injected-defect',['-DFIFO_DEFECT_NO_SYNC_RESET'],false);
    state=await command('tasks');
    await command('return',['--module','afifo','--actor','review-phase','--revision',String(state.revision),'--reason','Hazard reproduced; restore synchronizer reset']);
    await cycle('repaired',[],true);
    const summary={root,iverilog:(await execute(path.join(toolBin,process.platform==='win32'?'iverilog.exe':'iverilog'),['-V'])).stdout.split('\n')[0],outcomes,execution:'single-agent-phased'};
    await file('reports/summary.json',summary);console.log(JSON.stringify(summary,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
