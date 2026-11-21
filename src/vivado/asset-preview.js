'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { walkXml } = require('./xpr');
const { snapshot } = require('./block-design');

const localName = name => name.slice(name.lastIndexOf(':') + 1);
const attribute = (attrs, key) => Object.entries(attrs).find(([name]) => localName(name) === key)?.[1];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const entries = value => object(value) ? Object.entries(value) : [];
const string = value => typeof value === 'string' ? value : '';

async function readAssetText(file, limit = 8 * 1024 * 1024) {
    const handle = await fs.open(file, 'r');
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > limit) throw new Error('资产文件不支持或超出读取预算');
        const bytes = Buffer.allocUnsafe(info.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset !== info.size || (await handle.stat()).mtimeMs !== info.mtimeMs) throw new Error('资产文件在读取期间发生变化');
        const content = bytes.subarray(0, offset);
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(content), stamp: createHash('sha256').update(content).digest('hex') };
    } finally { await handle.close(); }
}

function savedBlock(text) {
    const { design } = JSON.parse(text);
    const name = design?.design_info?.name;
    if (typeof name !== 'string' || !name) return;
    const rows = [['design', name]], endpoints = new Set(), cells = new Set();
    const segment = value => /^[^/\u0000-\u001f]+$/u.test(value) && value !== '.' && value !== '..';
    function port(kind, id, value) {
        const key = (kind.startsWith('interface') ? 'interface:' : 'signal:') + id;
        if (endpoints.has(key)) return;
        endpoints.add(key);
        rows.push([kind, id, string(value.direction || value.mode), string(value.type || value.vlnv), string(value.left), string(value.right)]);
    }
    function level(node, owner, depth) {
        if (depth > 32 || rows.length > 12000) throw new RangeError('Block Design 预览超出预算');
        for (const [key, child] of entries(node.components)) {
            if (!segment(key) || !object(child)) continue;
            const id = owner + '/' + key, vlnv = string(child.vlnv);
            cells.add(id);
            rows.push(['cell', id, vlnv ? 'ip' : 'hier', vlnv]);
            if (!vlnv) level(child, id, depth + 1);
        }
        for (const [collection, kind] of [['ports', owner ? 'pin' : 'port'], ['interface_ports', owner ? 'interface_pin' : 'interface_port']]) {
            for (const [key, entry] of entries(node[collection])) if (segment(key) && object(entry)) port(kind, owner + '/' + key, entry);
        }
        for (const [collection, property, kind, pin] of [['nets', 'ports', 'net', 'pin'], ['interface_nets', 'interface_ports', 'interface_net', 'interface_pin']]) {
            for (const [key, entry] of entries(node[collection])) {
                if (!segment(key) || !Array.isArray(entry?.[property])) continue;
                const names = entry[property].flatMap(value => {
                    if (typeof value !== 'string') return [];
                    const parts = value.split('/');
                    if (parts.length > 2 || !parts.every(segment)) return [];
                    const id = owner + '/' + value;
                    if (parts.length === 2) {
                        if (!cells.has(owner + '/' + parts[0])) return [];
                        port(pin, id, {});
                    }
                    return [id];
                });
                if (names.length > 1) rows.push([kind, owner + '/' + key, ...names]);
            }
        }
    }
    level(design, '', 0);
    return rows.length <= 12000 ? snapshot(rows) : undefined;
}

function savedIp(text, file) {
    const parameters = new Map();
    let name, vlnv;
    if (text.trimStart().startsWith('{')) {
        const { ip_inst: ip } = JSON.parse(text);
        name = ip?.xci_name;
        vlnv = ip?.component_reference;
        for (const [key, definitions] of entries(ip?.parameters?.component_parameters)) {
            const item = Array.isArray(definitions) && definitions[0];
            if (typeof item?.value === 'string') parameters.set(key, item.value);
        }
    } else {
        let field;
        walkXml(text, file, /^(?:[\w.-]+:)?design$/u, {
            onElement(node, stack) {
                const tag = localName(node.name), parent = localName(stack.at(-1)?.name || '');
                if (node.closing) {
                    if (field?.tag !== tag) return;
                    if (tag === 'instanceName') name = field.value;
                    else if (field.key) parameters.set(field.key, field.value);
                    field = undefined;
                } else if (tag === 'instanceName' && parent === 'componentInstance') {
                    field = { tag, value: '' };
                } else if (tag === 'componentRef' && parent === 'componentInstance') {
                    vlnv = ['vendor', 'library', 'name', 'version'].map(key => attribute(node.attrs, key) || '').join(':');
                } else if (tag === 'configurableElementValue' && parent === 'configurableElementValues') {
                    const key = /^(?:PARAM_VALUE|CONFIG)\.([\w.:-]+)$/u.exec(attribute(node.attrs, 'referenceId') || '')?.[1];
                    if (key && node.empty) parameters.set(key, '');
                    else if (key) field = { tag, key, value: '' };
                }
            },
            onText(value) { if (field) field.value += value; }
        });
    }
    if (typeof vlnv !== 'string' || !/^[\w.-]+:[\w.-]+:[\w.-]+:[\w.-]+$/u.test(vlnv)) return;
    parameters.delete('Component_Name');
    parameters.delete('LOGO_FILE');
    return { name: string(name) || path.basename(file, path.extname(file)), vlnv, preview: true, actions: [],
        parameters: [...parameters].map(([key, value]) => ({ key: 'CONFIG.' + key, value, choices: [] })) };
}

module.exports = { readAssetText, savedBlock, savedIp, localName, attribute };
