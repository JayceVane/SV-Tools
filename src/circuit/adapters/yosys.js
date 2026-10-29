'use strict';

const path = require('path');
const { createDesign, MAX_BIT_REFERENCES } = require('../model');

function object(value, where) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Yosys JSON ${where}: expected an object`);
    return value;
}
function entries(value, where) { return Object.entries(object(value, where)); }
function optionalObject(value, where) { return value === undefined ? {} : object(value, where); }
function id(...parts) { return parts.map(part => encodeURIComponent(part)).join('/'); }
function direction(value) { return value === undefined ? 'unknown' : value; }
function bit(value) {
    if (Number.isSafeInteger(value) && value >= 0) return `n:${value}`;
    if (typeof value === 'string' && /^[01xz]$/.test(value)) return `c:${value}`;
    throw new TypeError(`Yosys JSON: invalid bit ${String(value).slice(0, 80)}`);
}
function source(attributes, sourceRoot) {
    if (!attributes || typeof attributes.src !== 'string') return undefined;
    // 贪婪路径匹配保留 Windows 盘符；多个 src 位置采用第一个可解析位置。
    for (const location of attributes.src.split('|')) {
        const match = /^(.*):(\d+)\.(\d+)(?:-.*)?$/.exec(location);
        if (!match || !match[1]) continue;
        const file = match[1], absolute = path.isAbsolute(file) || path.win32.isAbsolute(file);
        return { path: sourceRoot && !absolute ? path.resolve(sourceRoot, file) : file, line: Number(match[2]), column: Number(match[3]) };
    }
    return undefined;
}
function range(raw) {
    const result = {};
    if (raw.offset !== undefined) result.offset = raw.offset;
    if (raw.upto !== undefined) {
        if (![0, 1, false, true].includes(raw.upto)) throw new TypeError('Yosys JSON: upto must be 0 or 1');
        result.upto = Boolean(raw.upto);
    }
    return result;
}
function cellKind(type, isModule) {
    if (isModule) return 'instance';
    if (/^\$(?:[as]?dff|aldff|sdff|a?dlatch|sr|ff|_.*(?:DFF|DFFE|DLATCH|SR))/.test(type)) return 'register';
    if (/^\$(?:mem|_.*RAM)/.test(type)) return 'memory';
    if (/^\$(?:[bp]?mux|demux|_.*MUX)/.test(type)) return 'mux';
    if (/^\$(?:add|sub|neg|mul|div|mod|pow|alu|macc|fa|lcu|shl|shr|sshl|sshr|shift|shiftx)(?:$|_)/.test(type)) return 'arithmetic';
    if (/^\$(?:not|pos|and|or|xor|xnor|reduce_|logic_|eq|ne|lt|le|gt|ge|lut|sop|tribuf|concat|slice|_)/.test(type)) return 'logic';
    return 'unknown';
}

/**
 * @param {unknown} raw Yosys write_json 对象。
 * @param {{top?:string,title?:string,sourceRoot?:string,stage?:string}} options 可选 top 名或稳定 ID；生成入口显式声明阶段。
 * @returns {object} 独立电路领域模型，bits 均为 LSB-first。
 * @throws {TypeError|RangeError} 非法 JSON、歧义 top、连接或模型预算错误。
 */
function fromYosys(raw, { top, title, sourceRoot, stage = 'netlist' } = {}) {
    object(raw, 'design');
    const moduleEntries = entries(raw.modules, 'modules');
    if (!moduleEntries.length) throw new TypeError('Yosys JSON: no modules');
    const moduleIds = new Map(moduleEntries.map(([name]) => [name, id('module', name)]));
    const referenced = new Set();
    let bitReferences = 0;
    function bits(value, where) {
        if (!Array.isArray(value)) throw new TypeError(`Yosys JSON ${where}: expected bits array`);
        bitReferences += value.length;
        if (bitReferences > MAX_BIT_REFERENCES) throw new RangeError(`Yosys JSON exceeds ${MAX_BIT_REFERENCES.toLocaleString('en-US')} bit references; select a smaller design`);
        return Array.from(value, bit);
    }
    const modules = moduleEntries.map(([name, rawModule]) => {
        object(rawModule, `module ${name}`);
        for (const field of ['processes', 'memories']) {
            if (Object.keys(optionalObject(rawModule[field], `${name}.${field}`)).length) {
                throw new TypeError(`Yosys JSON ${name}: unlowered ${field}; run prep (or proc and memory_collect) before write_json`);
            }
        }
        const moduleId = moduleIds.get(name), attributes = optionalObject(rawModule.attributes, `${name}.attributes`);
        const netnames = optionalObject(rawModule.netnames, `${name}.netnames`);
        const ports = entries(rawModule.ports, `${name}.ports`).map(([portName, rawPort]) => {
            object(rawPort, `${name}.ports.${portName}`);
            const net = Object.hasOwn(netnames, portName) ? netnames[portName] : {};
            return { id: id(moduleId, 'port', portName), name: portName, direction: direction(rawPort.direction), bits: bits(rawPort.bits, `${name}.${portName}`), ...range(net), ...range(rawPort), source: source(net.attributes, sourceRoot) };
        });
        const cells = Object.entries(optionalObject(rawModule.cells, `${name}.cells`)).map(([cellName, rawCell]) => {
            object(rawCell, `${name}.cells.${cellName}`);
            if (typeof rawCell.type !== 'string' || !rawCell.type) throw new TypeError(`Yosys JSON ${name}.${cellName}: missing cell type`);
            const cellId = id(moduleId, 'cell', cellName), childId = moduleIds.get(rawCell.type);
            if (childId) referenced.add(childId);
            const directions = optionalObject(rawCell.port_directions, `${name}.${cellName}.port_directions`);
            const childPorts = childId ? object(raw.modules[rawCell.type].ports, `${rawCell.type}.ports`) : {};
            const cellPorts = entries(rawCell.connections, `${name}.${cellName}.connections`).map(([portName, connection]) => ({
                id: id(cellId, 'port', portName), name: portName,
                direction: direction(Object.hasOwn(directions, portName) ? directions[portName] : Object.hasOwn(childPorts, portName) ? childPorts[portName].direction : undefined),
                bits: bits(connection, `${name}.${cellName}.${portName}`),
                ...(Object.hasOwn(childPorts, portName) ? range(childPorts[portName]) : {}),
            }));
            const cell = { id: cellId, name: cellName, type: rawCell.type, kind: cellKind(rawCell.type, Boolean(childId)), ports: cellPorts, parameters: rawCell.parameters, attributes: rawCell.attributes, source: source(rawCell.attributes, sourceRoot) };
            if (childId) cell.moduleId = childId;
            return cell;
        });
        const signals = entries(netnames, `${name}.netnames`).map(([signalName, net]) => {
            object(net, `${name}.netnames.${signalName}`);
            if (net.hide_name !== undefined && ![0, 1, false, true].includes(net.hide_name)) throw new TypeError('Yosys JSON: hide_name must be 0 or 1');
            return { id: id(moduleId, 'signal', signalName), name: signalName, bits: bits(net.bits, `${name}.${signalName}`), ...range(net), hidden: Boolean(net.hide_name),
                source: source(net.attributes, sourceRoot) };
        });
        return { id: moduleId, name, source: source(attributes, sourceRoot), ports, cells, signals, attributes, parameters: rawModule.parameter_default_values };
    });
    let topId = moduleIds.get(top) || (modules.some(module => module.id === top) ? top : undefined);
    if (top !== undefined && !topId) throw new TypeError(`Yosys JSON: unknown top ${top}`);
    if (!topId) {
        const marked = modules.filter(module => module.attributes.top === 1 || module.attributes.top === true || (typeof module.attributes.top === 'string' && /^0*1$/.test(module.attributes.top)));
        const candidates = marked.length ? marked : modules.filter(module => !referenced.has(module.id));
        if (candidates.length !== 1) throw new TypeError('Yosys JSON: multiple possible top modules; choose a top explicitly');
        topId = candidates[0].id;
    }
    const creator = typeof raw.creator === 'string' && raw.creator ? raw.creator : 'unknown';
    return createDesign({ schemaVersion: 1, title: title || modules.find(module => module.id === topId).name, top: topId, provenance: { engine: 'yosys', version: creator, stage }, modules });
}

module.exports = { fromYosys };
