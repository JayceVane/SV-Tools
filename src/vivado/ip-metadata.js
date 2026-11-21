'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { walkXml } = require('./xpr');
const { attribute, localName, readAssetText } = require('./asset-preview');
const { parseLayout } = require('./xgui');

const children = (node, name) => node?.children.filter(child => child.name === name) || [];
const child = (node, name) => children(node, name)[0];
const text = node => node?.text.trim() || '';
const value = (node, name) => text(child(node, name));

function parseComponent(xml, file) {
    let root;
    walkXml(xml, file, /^(?:[\w.-]+:)?component$/u, {
        onElement(element, stack) {
            if (element.closing) return;
            const node = { name: localName(element.name), attrs: element.attrs, children: [], text: '' };
            if (stack.length) stack.at(-1).data.children.push(node);
            else root = node;
            return node;
        },
        onText(content, stack) { stack.at(-1).data.text += content; }
    });
    const vlnv = ['vendor', 'library', 'name', 'version'].map(key => value(root, key)).join(':');
    const choices = new Map(children(child(root, 'choices'), 'choice').map(item => [value(item, 'name'),
        children(item, 'enumeration').map(entry => [text(entry), attribute(entry.attrs, 'text') || text(entry)])]));
    const fields = new Map(children(child(root, 'parameters'), 'parameter').map(parameter => {
        const key = value(parameter, 'name'), data = child(parameter, 'value'), attrs = data?.attrs || {};
        const optionLabels = choices.get(attribute(attrs, 'choiceRef')) || [];
        const enablement = child(child(child(child(parameter, 'vendorExtensions'), 'parameterInfo'), 'enablement'), 'isEnabled');
        return [key, { label: value(parameter, 'displayName'), help: value(parameter, 'description'),
            format: attribute(attrs, 'format'), min: attribute(attrs, 'minimum'), max: attribute(attrs, 'maximum'),
            optionLabels, readOnly: (enablement && !attribute(enablement.attrs, 'resolve') && text(enablement) === 'false') || undefined }];
    }));
    const gui = children(child(root, 'fileSets'), 'fileSet').filter(set => /xpgui|xgui/iu.test(value(set, 'name')))
        .flatMap(set => children(set, 'file').map(item => value(item, 'name')))
        .find(file => /^xgui[/\\][\w.-]+\.tcl$/iu.test(file));
    return { vlnv, fields, gui };
}

// 只提取文字定义，Tcl 的条件和回调留给 Vivado 执行。

function installedPackage(bin, vlnv) {
    const [vendor, , name, version] = vlnv.split(':');
    if (!bin || vendor !== 'xilinx.com' || !/^[\w-]+$/u.test(name || '') || !/^\d+(\.\d+)+$/u.test(version || '')) return;
    return path.resolve(bin, '..', 'data', 'ip', 'xilinx', `${name}_v${version.replaceAll('.', '_')}`, 'component.xml');
}

function annotate(parameters, { fields, layout, vlnv }) {
    const uiFields = layout instanceof Map ? layout : layout?.params || new Map();
    const options = new Map();
    for (const parameter of parameters) {
        const key = parameter.key.slice(7), definition = fields.get(key), ui = uiFields.get(key);
        const dependency = vlnv === 'xilinx.com:ip:axi_gpio:2.0' && key === 'C_GPIO2_WIDTH'
            ? [['CONFIG.C_IS_DUAL', ['1', 'true']], ['CONFIG.GPIO2_BOARD_INTERFACE', ['Custom']]] : undefined;
        if (definition || ui) options.set(parameter.key, {
            ...definition, label: ui?.label || definition?.label || (ui ? key.replaceAll('_', ' ') : undefined), help: ui?.help || definition?.help,
            group: ui?.group, widget: ui?.widget, dependency
        });
    }
    const keys = new Set(parameters.map(parameter => parameter.key));
    const order = new Map([...uiFields.keys()].map((key, index) => ['CONFIG.' + key, index]));
    return parameters.map(parameter => {
        const data = options.get(parameter.key);
        if (!data) return parameter;
        return { ...parameter, ...data, dependency: data.dependency?.every(([key]) => keys.has(key)) ? data.dependency : undefined };
    }).sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
}

function createIpMetadata(resolveBinDir) {
    const cache = new Map();
    return async function describe(info, component) {
        const file = component || installedPackage(resolveBinDir?.(), info.vlnv);
        if (!file || !path.isAbsolute(file)) return info;
        try {
            const stat = await fs.stat(file);
            let entry = cache.get(file);
            if (entry?.mtime !== stat.mtimeMs || entry?.size !== stat.size) {
                const { text: xml } = await readAssetText(file);
                const metadata = parseComponent(xml, file);
                let gui;
                if (metadata.gui) {
                    const root = await fs.realpath(path.dirname(file));
                    const candidate = await fs.realpath(path.join(root, metadata.gui.replaceAll('\\', '/'))).catch(() => '');
                    if (candidate && !path.relative(root, candidate).startsWith('..') && !path.isAbsolute(path.relative(root, candidate))) gui = candidate;
                }
                entry = { mtime: stat.mtimeMs, size: stat.size, metadata, gui };
                cache.delete(file);
                if (cache.size >= 16) cache.delete(cache.keys().next().value);
                cache.set(file, entry);
            }
            if (entry.metadata.vlnv !== info.vlnv) return info;
            if (entry.gui) {
                const stat = await fs.stat(entry.gui).catch(() => undefined);
                if (stat && (entry.guiMtime !== stat.mtimeMs || entry.guiSize !== stat.size)) {
                    entry.layout = await readAssetText(entry.gui, 2 * 1024 * 1024).then(result => parseLayout(result.text))
                        .catch(() => ({ params: new Map(), notes: new Map() }));
                    entry.guiMtime = stat.mtimeMs;
                    entry.guiSize = stat.size;
                }
            }
            const layout = entry.layout || { params: new Map(), notes: new Map() };
            const notes = [...(layout.notes || new Map())].map(([group, texts]) => ({ group, texts: [...texts] }));
            return { ...info, parameters: annotate(info.parameters, { ...entry.metadata, layout }), notes };
        } catch { return info; }
    };
}

module.exports = { createIpMetadata };
