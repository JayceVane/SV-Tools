'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { indexMemories, memoryPage, compareMemoryValues } = require('../src/waveform/memory');
const { prepareSignals } = require('../src/waveform/model');
const { parseVcd } = require('../src/waveform/parser');
const { VcdSession } = require('../src/waveform/session');

function signal(name, id = name, options = {}) {
    return { name, id, width: 8, type: 'reg', scopePath: 'tb', path: 'tb.' + name, ...options };
}

test('二维数组按真实负地址排序，稀疏单元不补成零；packed range不作为维数', () => {
    const vars = [signal('mem[3][-2]', 'a', { range: '[15:8]' }), signal('mem[-1][4]', 'b', { range: '[15:8]' }),
        signal('mem[-1][-2]', 'c', { range: '[15:8]' }), signal('bus', 'd', { range: '[7:0]' })];
    const { groups, diagnostics } = indexMemories(vars), group = groups[0];
    assert.equal(groups.length, 1); assert.equal(diagnostics.length, 0);
    assert.equal(group.dimensions, 2); assert.equal(group.width, 8);
    assert.deepEqual(group.rows, [-1, 3]); assert.deepEqual(group.columns, [-2, 4]);
    const page = memoryPage(group); assert.equal(page.cells.length, 4);
    assert.equal(page.cells.find(cell => cell.row === 3 && cell.column === 4).signal, null);
    assert.strictEqual(page.cells[0].signal, vars[2]); assert.equal(group.cellCount, 3);
    assert.equal(Object.hasOwn(vars[0], 'key'), false);
});

test('字数组保留真实地址与alias ID，转义名称与不同scope独立归并', () => {
    const vars = [signal('\\words[6]', '!'), signal('\\words[4]', '!'),
        signal('words[4]', '?', { scopePath: 'tb.child', path: 'tb.child.words[4]' })];
    const groups = indexMemories(prepareSignals(vars)).groups;
    assert.equal(groups.length, 2);
    const group = groups.find(item => item.path === 'tb.words');
    assert.equal(group.dimensions, 1); assert.deepEqual(group.rows, [4, 6]); assert.deepEqual(group.columns, [0]);
    assert.deepEqual(memoryPage(group).cells.map(cell => cell.signal.id), ['!', '!']);
    assert.notEqual(group.key, groups.find(item => item.path === 'tb.child.words').key);
});

test('同坐标冲突、不同word宽度和维数不静默丢弃，完整重复声明只保留原引用', () => {
    for (const other of [signal('mem[2]', 'other'), signal('mem[2]', 'same', { width: 4 }),
        signal('mem[2][0]', 'same'), signal('mem[2]', 'same', { range: '[11:4]' })]) {
        const result = indexMemories([signal('mem[2]', 'same', { range: '[7:0]' }), other]);
        assert.equal(result.groups.length, 0); assert.equal(result.diagnostics[0].code, 'MEMORY_CONFLICT');
    }
    const first = signal('mem[2]');
    const group = indexMemories([first, { ...first }]).groups[0];
    assert.equal(group.cellCount, 1); assert.strictEqual(group.cells.get('[2,0]'), first);
});

test('高维、超出安全精度或非整数地址不猜测为二维存储器', () => {
    const result = indexMemories([signal('mem[0][1][2]'), signal('huge[9007199254740992]'),
        signal('packed[7:0]'), signal('text[foo]'), signal('mem[-.5]')]);
    assert.equal(result.groups.length, 0);
    assert.deepEqual(result.diagnostics.map(item => item.code), ['MEMORY_INDEX', 'MEMORY_INDEX']);
});

test('一位packed切片原引用不归并为地址，一位mem packed范围仍是word', () => {
    const vcd = parseVcd('$var wire 1 ! bus [3:3] $end $var wire 1 # bus [2:2] $end ' +
        '$var reg 1 % mem[4] [0:0] $end $var reg 1 & mem[6] [0:0] $end $enddefinitions $end');
    const result = indexMemories(vcd.vars); assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].name, 'mem'); assert.deepEqual(result.groups[0].rows, [4, 6]);
    assert.equal(result.groups[0].dimensions, 1); assert.equal(result.groups[0].width, 1);
});

test('大稀疏数组仅构造当前页，越界恢复夹紧，非法分页与超过128单元被拒绝', () => {
    const vars = Array.from({ length: 10000 }, (_, index) => signal(`mem[${index * 1000}][${index * 7}]`));
    const group = indexMemories(vars).groups[0];
    assert.equal(group.cells.size, 10000); assert.equal(group.rows.length, 10000);
    const page = memoryPage(group, { rowStart: 9998, columnStart: 9998 });
    assert.equal(page.cells.length, 4); assert.equal(page.cells.filter(cell => cell.signal).length, 2);
    assert.equal(memoryPage(group, { rowStart: Number.MAX_SAFE_INTEGER, columnStart: -10 }).rowStart, 9999);
    for (const options of [{ rowCount: 0 }, { columnCount: 1.5 }, { rowCount: 16, columnCount: 16 }, { rowCount: 129 }]) {
        assert.throws(() => memoryPage(group, options), RangeError);
    }
});

test('变化比较按位值扩展，不受显示进制影响；X/Z和缺失初值保留区别', () => {
    const word = { width: 8, type: 'reg' };
    assert.equal(compareMemoryValues('1', '00000001', word), false);
    assert.equal(compareMemoryValues('x1', 'xxxxxxx1', word), false);
    assert.equal(compareMemoryValues('z1', 'zzzzzzz1', word), false);
    assert.equal(compareMemoryValues('x', 'z', word), true);
    assert.equal(compareMemoryValues('00000000', '1', word), true);
    assert.equal(compareMemoryValues(null, '0', word), null);
    assert.equal(compareMemoryValues('x', undefined, word), null);
    assert.equal(compareMemoryValues('1.25e3', '1250', { width: 1, type: 'real' }), false);
    assert.equal(compareMemoryValues('x', 'xx', { width: 16000000 }), false);
});

test('真实 Icarus fixture 经worker读取：矩阵别名、原数组线性化、X/Z与signed值忠实', async t => {
    const file = path.join(__dirname, 'fixtures/memory_dump.vcd');
    assert.match(fs.readFileSync(file, 'utf8'), /Icarus Verilog/);
    const session = new VcdSession(); t.after(() => session.dispose());
    const metadata = await session.open(file), groups = indexMemories(prepareSignals(metadata.vars)).groups;
    const matrix = groups.find(group => group.path === 'memory_dump.matrix');
    assert.equal(matrix.dimensions, 2); assert.deepEqual(matrix.rows, [-1, 1]); assert.deepEqual(matrix.columns, [2, 3, 4]);
    const linear = groups.find(group => group.path === 'memory_dump.mem');
    assert.equal(linear.dimensions, 1); assert.deepEqual(linear.rows, [0, 2, 6, 7]);
    const initial = await session.values({ ids: memoryPage(matrix).cells.filter(cell => cell.signal).map(cell => cell.signal.id), time: 0 });
    assert.equal(initial.values[matrix.cells.get('[-1,2]').id], '11111111');
    assert.equal(initial.values[matrix.cells.get('[-1,4]').id], '10xz01zz');
    const later = await session.values({ ids: [matrix.cells.get('[-1,2]').id, matrix.cells.get('[1,2]').id], time: 15 });
    assert.equal(later.values[matrix.cells.get('[-1,2]').id], '11111110');
    assert.equal(later.values[matrix.cells.get('[1,2]').id], '10000000');
    const words = groups.find(group => group.path === 'memory_dump.words');
    assert.equal(words.cells.get('[4,0]').range, '[11:4]');
    const x = await session.values({ ids: [words.cells.get('[6,0]').id], time: 0 });
    assert.equal(x.values[words.cells.get('[6,0]').id], 'x');
    assert.equal(groups.find(group => group.path === 'memory_dump.child.mem').width, 4);
    assert.equal(groups.some(group => group.name === 'packed_only'), false);
});
