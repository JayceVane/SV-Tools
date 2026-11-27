'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { add, info } = require('../src/design/note-service');
const { record, readRevision } = require('../src/design/note-history-store');
const { anchorAt, anchorPath } = require('../src/design/note-anchor');
const { fingerprint, MAX_ARTIFACT } = require('../src/design/workflow-files');
const { loadReview, revealObservation, loadReviewSample } = require('../src/design/review-model');
const { exportNotes } = require('../src/design/note-export');

const rtl = 'rtl/afifo.sv';
const tb = 'sim/tb_fifo.sv';
const variants = [['injected-defect', '候选 A', 'failed'], ['repaired', '候选 B', 'passed']];
const topic = 'FIFO 短复位';
const note = 'nt_fifo_hazard';
const message = '短复位后，第一拍能否接受空队列读取';

async function build(root) {
    const read = file => fs.readFile(path.join(root, file), 'utf8');
    const write = (file, text) => fs.writeFile(path.join(root, file), text);
    const rtlText = await read(rtl), tbText = await read(tb);
    const line = (text, needle) => {
        const index = text.split('\n').findIndex(line => line.includes(needle));
        assert.ok(index >= 0, needle);
        return index + 1;
    };
    const rtlStart = rtlText.indexOf('assign o_full');
    const selection = anchorAt(rtl, rtlText, rtlStart, rtlText.indexOf('\n', rtlStart));
    const n1 = await add(root, note, `# ${message}\n\n` +
        `R3 约定单侧复位联动两个域，丢弃在途数据。复位前先让写指针非零，并保持读请求跨过复位。没有新写入时，参考队列为空。\n\n` +
        `读域把本地读 Gray 指针与同步来的写 Gray 指针做相等比较。两者在复位后的可读边界都应为零。若同步链保留旧值，读使能仍在，空标志一旦错误为 0 就会接受一次本不存在的读取。\n`,
    { anchor: selection, topic });
    await add(root, 'nt_fifo_oracle', '# 参考队列如何判错\n\n参考队列清空后，且恢复窗口没有接受新的写入，任何有效读都应被识别为幻影读。测试台用数组队列保存写入的值和顺序。\n\n测试台从 DUT 借用了联动复位信号安排清队列。这个用例验证同步指针与空标志路径，单凭它无法独立验证复位联动信号的生成。\n', { topic });
    await add(root, 'nt_fifo_limits', '# 本轮覆盖范围\n\n本试点采用交替时钟沿、非零写指针和确定性短复位，对照仅改变缺失同步链复位的编译条件。Icarus VCD 提供沿前稳定值，未记录的 Δ 瞬态及硬件亚稳态不作结论。\n', { topic });
    assert.equal((await info(root, note, { resolve: true })).location.status, 'resolved');
    const version = await record(root, note, await read(n1.path), 'checkpoint', 'FIFO 复位对照');
    const revision = await readRevision(root, note, version);
    const binding = await fingerprint(root, anchorPath(note));
    const failure = await read('reports/injected-defect-simulation.log');
    const t = failure.match(/PHANTOM_READ t=(\d+)/u)?.[1];
    assert.ok(t, 'missing PHANTOM_READ timestamp');
    const at = String(BigInt(t) - 1n);
    const files = [], ref = (file, label, line) => ({ file, label, line });
    async function file(id, filePath, label) {
        const { path, sha256 } = await fingerprint(root, filePath, MAX_ARTIFACT);
        files.push({ id, path, sha256, label });
    }
    await file('rtl', rtl, 'FIFO RTL');
    await file('tb', tb, '独立队列检查');
    for (const [id] of variants) {
        await file(id + '-run', `reports/${id}-run.json`, id + ' 运行记录');
        await file(id + '-log', `reports/${id}-simulation.log`, id + ' 日志');
        await file(id + '-vcd', `reports/${id}.vcd`, id + ' 波形');
    }
    const signals = ['tb.o_empty', 'tb.i_en_rd', 'tb.w_rst_g_rd', 'tb.dut.w_wr_gray_rd', 'tb.dut.w_rd_gray'];
    const expectedValues = [
        { id: 'empty', label: '无新写入，应为空', encoding: 'bits', value: '1' },
        { id: 'request', label: '读请求持续', encoding: 'bits', value: '1' },
        { id: 'released', label: '读域复位释放', encoding: 'bits', value: '1' },
        { id: 'write-gray', label: '同步写指针复位值', encoding: 'unsigned', value: '0' },
        { id: 'read-gray', label: '本地读指针复位值', encoding: 'unsigned', value: '0' }
    ];
    const events = [
        { id: 'release', title: '短复位后第一个危险读沿',
            flow: [{ label: '等待写指针同步', detail: '复位前先建立非零写指针历史。' },
                { label: '释放读域复位', detail: '短复位来不及自然冲掉旧同步值，仍持续请求读取。', active: true },
                { label: '仅在非空时读', detail: '数组队列应该为空，读提交说明检查失败。' }],
            expected: '复位会丢弃在途数据，尚无新写入。此时两个指针都应为零，empty 应为 1，读请求不能成功提交。',
            refs: [ref('rtl', '定位 Gray 比较', line(rtlText, 'assign o_full')), ref('rtl', '定位读域同步链', line(rtlText, 'FIFO_DEFECT_NO_SYNC_RESET')),
                ref('tb', '定位空队列检查', line(tbText, 'PHANTOM_READ')), ref('tb', '定位短复位激励', line(tbText, 'S4 单边读复位'))],
            expectedValues, observations: variants.map(([id, , status]) => ({ variant: id, status,
                text: status === 'failed' ? '编译和运行均正常返回，队列检查记录了幻影读、数据失配和假非空。' : '同一激励下无幻影读，FIFO 回归记录 TC_PASS。',
                refs: [ref(id + '-run', '打开运行配置'), ref(id + '-log', '打开检查日志'),
                    { file: id + '-vcd', label: '定位读沿前 1 ps', sample: { at, signals,
                        expect: signals.map((signal, index) => ({ signal, id: expectedValues[index].id })) } }] })) }
    ];
    const manifest = { schemaVersion: 1, title: 'FIFO 复位复核', files, rules: [{ id: 'short-reset', title: message, module: 'afifo', group: topic,
        note: { id: note, version, sha256: revision.sha256, anchor: { file: 'rtl', line: line(rtlText, 'assign o_full'),
            binding: { path: binding.path, sha256: binding.sha256 } } },
        contract: '按 R3，单侧复位丢弃在途数据，恢复后没有新写入时应为空。',
        mechanism: '空标志对比本地读 Gray 指针和同步到读域的写 Gray 指针。',
        stimulus: '建立非零写指针，保持读请求，做短读侧复位。随后恢复，观察无新写入的读沿。',
        checker: '数组队列参考检查空队列读接受，并逐个核对读取的数据；部分复位边界取自 DUT 联动信号。',
        variants: variants.map(([id, label]) => ({ id, label, inputs: ['rtl', 'tb'], run: id + '-run' })), events,
        changes: [{ id: 'sync-reset', title: '读域同步链复位', kind: 'implementation', from: variants[0][0], to: variants[1][0],
            before: '编译启用 FIFO_DEFECT_NO_SYNC_RESET，读域同步链不清零。', after: '同一源文件采用同步链复位分支。',
            impacts: [{ event: 'release', note: '观察时钟采样前的写 Gray 指针和空标志。' }] }] }] };
    await write('svtools.review.json', JSON.stringify(manifest, null, 2) + '\n');
    const review = await loadReview(root), results = [];
    for (const observation of review.observations.values()) {
        const observed = await revealObservation(root, observation);
        assert.equal(observed.status, observation.status, JSON.stringify(observed));
        const sample = await loadReviewSample(root, review.links.get(observed.refs.find(ref => ref.hasSample).token));
        const expected = observation.status === 'failed' ? ['mismatch', 'match', 'match', 'mismatch', 'match'] : Array(5).fill('match');
        assert.deepEqual(sample.checks.map(check => check.status), expected);
        results.push({ status: observed.status, sample });
    }
    await write('reports/review-verification.json', JSON.stringify(results, null, 2) + '\n');
    const exported = await exportNotes(root, { topic, final: true, out: 'docs/fifo-review-delivery', imageFormat: 'html', module: 'afifo' });
    await write('TASK.md', '# FIFO 复位审阅题面\n\n先读 R3、机制和测试激励。先写出两条指针与空标志的预期，然后查看实际结果。\n\n1. 复位前为什么要建立非零写指针？缩短复位和保持 `i_en_rd` 分别有什么作用？\n2. 在恢复之后无新写入时，哪一拍可能发生幻影读？给出波形和检查器各一条证据。\n3. 参考队列对 DUT 内部复位信号的依赖，限制了哪些结论？\n\n先保存预期，再打开原始波形或展开「查看实际结果」。记录推导和定位用时、操作数、答对项与误放行。\n');
    await write('README.md', '# FIFO 复位复核试点\n\n用 4.3 开发宿主打开本目录，执行「SV Tools: 打开设计讲解」并选择「短复位后第一个危险读沿」。\n\n[审阅题面](TASK.md) · [定版主题 HTML](docs/fifo-review-delivery/notes.html) · [验证记录](reports/review-verification.json)\n');
    return { manifest: 'svtools.review.json', export: exported.manifest, at };
}

module.exports = { build };
