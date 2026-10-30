'use strict';

const TYPES = new Set(['$mem', '$mem_v2']), MAX_PORTS = 16384, MAX_DESCRIBED_PORTS = 32;

function binary(value) {
    if (Number.isSafeInteger(value) && value >= 0) return value.toString(2);
    return typeof value === 'string' && /^[01xz]+$/i.test(value) ? value.toLowerCase() : undefined;
}
function count(value, fallback) {
    const bits = binary(value), number = bits && /^[01]+$/.test(bits) ? parseInt(bits, 2) : undefined;
    return Number.isSafeInteger(number) && number <= MAX_PORTS ? number : value === undefined ? fallback : undefined;
}
function mask(value, width) {
    const bits = binary(value);
    if (bits === undefined || width === undefined || width > MAX_PORTS) return undefined;
    if (bits.length > width && !/^0*$/.test(bits.slice(0, bits.length - width))) return undefined;
    return width === 0 ? [] : bits.slice(-width).padStart(width, '0').split('').reverse();
}
function side(cell, prefix, label) {
    const pin = prefix + '_CLK', port = cell.ports.find(port => port.name === pin);
    const width = count(cell.parameters?.[prefix + '_PORTS'], port?.bits.length);
    const enabled = mask(cell.parameters?.[prefix + '_CLK_ENABLE'], width);
    const edges = mask(cell.parameters?.[prefix + '_CLK_POLARITY'], width);
    const known = enabled?.every(bit => bit === '0' || bit === '1');
    const mode = width === 0 ? 'none' : !known ? 'unknown' : enabled.every(bit => bit === '0') ? 'async'
        : enabled.every(bit => bit === '1') ? 'sync' : 'mixed';
    const names = { none: '无' + label + '口', unknown: label + '模式未知', async: '异步' + label, sync: '同步' + label, mixed: '混合' + label };
    const details = [];
    for (let index = 0; index < Math.min(width || 0, MAX_DESCRIBED_PORTS); index++) {
        const name = pin + (width > 1 ? `[${index}]` : '');
        details.push(`${label}口${index}：` + (enabled?.[index] === '0' ? `异步${label}，${name} 未使用`
            : enabled?.[index] === '1' ? `同步${label}，${name} ${edges?.[index] === '1' ? '上升沿' : edges?.[index] === '0' ? '下降沿' : '极性未知'}`
                : `${name} 启用状态未知`));
    }
    if (width > MAX_DESCRIBED_PORTS) details.push(`其余${width - MAX_DESCRIBED_PORTS}个${label}口见工具参数`);
    const polarity = mode === 'sync' && edges?.length && edges.every(bit => bit === edges[0]) && /^[01]$/.test(edges[0]) ? Number(edges[0]) : undefined;
    return { pin, label: names[mode], description: details.join('；') || names[mode],
        hidden: mode === 'async' || mode === 'none', polarity };
}

/**
 * @param {object} cell 已验证的领域单元，参数保留工具原始编码。
 * @returns {object|null} 已知Yosys存储器的展示语义，不修改原始端口或连接。
 */
function memorySymbol(cell) {
    if (cell.moduleId || cell.kind !== 'memory' || !TYPES.has(cell.type)) return null;
    const sides = [side(cell, 'RD', '读'), side(cell, 'WR', '写')];
    return { symbol: 'MEM', modeLabel: sides.map(side => side.label).join(' · '),
        description: sides.map(side => side.description).join('；'),
        ports: Object.fromEntries(sides.map(side => [side.pin, { role: 'clock', polarity: side.polarity,
            description: side.description, hidden: side.hidden }])) };
}

module.exports = { memorySymbol };
