'use strict';

// 仅解释 Yosys 已知内部单元；用户模块和未识别单元不按引脚名猜测时序。
const TYPES = Object.freeze({
    $dff: ['DFF', 'D 型触发器', 'CLK'],
    $dffe: ['DFF', 'D 型触发器 · 使能', 'CLK', 'EN'],
    $adff: ['DFF', 'D 型触发器 · 异步复位', 'CLK', 'ARST'],
    $adffe: ['DFF', 'D 型触发器 · 异步复位与使能', 'CLK', 'ARST', 'EN'],
    $aldff: ['DFF', 'D 型触发器 · 异步装载', 'CLK', 'ALOAD', 'AD'],
    $aldffe: ['DFF', 'D 型触发器 · 异步装载与使能', 'CLK', 'ALOAD', 'AD', 'EN'],
    $dffsr: ['DFF', 'D 型触发器 · 异步置位/清零', 'CLK', 'SET', 'CLR'],
    $dffsre: ['DFF', 'D 型触发器 · 异步置位/清零与使能', 'CLK', 'SET', 'CLR', 'EN'],
    $sdff: ['DFF', 'D 型触发器 · 同步复位', 'CLK', 'SRST'],
    $sdffe: ['DFF', 'D 型触发器 · 同步复位优先于使能', 'CLK', 'SRST', 'EN'],
    $sdffce: ['DFF', 'D 型触发器 · 使能优先于同步复位', 'CLK', 'SRST', 'EN'],
    $dlatch: ['LATCH', '电平敏感锁存器', 'EN'],
    $adlatch: ['LATCH', '电平敏感锁存器 · 异步复位', 'ARST', 'EN'],
    $dlatchsr: ['LATCH', '电平敏感锁存器 · 异步置位/清零', 'SET', 'CLR', 'EN'],
    $sr: ['SR', '置位/清零锁存器 · 清零优先', 'SET', 'CLR'],
    $ff: ['FF', '隐式全局时钟触发器'],
});
const CONTROLS = Object.freeze({ ALOAD: '异步装载', ARST: '异步复位', SRST: '同步复位',
    SET: '异步置位', CLR: '异步清零', EN: '使能' });

function polarity(value) {
    if (value === 0 || value === 1) return value;
    if (typeof value !== 'string' || !/^0*[01]$/.test(value)) return undefined;
    return Number(value.at(-1));
}
function valueText(value) {
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string' || !/^[01xz]+$/i.test(value)) return '未知';
    return `${value.length}'b${value.slice(0, 64)}${value.length > 64 ? '…' : ''}`;
}
function loadData(cell) {
    const bits = cell.ports.find(port => port.name === 'AD')?.bits || [];
    if (!bits.length || !bits.every(bit => /^c:[01xz]$/.test(bit))) return '';
    const value = bits.slice(-64).reverse().map(bit => bit.slice(2)).join('');
    return `（常量 ${bits.length === 1 ? value : `${bits.length}'b${bits.length > 64 ? '…' : ''}${value}`}）`;
}
function control(cell, name) {
    const level = polarity(cell.parameters?.[name + '_POLARITY']);
    const active = level === undefined ? '极性未知' : level ? '高电平有效' : '低电平有效';
    let description = `${CONTROLS[name]}，${active}`;
    if (name === 'ALOAD') description += `；Q ← AD${loadData(cell)}`;
    if (name === 'ARST' || name === 'SRST') description += `；Q ← ${valueText(cell.parameters?.[name + '_VALUE'])}`;
    return { role: 'control', polarity: level, description };
}

/**
 * 从明确的内部单元类型及参数生成展示语义；不优化或改写网表。
 * @param {object} cell 已验证的领域单元，parameters 使用工具原始编码。
 * @returns {object|null} 符号、说明和按原引脚名索引的展示角色；不支持的类型返回 null。
 */
function registerSymbol(cell) {
    if (cell.moduleId || cell.kind !== 'register' || !Object.hasOwn(TYPES, cell.type)) return null;
    const [symbol, description, ...names] = TYPES[cell.type];
    const ports = { D: { role: 'data', description: '数据输入' }, Q: { role: 'data', description: '状态输出' } };
    for (const name of names) {
        if (name === 'CLK') {
            const edge = polarity(cell.parameters?.CLK_POLARITY);
            ports.CLK = { role: 'clock', polarity: edge, description: edge === undefined ? '时钟，极性未知' : `时钟，${edge ? '上升' : '下降'}沿触发` };
        } else if (name === 'AD') ports.AD = { role: 'data', description: '异步装载数据' };
        else ports[name] = control(cell, name);
    }
    return { symbol, description, ports };
}

module.exports = { registerSymbol };
