'use strict';
const { createDesign } = require('../model');
const DIRECTIONS = Object.freeze({ IN: 'input', OUT: 'output', INOUT: 'inout' });

function cellKind(cell) {
    if (cell.isBlackbox) return 'instance';
    if (cell.isSequential || /^(RTL_REG|FD|LD|SRL)/i.test(cell.type)) return 'register';
    if (/^(RTL_)?(MUX|MUXF)/i.test(cell.type)) return 'mux';
    if (/^(RTL_)?(ADD|SUB|MULT|DIV|MOD|SHIFT|SHL|SHR|CMP)|^(DSP|CARRY)/i.test(cell.type)) return 'arithmetic';
    if (/^(RTL_)?(RAM|ROM|MEM)|^(RAMB|URAM)/i.test(cell.type)) return 'memory';
    if (/^(RTL_)?(AND|OR|XOR|NOT|NAND|NOR|XNOR|BUF)|^(LUT|GND|VCC|IBUF|OBUF|IOBUF)/i.test(cell.type)) return 'logic';
    return 'unknown';
}

function requiredText(value, label) {
    if (typeof value !== 'string' || !value) throw new TypeError('Vivado ' + label + ' 必须是非空字符串');
    return value;
}

/** 按 Vivado 显式总线元数据归并位，连接只来自 canonical net，绝不由名称推断。 */
function groupBits(records, owner, isPort, toBit) {
    if (!Array.isArray(records)) throw new TypeError('Vivado 位对象必须是数组');
    const groups = new Map();
    for (const record of records) {
        if (!record || typeof record !== 'object') throw new TypeError('Vivado 位对象无效');
        const name = requiredText(record.name, '位名称');
        const isBus = record.busName !== undefined;
        const groupName = isBus ? requiredText(record.busName, '总线名称') : name;
        if (isBus && (![record.left, record.right, record.index].every(Number.isSafeInteger)
            || record.index < Math.min(record.left, record.right) || record.index > Math.max(record.left, record.right))) {
            throw new Error('Vivado 总线索引无效：' + name);
        }
        const direction = DIRECTIONS[record.direction] || 'unknown';
        const group = groups.get(groupName) || { name: groupName, direction, isBus, left: record.left, right: record.right, records: new Map() };
        if (group.isBus !== isBus || group.left !== record.left || group.right !== record.right || (isPort && group.direction !== direction)) {
            throw new Error('Vivado 总线元数据冲突：' + groupName);
        }
        const index = isBus ? record.index : 0;
        if (group.records.has(index)) throw new Error('Vivado 重复位对象：' + name);
        group.records.set(index, { name, bit: toBit(record, owner) }); groups.set(groupName, group);
    }
    return [...groups.values()].flatMap(group => {
        const ordered = [...group.records].sort((a, b) => group.left < group.right ? b[0] - a[0] : a[0] - b[0]);
        if (group.isBus && ordered.length !== Math.abs(group.left - group.right) + 1) {
            if (isPort) throw new Error('Vivado 总线位缺失：' + group.name);
            // 详细化可能保留稀疏内部网络，只展示真实存在的位，不补造缺失连接。
            return ordered.map(([, record]) => ({ id: owner + ':' + encodeURIComponent(record.name), name: record.name, bits: [record.bit] }));
        }
        const result = { id: owner + ':' + encodeURIComponent(group.name), name: group.name, bits: ordered.map(([, record]) => record.bit) };
        if (isPort) result.direction = group.direction;
        if (group.isBus) { result.offset = Math.min(group.left, group.right); result.upto = group.left < group.right; }
        return result;
    });
}

/**
 * 将 Vivado 对象导出转换为与 Yosys 无关的电路模型；目前明确为平面 RTL 详细化视图。
 * @param {object} raw vivado-export.tcl 的完整输出。
 * @param {{title?:string}} [options]
 * @returns {object} 经 createDesign 校验的 schemaVersion=1 模型。
 * @throws {Error} 引擎/阶段不符、位缺失、重复、总线元数据冲突或模型无效。
 */
function fromVivado(raw, { title } = {}) {
    if (!raw || raw.schemaVersion !== 1 || raw.engine !== 'vivado' || raw.stage !== 'elaborated-rtl' || raw.view !== 'flat') {
        throw new Error('不是支持的 Vivado RTL 电路导出（schema 1，flat elaborated-rtl）');
    }
    const top = requiredText(raw.top, '顶层');
    if (!Array.isArray(raw.cells)) throw new TypeError('Vivado cells 必须是数组');
    const bitIds = new Map();
    const toBit = (record, owner) => {
        const key = record.net === null ? JSON.stringify(['unconnected', owner, record.name])
            : JSON.stringify(['net', requiredText(record.net, '网络标识')]);
        if (!bitIds.has(key)) bitIds.set(key, 'n:v' + bitIds.size);
        return bitIds.get(key);
    };
    const cells = raw.cells.map(cell => {
        const name = requiredText(cell?.name, '单元名称'), type = requiredText(cell.type, '单元类型');
        if (typeof cell.isSequential !== 'boolean' || typeof cell.isBlackbox !== 'boolean') throw new TypeError('Vivado 单元标志必须是布尔值');
        const id = 'cell:' + encodeURIComponent(name);
        const result = { id, name, type, kind: cellKind(cell), ports: groupBits(cell.ports, id + ':port', true, toBit),
            attributes: { isBlackbox: !!cell.isBlackbox } };
        if (cell.source) result.source = cell.source;
        return result;
    });
    return createDesign({ schemaVersion: 1, title: title || top, top, provenance: {
        engine: 'vivado', version: requiredText(raw.version, '版本'), stage: raw.stage, hierarchy: 'flat'
    }, modules: [{ id: top, name: top, ports: groupBits(raw.ports, 'port:top', true, toBit), cells,
        signals: groupBits(raw.signals, 'signal', false, toBit), attributes: { view: 'flat', hierarchy: 'qualified-leaf-cells' } }] });
}

module.exports = { fromVivado };
