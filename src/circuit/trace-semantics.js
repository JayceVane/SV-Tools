'use strict';

function integer(value) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value !== 'string' || !/^[01]{1,53}$/.test(value)) return undefined;
    const result = Number.parseInt(value, 2);
    return Number.isSafeInteger(result) ? result : undefined;
}
function sameWidth(ports, names) {
    return names.every(name => ports.get(name)?.bits.length > 0 && ports.get(name).bits.length === ports.get(names[0]).bits.length);
}
function point(ports, name, position, role = 'data') {
    const port = ports.get(name);
    return port && position >= 0 && position < port.bits.length ? { portId: port.id, position, role } : null;
}
function* bitwiseTargets({ policy, ports, pin, direction }) {
    const inputs = policy.names.filter(name => name !== 'Y');
    if (direction === 'drivers' && pin.name === 'Y') {
        for (const name of inputs) yield point(ports, name, pin.position);
    } else if (direction === 'loads' && inputs.includes(pin.name)) yield point(ports, 'Y', pin.position);
}
function* muxTargets({ ports, pin, direction }) {
    if (direction === 'drivers' && pin.name === 'Y') {
        for (const name of ['A', 'B']) yield point(ports, name, pin.position);
        yield point(ports, 'S', 0, 'select');
    } else if (direction === 'loads' && pin.name === 'S') {
        for (let position = 0; position < ports.get('Y').bits.length; position++) yield point(ports, 'Y', position, 'select');
    } else if (direction === 'loads' && ['A', 'B'].includes(pin.name)) yield point(ports, 'Y', pin.position);
}
function* concatTargets({ ports, pin, direction }) {
    const offset = ports.get('A').bits.length;
    if (direction === 'drivers' && pin.name === 'Y') {
        yield pin.position < offset ? point(ports, 'A', pin.position) : point(ports, 'B', pin.position - offset);
    } else if (direction === 'loads' && ['A', 'B'].includes(pin.name)) {
        yield point(ports, 'Y', pin.position + (pin.name === 'B' ? offset : 0));
    }
}
function* sliceTargets({ cell, ports, pin, direction }) {
    const offset = integer(cell.parameters?.OFFSET);
    if (direction === 'drivers' && pin.name === 'Y') yield point(ports, 'A', pin.position + offset);
    else if (direction === 'loads' && pin.name === 'A') {
        const target = point(ports, 'Y', pin.position - offset);
        if (target) yield target;
    }
}

// 具体单元族只在此注册；查询和遍历不随新增单元修改。
const POLICIES = [
    { types: ['$pos', '$not', '$_BUF_', '$_NOT_'], names: ['A', 'Y'], relation: 'bitwise',
        valid: (_cell, ports) => sameWidth(ports, ['A', 'Y']), targets: bitwiseTargets },
    { types: ['$and', '$or', '$xor', '$xnor', '$_AND_', '$_OR_', '$_XOR_', '$_XNOR_', '$_NAND_', '$_NOR_'], names: ['A', 'B', 'Y'], relation: 'bitwise',
        valid: (_cell, ports) => sameWidth(ports, ['A', 'B', 'Y']), targets: bitwiseTargets },
    { types: ['$mux', '$_MUX_'], names: ['A', 'B', 'S', 'Y'], relation: 'mux',
        valid: (_cell, ports) => sameWidth(ports, ['A', 'B', 'Y']) && ports.get('S').bits.length === 1, targets: muxTargets },
    { types: ['$concat'], names: ['A', 'B', 'Y'], relation: 'concat',
        valid: (_cell, ports) => ports.get('Y').bits.length === ports.get('A').bits.length + ports.get('B').bits.length, targets: concatTargets },
    { types: ['$slice'], names: ['A', 'Y'], relation: 'slice', valid: (cell, ports) => {
        const offset = integer(cell.parameters?.OFFSET);
        return offset !== undefined && ports.get('A').bits.length >= offset + ports.get('Y').bits.length;
    }, targets: sliceTargets }
];
const policyByType = new Map(POLICIES.flatMap(policy => policy.types.map(type => [type, policy])));

function* conservativeTargets(cell, direction) {
    const wanted = direction === 'drivers' ? 'input' : 'output';
    for (const port of cell.ports) if (port.direction === wanted) {
        for (let position = 0; position < port.bits.length; position++) yield { portId: port.id, position, role: 'candidate' };
    }
}

/**
 * 单元内的结构位依赖；不证明布尔可敏化性或RTL语句对应关系。
 * @param {object} cell 已验证单元。
 * @param {{portId:string,position:number}} pin 进入单元的原始端口位置。
 * @param {'drivers'|'loads'} direction 追踪方向。
 * @returns {{precision:string,relation:string,targets:Iterable<object>}} 惰性枚举，调用者负责工作预算。
 */
function cellDependencies(cell, pin, direction) {
    if (!['drivers', 'loads'].includes(direction)) throw new TypeError('单元依赖方向必须为drivers或loads');
    const ports = new Map(cell.ports.map(port => [port.name, port]));
    const port = cell.ports.find(port => port.id === pin.portId);
    if (!port || !Number.isSafeInteger(pin.position) || pin.position < 0 || pin.position >= port.bits.length) throw new RangeError('单元依赖端口位置不存在');
    const policy = policyByType.get(cell.type);
    const combinational = !cell.moduleId && !['register', 'memory'].includes(cell.kind);
    if (combinational && policy && ports.size === cell.ports.length && ports.size === policy.names.length
        && policy.names.every(name => ports.has(name) && ports.get(name).direction === (name === 'Y' ? 'output' : 'input')) && policy.valid(cell, ports)) {
        return { precision: 'bit', relation: policy.relation,
            targets: policy.targets({ policy, cell, ports, pin: { ...pin, name: port.name }, direction }) };
    }
    return { precision: 'cell', relation: cell.kind === 'register' ? 'temporal-conservative' : 'conservative',
        targets: conservativeTargets(cell, direction) };
}

module.exports = { cellDependencies };
