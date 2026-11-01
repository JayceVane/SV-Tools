'use strict';

// design scaffold：按规格生成 packed struct 虚拟接口、空模块与顶层连线，用于“先定架构、后填实现”。
// 生成物是源级骨架；struct 接口避免 SV interface，Yosys 会摊平为 m0.addr 等端口。
const { fail } = require('../agent/protocol');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIRECTIONS = new Set(['input', 'output', 'inout']);

/** @param {unknown} value 值。 @param {string} field 字段名。 @returns {object} 对象。 */
function objectOf(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('INVALID_ARGUMENT', 'design scaffold 规格字段 ' + field + ' 必须是对象');
    }
    return value;
}

/** @param {unknown} value 值。 @param {string} field 字段名。 @returns {unknown[]} 数组。 */
function arrayOf(value, field) {
    if (!Array.isArray(value) || !value.length) {
        fail('INVALID_ARGUMENT', 'design scaffold 规格字段 ' + field + ' 必须是非空数组');
    }
    return value;
}

/** @param {unknown} value 值。 @param {string} field 字段名。 @returns {string} 标识符。 */
function identifierOf(value, field) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
        fail('INVALID_ARGUMENT', 'design scaffold 规格字段 ' + field + ' 必须是合法标识符');
    }
    return value;
}

/** @param {unknown} value 值。 @param {string} field 字段名。 @returns {number} 位宽。 */
function widthOf(value, field) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65536) {
        fail('INVALID_ARGUMENT', 'design scaffold 规格字段 ' + field + ' 要求 1–65536 的整数位宽');
    }
    return value;
}

/** @param {object} spec 规格。 @returns {{typedefs:object[], buses:object[], modules:object[], top:object}} 已校验规格。 */
function validateSpec(spec) {
    objectOf(spec, 'root');
    if (spec.schemaVersion !== 1) {
        fail('INVALID_ARGUMENT', 'design scaffold 规格要求 schemaVersion=1');
    }
    const typedefs = [];
    const typeNames = new Set();
    for (const [index, raw] of arrayOf(spec.interfaces, 'interfaces').entries()) {
        const item = objectOf(raw, 'interfaces[' + index + ']');
        const type = identifierOf(item.type, 'interfaces[' + index + '].type');
        const typedefName = type.endsWith('_t') ? type : type + '_t';
        if (typeNames.has(typedefName)) {
            fail('INVALID_ARGUMENT', 'design scaffold 接口类型重复：' + typedefName);
        }
        typeNames.add(typedefName);
        const members = arrayOf(item.members, 'interfaces[' + index + '].members').map((member, memberIndex) => {
            const value = objectOf(member, 'interfaces[' + index + '].members[' + memberIndex + ']');
            return { name: identifierOf(value.name, 'interfaces[' + index + '].members[' + memberIndex + '].name'),
                width: widthOf(value.width, 'interfaces[' + index + '].members[' + memberIndex + '].width') };
        });
        const memberNames = new Set();
        for (const member of members) {
            if (memberNames.has(member.name)) {
                fail('INVALID_ARGUMENT', 'design scaffold 接口成员重复：' + typedefName + '.' + member.name);
            }
            memberNames.add(member.name);
        }
        typedefs.push({ type, typedefName, members });
    }
    const busTypes = new Map(typedefs.map(item => [item.type, item]));
    const buses = arrayOf(spec.buses, 'buses').map((raw, index) => {
        const item = objectOf(raw, 'buses[' + index + ']');
        const name = identifierOf(item.name, 'buses[' + index + '].name');
        const type = identifierOf(item.type, 'buses[' + index + '].type');
        if (!busTypes.has(type)) {
            fail('INVALID_ARGUMENT', 'design scaffold 总线 ' + name + ' 引用了未定义接口：' + type);
        }
        return { name, type };
    });
    const busNames = new Set();
    for (const bus of buses) {
        if (busNames.has(bus.name)) {
            fail('INVALID_ARGUMENT', 'design scaffold 总线名称重复：' + bus.name);
        }
        busNames.add(bus.name);
    }
    const modules = arrayOf(spec.modules, 'modules').map((raw, index) => {
        const item = objectOf(raw, 'modules[' + index + ']');
        const name = identifierOf(item.name, 'modules[' + index + '].name');
        const ports = arrayOf(item.ports, 'modules[' + index + '].ports').map((port, portIndex) => {
            const value = objectOf(port, 'modules[' + index + '].ports[' + portIndex + ']');
            const portName = identifierOf(value.name, 'modules[' + index + '].ports[' + portIndex + '].name');
            const type = identifierOf(value.type, 'modules[' + index + '].ports[' + portIndex + '].type');
            if (!busTypes.has(type)) {
                fail('INVALID_ARGUMENT', 'design scaffold 模块 ' + name + ' 端口 ' + portName + ' 引用了未定义接口：' + type);
            }
            if (value.role !== 'master' && value.role !== 'slave') {
                fail('INVALID_ARGUMENT', 'design scaffold 模块 ' + name + ' 端口 ' + portName + ' 的 role 必须是 master|slave');
            }
            const expected = value.role === 'master' ? 'm_' : 's_';
            if (!portName.startsWith(expected)) {
                fail('NAMING_VIOLATION', 'design scaffold 模块 ' + name + ' 端口 ' + portName + ' 违反 ' + value.role
                    + ' 命名约定：必须以 ' + expected + ' 开头', { module: name, port: portName, role: value.role });
            }
            const direction = value.direction || 'input';
            if (!DIRECTIONS.has(direction)) {
                fail('INVALID_ARGUMENT', 'design scaffold 模块 ' + name + ' 端口 ' + portName + ' 的 direction 必须是 input|output|inout');
            }
            return { name: portName, type, role: value.role, direction };
        });
        const portNames = new Set();
        for (const port of ports) {
            if (portNames.has(port.name)) {
                fail('INVALID_ARGUMENT', 'design scaffold 模块 ' + name + ' 端口重复：' + port.name);
            }
            portNames.add(port.name);
        }
        return { name, ports };
    });
    const moduleNames = new Set();
    for (const module of modules) {
        if (moduleNames.has(module.name)) {
            fail('INVALID_ARGUMENT', 'design scaffold 模块名称重复：' + module.name);
        }
        moduleNames.add(module.name);
    }
    const moduleMap = new Map(modules.map(module => [module.name, module]));
    const top = objectOf(spec.top, 'top');
    const topName = identifierOf(top.name, 'top.name');
    if (moduleNames.has(topName)) {
        fail('INVALID_ARGUMENT', 'design scaffold 顶层模块名不能与子模块重复：' + topName);
    }
    const instances = arrayOf(top.instances, 'top.instances').map((raw, index) => {
        const item = objectOf(raw, 'top.instances[' + index + ']');
        const name = identifierOf(item.name, 'top.instances[' + index + '].name');
        const module = identifierOf(item.module, 'top.instances[' + index + '].module');
        if (!moduleMap.has(module)) {
            fail('INVALID_ARGUMENT', 'design scaffold 顶层实例 ' + name + ' 引用了未定义模块：' + module);
        }
        const connections = objectOf(item.connections || {}, 'top.instances[' + index + '].connections');
        const ports = moduleMap.get(module).ports;
        for (const [portName, busName] of Object.entries(connections)) {
            const port = ports.find(candidate => candidate.name === portName);
            if (!port) {
                fail('INVALID_ARGUMENT', 'design scaffold 实例 ' + name + ' 连接了模块 ' + module + ' 不存在的端口：' + portName);
            }
            if (typeof busName !== 'string' || !busNames.has(busName)) {
                fail('INVALID_ARGUMENT', 'design scaffold 实例 ' + name + ' 的端口 ' + portName + ' 引用了未声明总线：' + String(busName));
            }
            const bus = buses.find(candidate => candidate.name === busName);
            if (bus.type !== port.type) {
                fail('INVALID_ARGUMENT', 'design scaffold 实例 ' + name + ' 的端口 ' + portName + ' 类型 ' + port.type
                    + ' 与总线 ' + busName + ' 类型 ' + bus.type + ' 不一致');
            }
        }
        return { name, module, connections };
    });
    const instanceNames = new Set();
    for (const instance of instances) {
        if (instanceNames.has(instance.name)) {
            fail('INVALID_ARGUMENT', 'design scaffold 顶层实例名称重复：' + instance.name);
        }
        instanceNames.add(instance.name);
    }
    return { typedefs, buses, modules, top: { name: topName, instances } };
}

/** @param {object} spec 已校验规格。 @returns {string} SystemVerilog 骨架文本。 */
function generateScaffold(spec) {
    const lines = [
        '// Generated by svtools design scaffold（schemaVersion=1）。',
        '// 架构骨架：packed struct 虚拟接口 + 空模块 + 顶层连线；请勿在此文件内写实现。',
        '// 这是源级结构，未综合、未做时序或功能验证。',
        ''
    ];
    for (const iface of spec.typedefs) {
        lines.push('typedef struct packed {');
        for (const member of iface.members) {
            lines.push('    logic ' + (member.width > 1 ? '[' + (member.width - 1) + ':0] ' : '') + member.name + ';');
        }
        lines.push('} ' + iface.typedefName + ';');
        lines.push('');
    }
    for (const module of spec.modules) {
        lines.push('// 空模块：只声明 packed struct 端口，体内为空。');
        lines.push('module ' + module.name + ' (');
        lines.push(module.ports.map(port => '    ' + port.direction.padEnd(6) + ' ' + (port.type.endsWith('_t') ? port.type : port.type + '_t')
            + ' ' + port.name).join(',\n'));
        lines.push(');');
        lines.push('endmodule');
        lines.push('');
    }
    lines.push('// 顶层：仅声明 struct 总线 wire 并例化子模块。');
    lines.push('module ' + spec.top.name + ' ();');
    for (const bus of spec.buses) {
        lines.push('    ' + (bus.type.endsWith('_t') ? bus.type : bus.type + '_t') + ' ' + bus.name + ';');
    }
    lines.push('');
    for (const instance of spec.top.instances) {
        const connections = Object.entries(instance.connections);
        lines.push('    ' + instance.module + ' ' + instance.name + ' (');
        if (connections.length) {
            lines.push(connections.map(([port, bus]) => '        .' + port + '(' + bus + ')').join(',\n'));
        }
        lines.push('    );');
    }
    lines.push('endmodule');
    lines.push('');
    return lines.join('\n');
}

module.exports = { validateSpec, generateScaffold };
