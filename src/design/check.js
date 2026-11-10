'use strict';

// design check：把展开后的顶层结构事实转为逐端口诊断。与 arch 数据同源：同一份源码
// 产生的 checks 顺序与内容确定；只报告结构事实（悬空、无驱动、多驱动、位宽、缺失模块），
// 不构成功能、时序或 CDC 结论。网络分析只统计 n: 网络 bit，常量/悬空（c:0/1/x/z）不参与
// 端口间连接，避免常量端口之间被误判为相连或多驱动。
const { findModule } = require('../circuit/model');
const { fail } = require('../agent/protocol');
const path = require('node:path');

const CHECKS_LIMIT = 5000;

/** @param {string} workspace @param {string} file @returns {string} 相对工作区的 POSIX 路径。 */
function relativePosix(workspace, file) {
    const relative = path.relative(workspace, file);
    return (relative || path.basename(file)).split(path.sep).join('/');
}

/** @param {object|undefined} source 已映射来源。 @param {string} workspace @returns {object|undefined} 相对工作区的来源。 */
function relativeSource(source, workspace) {
    if (!source || typeof source.path !== 'string') {
        return undefined;
    }
    const result = { file: relativePosix(workspace, source.path) };
    if (Number.isSafeInteger(source.line)) {
        result.line = source.line;
    }
    if (Number.isSafeInteger(source.column)) {
        result.column = source.column;
    }
    return result;
}

/** @param {string} endpoint 端点 id（nodeId/portName）。 @returns {{nodeId:string, portName:string}} 拆分的节点与端口名。 */
function splitEndpoint(endpoint) {
    const index = endpoint.lastIndexOf('/');
    return { nodeId: endpoint.slice(0, index), portName: endpoint.slice(index + 1) };
}

/** @param {string} id 节点 id。 @returns {string} 实例或边界节点名。 */
function endpointName(id) {
    return id.startsWith('boundary:') ? id.slice('boundary:'.length) : id.slice('instance:'.length);
}

/** @param {object} cell 顶层单元。 @returns {boolean} 是否用户模块实例。 */
function isUserInstance(cell) {
    return Boolean(cell.moduleId) || !String(cell.type || '').startsWith('$');
}

/** @param {string} bit Yosys bit。 @returns {boolean} 是否网络 bit。 */
function isNetBit(bit) {
    return typeof bit === 'string' && bit.startsWith('n:');
}

/** @param {string} bit Yosys bit。 @returns {boolean} 是否悬空值（x/z）。 */
function isDanglingBit(bit) {
    return bit === 'c:x' || bit === 'c:z';
}

/** @param {string} endpoint 端点 id。 @returns {boolean} 是否顶层边界端点。 */
function isBoundary(endpoint) {
    return endpoint.startsWith('boundary:');
}

/**
 * 记录一个网络诊断。checks 按 severity/code/端点排序，同端点的位宽信息聚合在一条。
 * @param {object[]} checks 诊断列表。 @param {object} entry 诊断。
 */
function pushCheck(checks, entry) {
    checks.push(entry);
    if (checks.length > CHECKS_LIMIT) {
        fail('DESIGN_LIMIT', '结构诊断数量超出预算', { kind: 'checks', limit: CHECKS_LIMIT });
    }
}

/** @param {object[]} checks 排序（severity>code>端点>端口），保证同源码输出确定。 */
function sortChecks(checks) {
    const rank = { error: 0, warning: 1 };
    const keyOf = check => String(check.details.drivers?.[0] || check.details.instance || check.details.port || '');
    return checks.sort((left, right) => (rank[left.severity] - rank[right.severity])
        || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0)
        || (keyOf(left) < keyOf(right) ? -1 : keyOf(left) > keyOf(right) ? 1 : 0));
}

/**
 * 检查顶层结构：缺失模块、悬空端口、位宽不一致、网络无驱动/多驱动。
 * @param {object} design fromYosys 结果。 @param {object} module 顶层模块。 @param {string} workspace 工作区。
 * @returns {object[]} 结构诊断列表（code/severity/message/details/source）。
 */
function checkStructure(design, module, workspace) {
    const checks = [];
    const cells = module.cells.filter(isUserInstance);
    // 网络端点图：bit → {drivers, sinks, ambiguous}（端点 id 为 instance:<名>/<端口> 或 boundary:<端口>）。
    const endpoints = new Map();
    const track = (bit, direction, endpoint) => {
        if (!endpoints.has(bit)) {
            endpoints.set(bit, { drivers: new Set(), sinks: new Set(), ambiguous: new Set() });
        }
        const entry = endpoints.get(bit);
        if (direction === 'output') {
            entry.drivers.add(endpoint);
        } else if (direction === 'input') {
            entry.sinks.add(endpoint);
        } else {
            entry.ambiguous.add(endpoint);
        }
    };
    for (const port of module.ports) {
        for (const bit of port.bits) {
            if (isNetBit(bit)) {
                // 顶层输入端口对内部网络是驱动者，输出是接收者。
                track(bit, port.direction === 'input' ? 'output' : port.direction === 'output' ? 'input' : 'inout',
                    'boundary:' + port.name);
            }
        }
    }
    for (const cell of cells) {
        const target = cell.moduleId ? findModule(design, cell.moduleId) : null;
        if (!target) {
            const source = relativeSource(cell.source, workspace);
            pushCheck(checks, {
                code: 'UNRESOLVED_MODULE', severity: 'error',
                message: '实例 ' + cell.name + ' 引用的模块 ' + cell.type + ' 未在工作区声明，架构按无端口盒展示',
                details: { instance: cell.name, module: cell.type }, ...(source ? { source } : {})
            });
            continue;
        }
        for (const port of target.ports) {
            const connection = cell.ports.find(item => item.name === port.name);
            const bits = connection ? connection.bits : [];
            const source = relativeSource(port.source, workspace);
            if (!bits.length || bits.every(isDanglingBit)) {
                // 悬空：input 无输入来源是错误，output/inout 悬空常见于有意不接，降为警告。
                const input = port.direction === 'input';
                pushCheck(checks, {
                    code: input ? 'UNDRIVEN_INPUT' : 'UNCONNECTED_PORT', severity: input ? 'error' : 'warning',
                    message: '实例 ' + cell.name + ' 的 ' + port.direction + ' 端口 ' + port.name + '（' + port.bits.length + ' 位）'
                        + (input ? '未连接，输入悬空' : '未连接'),
                    details: { instance: cell.name, module: cell.type, port: port.name, direction: port.direction,
                        declaredWidth: port.bits.length }, ...(source ? { source } : {})
                });
                continue;
            }
            for (const bit of bits) {
                if (isNetBit(bit)) {
                    track(bit, port.direction, 'instance:' + cell.name + '/' + port.name);
                }
            }
            // Yosys 会把窄于声明的连接补常量位（0/1/x）到端口宽：net 位与常量位混合即隐式扩展；
            // 宽 wire 连窄端口的截断在展开后不可见，不虚构报告（见 limitations）。
            const netBits = bits.filter(isNetBit).length, implicitBits = bits.filter(bit => typeof bit === 'string' && bit.startsWith('c:')).length;
            if (netBits && implicitBits) {
                pushCheck(checks, {
                    code: 'WIDTH_MISMATCH', severity: 'warning',
                    message: '实例 ' + cell.name + ' 端口 ' + port.name + ' 连接的网络仅 ' + netBits + ' 位，声明 '
                        + port.bits.length + ' 位，其余 ' + implicitBits + ' 位由工具隐式补常量',
                    details: { instance: cell.name, module: cell.type, port: port.name, direction: port.direction,
                        declaredWidth: port.bits.length, connectedWidth: netBits, implicitBits }, ...(source ? { source } : {})
                });
            }
        }
    }
    // 网络诊断按端点聚合位宽，避免逐位膨胀。
    const undriven = new Map(), multiDriver = new Map(), undrivenOutputs = new Map();
    const record = (map, endpoint, bit) => {
        if (!map.has(endpoint)) {
            map.set(endpoint, []);
        }
        map.get(endpoint).push(bit);
    };
    for (const [bit, entry] of endpoints) {
        if (!entry.drivers.size) {
            for (const sink of entry.sinks) {
                if (isBoundary(sink)) {
                    record(undrivenOutputs, sink, bit);
                } else {
                    record(undriven, sink, bit);
                }
            }
        }
        if (entry.drivers.size > 1) {
            const key = [...entry.drivers].sort().join('+');
            if (!multiDriver.has(key)) {
                multiDriver.set(key, { drivers: [...entry.drivers].sort(), bits: [] });
            }
            multiDriver.get(key).bits.push(bit);
        }
    }
    const netNamesOf = bits => [...new Set(bits.flatMap(bit => module.signals.filter(signal =>
        !signal.hidden && signal.bits.includes(bit)).map(signal => signal.name)))].sort();
    for (const [endpoint, bits] of undriven) {
        const { nodeId, portName } = splitEndpoint(endpoint);
        const instance = endpointName(nodeId);
        pushCheck(checks, {
            code: 'UNDRIVEN_INPUT', severity: 'error',
            message: '实例 ' + instance + ' 的 input 端口 ' + portName + '（' + bits.length + ' 位）所在网络没有任何驱动',
            details: { instance, port: portName, width: bits.length, netNames: netNamesOf(bits) }
        });
    }
    for (const [endpoint, bits] of undrivenOutputs) {
        const portName = endpoint.slice('boundary:'.length);
        pushCheck(checks, {
            code: 'UNDRIVEN_OUTPUT', severity: 'warning',
            message: '顶层输出端口 ' + portName + '（' + bits.length + ' 位）没有被任何实例驱动',
            details: { port: portName, width: bits.length, netNames: netNamesOf(bits) }
        });
    }
    for (const group of multiDriver.values()) {
        const drivers = group.drivers.map(endpoint => {
            const { nodeId, portName } = splitEndpoint(endpoint);
            return isBoundary(endpoint) ? portName : endpointName(nodeId) + '/' + portName;
        });
        pushCheck(checks, {
            code: 'MULTI_DRIVER', severity: 'error',
            message: '网络被多个输出端口驱动（' + drivers.join('、') + '，' + group.bits.length + ' 位）',
            details: { drivers, width: group.bits.length, netNames: netNamesOf(group.bits) }
        });
    }
    return sortChecks(checks);
}

module.exports = { checkStructure, CHECKS_LIMIT };
