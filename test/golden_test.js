/**
 * Golden 格式化测试：example/ 放格式化前输入，example/target/ 放期望输出。
 *
 * 用法：node test/golden_test.js
 *  - 对 example/*.sv 逐个用扩展同款配置格式化，与 example/target/<同名> 全文比对；
 *  - 同时验证幂等：对 target 再格式化一次应与 target 完全一致；
 *  - 发现新的格式化问题时：把最小复现加入 example/，人工校对输出后固化到
 *    example/target/（src-rust/target/release/svtools.exe example/xx.sv > example/target/xx.sv）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXAMPLE_DIR = path.join(ROOT, 'example');
const TARGET_DIR = path.join(EXAMPLE_DIR, 'target');

const native = require(path.join(ROOT, 'svtools.win32-x64-msvc.node'));

// 与 extension.js formatDocument 完全一致的默认配置
function format(text) {
    return native.formatText(text, {
        indentStyle: '1tbs',
        useTab: false,
        nbSpace: 4,
        maxConsecutiveEmptyLines: 1,
        reindentOnly: false,
        ignoreTick: true,
        oneDeclPerLine: false,
        oneBindPerLine: true,
        alignComma: true,
        paramOneLine: true,
        importSameLine: false,
        instAlignPort: true
    });
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('PASS', name); }
    else { failed++; console.log('FAIL', name, detail || ''); process.exitCode = 1; }
}

const inputs = fs.readdirSync(EXAMPLE_DIR).filter(f => /\.sv$/i.test(f));
if (!inputs.length) { console.error('example/ 下没有 .sv 输入用例'); process.exit(1); }

for (const f of inputs) {
    const input = fs.readFileSync(path.join(EXAMPLE_DIR, f), 'utf8');
    const targetPath = path.join(TARGET_DIR, f);
    if (!fs.existsSync(targetPath)) {
        check(`${f}: 缺少 golden（example/target/${f}）`, false, '请格式化后校对并固化期望输出');
        continue;
    }
    // 行尾归一（编辑器可能把 target 存成 CRLF，格式化输出为 LF）
    const norm = s => s.replace(/\r\n/g, '\n');
    const target = norm(fs.readFileSync(targetPath, 'utf8'));

    // 1. 格式化输出 == golden
    let out;
    try { out = format(input); }
    catch (e) { check(`${f}: 格式化抛错`, false, String(e)); continue; }
    if (out === target) check(`${f}: 输出与 golden 一致`, true);
    else {
        const outL = out.split('\n'), tgtL = target.split('\n');
        let line = -1;
        for (let i = 0; i < Math.max(outL.length, tgtL.length); i++) {
            if (outL[i] !== tgtL[i]) { line = i; break; }
        }
        check(`${f}: 输出与 golden 一致`, false,
            `首个差异行 ${line + 1}:\n  期望: ${JSON.stringify(tgtL[line])}\n  实际: ${JSON.stringify(outL[line])}`);
    }

    // 2. 幂等：对 golden 再格式化应稳定
    try {
        const twice = format(target);
        check(`${f}: 幂等（golden 再格式化不变）`, twice === target,
            twice === target ? '' : '二次格式化产生变化');
    } catch (e) {
        check(`${f}: 幂等`, false, String(e));
    }
}

console.log(`\nGOLDEN: ${passed} passed, ${failed} failed (${inputs.length} 个用例)`);
