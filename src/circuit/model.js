'use strict';

const MAX_BIT_REFERENCES = 2_000_000;
const DIRECTIONS = new Set(['input', 'output', 'inout', 'unknown']);
const CELL_KINDS = new Set(['register', 'mux', 'arithmetic', 'logic', 'memory', 'instance', 'unknown']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(where, message) { throw new TypeError(`Circuit model ${where}: ${message}`); }
function record(value, where) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(where, 'expected an object');
    return value;
}
function string(value, where) {
    if (typeof value !== 'string' || !value.length) fail(where, 'expected a non-empty string');
    return value;
}
function array(value, where) {
    if (!Array.isArray(value)) fail(where, 'expected an array');
    return value;
}
function metadata(value, where) {
    if (value === undefined) return undefined;
    record(value, where);
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) fail(where, `unsafe metadata key ${key}`);
        if (!['string', 'number', 'boolean'].includes(typeof item) && item !== null) fail(where, 'metadata values must be scalar');
        if (typeof item === 'number' && !Number.isFinite(item)) fail(where, 'metadata numbers must be finite');
        output[key] = item;
    }
    return output;
}
function source(value, where) {
    if (value === undefined) return undefined;
    record(value, where);
    const result = { path: string(value.path, `${where}.path`) };
    for (const key of ['line', 'column']) {
        if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail(where, `${key} must be a positive integer`);
        result[key] = value[key];
    }
    return result;
}
function withOptional(target, key, value) { if (value !== undefined) target[key] = value; }
function range(input, output, where) {
    if (input.offset !== undefined) {
        if (!Number.isSafeInteger(input.offset)) fail(where, 'offset must be a safe integer');
        if (!Number.isSafeInteger(input.offset + Math.max(0, input.bits.length - 1))) fail(where, 'range exceeds safe integer bounds');
        output.offset = input.offset;
    }
    if (input.upto !== undefined) {
        if (typeof input.upto !== 'boolean') fail(where, 'upto must be a boolean');
        output.upto = input.upto;
    }
}

/**
 * @param {unknown} input 不含布局信息的电路设计。
 * @returns {object} 验证并复制的 schemaVersion=1 领域模型。
 * @throws {TypeError|RangeError} 缺失字段、重复标识、非法连接或超过位引用预算。
 */
function createDesign(input) {
    record(input, 'design');
    if (input.schemaVersion !== 1) fail('design', 'unsupported schemaVersion');
    const provenance = record(input.provenance, 'provenance');
    const design = {
        schemaVersion: 1,
        title: string(input.title, 'title'),
        top: string(input.top, 'top'),
        provenance: Object.fromEntries(['engine', 'version', 'stage'].map(key => [key, string(provenance[key], `provenance.${key}`)])),
        modules: [],
    };
    if (provenance.hierarchy !== undefined) design.provenance.hierarchy = string(provenance.hierarchy, 'provenance.hierarchy');
    const moduleIds = new Set();
    let bitReferences = 0;
    function bits(value, where) {
        array(value, where);
        bitReferences += value.length;
        if (bitReferences > MAX_BIT_REFERENCES) throw new RangeError(`Circuit model exceeds ${MAX_BIT_REFERENCES.toLocaleString('en-US')} bit references; select a smaller design`);
        return Array.from(value, bit => {
            if (typeof bit !== 'string' || !/^(?:n:[^\s]+|c:[01xz])$/.test(bit)) fail(where, `invalid bit reference ${String(bit).slice(0, 80)}`);
            return bit;
        });
    }
    for (const [index, moduleInput] of array(input.modules, 'modules').entries()) {
        const where = `modules[${index}]`;
        record(moduleInput, where);
        const id = string(moduleInput.id, `${where}.id`);
        if (moduleIds.has(id)) fail(where, `duplicate module id ${id}`);
        moduleIds.add(id);
        const entityIds = new Set();
        function identity(item, location) {
            record(item, location);
            const itemId = string(item.id, `${location}.id`);
            if (entityIds.has(itemId)) fail(location, `duplicate entity id ${itemId}`);
            entityIds.add(itemId);
            return { id: itemId, name: string(item.name, `${location}.name`) };
        }
        function port(item, location) {
            const output = identity(item, location);
            if (!DIRECTIONS.has(item.direction)) fail(location, 'invalid port direction');
            output.direction = item.direction;
            output.bits = bits(item.bits, `${location}.bits`);
            range(item, output, location);
            withOptional(output, 'source', source(item.source, `${location}.source`));
            return output;
        }
        const output = { id, name: string(moduleInput.name, `${where}.name`), ports: [], cells: [], signals: [] };
        withOptional(output, 'source', source(moduleInput.source, `${where}.source`));
        withOptional(output, 'attributes', metadata(moduleInput.attributes, `${where}.attributes`));
        withOptional(output, 'parameters', metadata(moduleInput.parameters, `${where}.parameters`));
        output.ports = Array.from(array(moduleInput.ports, `${where}.ports`), (item, i) => port(item, `${where}.ports[${i}]`));
        output.cells = Array.from(array(moduleInput.cells, `${where}.cells`), (item, i) => {
            const location = `${where}.cells[${i}]`, cell = identity(item, location);
            cell.type = string(item.type, `${location}.type`);
            if (!CELL_KINDS.has(item.kind)) fail(location, 'invalid cell kind');
            cell.kind = item.kind;
            cell.ports = Array.from(array(item.ports, `${location}.ports`), (entry, j) => port(entry, `${location}.ports[${j}]`));
            if (item.moduleId !== undefined) cell.moduleId = string(item.moduleId, `${location}.moduleId`);
            withOptional(cell, 'source', source(item.source, `${location}.source`));
            withOptional(cell, 'parameters', metadata(item.parameters, `${location}.parameters`));
            withOptional(cell, 'attributes', metadata(item.attributes, `${location}.attributes`));
            return cell;
        });
        output.signals = Array.from(array(moduleInput.signals, `${where}.signals`), (item, i) => {
            const location = `${where}.signals[${i}]`, signal = identity(item, location);
            signal.bits = bits(item.bits, `${location}.bits`);
            withOptional(signal, 'source', source(item.source, `${location}.source`));
            range(item, signal, location);
            if (item.hidden !== undefined) {
                if (typeof item.hidden !== 'boolean') fail(location, 'hidden must be a boolean');
                signal.hidden = item.hidden;
            }
            return signal;
        });
        design.modules.push(output);
    }
    if (!moduleIds.has(design.top)) fail('top', 'does not identify a module');
    for (const module of design.modules) for (const cell of module.cells) {
        if (cell.moduleId !== undefined && !moduleIds.has(cell.moduleId)) fail(`cell ${cell.id}`, `unknown module reference ${cell.moduleId}`);
    }
    return design;
}

/** @param {object} design 已验证的设计。 @param {string} id 模块标识。 @returns {object|undefined} 对应模块。 */
function findModule(design, id) { return design.modules.find(module => module.id === id); }

module.exports = { MAX_BIT_REFERENCES, createDesign, findModule };
