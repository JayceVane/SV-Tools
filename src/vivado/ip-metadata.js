'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { walkXml } = require('./xpr');
const { attribute, localName, readAssetText } = require('./asset-preview');

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
function guiLayout(source) {
    const objects = new Map(), fields = new Map();
    const word = /\$\{[\w.:-]+\}|"(?:\\.|[^"\\])*"|\{[^{}]*\}|[^\s\[\]"]+/gu;
    const literal = token => {
        const content = token?.replace(/^(?:"([\s\S]*)"|\{([\s\S]*)\})$/u, (_, quoted, braced) => quoted ?? braced);
        return content && !/[$\[\]{}]/u.test(content) ? content.trim() : '';
    };
    const ref = token => /^\$(?:\{([\w.:-]+)\}|([\w.:-]+))$/u.exec(token || '')?.slice(1).find(Boolean);
    for (const raw of source.replace(/\\\r?\n\s*/gu, ' ').split(/\r?\n/u)) {
        const line = raw.trim();
        const add = /^(?:set\s+([\w.:-]+)\s+\[\s*)?ipgui::add_(page|group|panel|table|param)\s+(.+)$/u.exec(line);
        if (add) {
            const [, name, type, args] = add, words = args.match(word) || [];
            const option = key => { const i = words.indexOf('-' + key); return i >= 0 ? words[i + 1] : undefined; };
            const key = literal(option('name'));
            if (!key) continue;
            const parent = objects.get(ref(option('parent')));
            const entry = { key, type, parent, widget: literal(option('widget')) };
            if (name) objects.set(name, entry);
            if (type === 'param' && !fields.has(key)) fields.set(key, entry);
            continue;
        }
        if (!line.startsWith('set_property ')) continue;
        const [, property, wordValue, variable, extra] = line.match(word) || [];
        if (extra || !['display_name', 'tooltip'].includes(property)) continue;
        const entry = objects.get(ref(variable)), caption = literal(wordValue);
        if (entry && caption) entry[property] = caption;
    }
    return new Map([...fields].map(([key, entry]) => {
        const parents = [];
        for (let item = entry.parent, depth = 0; item && depth++ < 12; item = item.parent) {
            if (item.type === 'page' || item.type === 'group' || item.display_name) parents.unshift(item.display_name || item.key);
        }
        return [key, { label: entry.display_name, help: entry.tooltip, group: parents.join(' / '), widget: entry.widget }];
    }));
}

function installedPackage(bin, vlnv) {
    const [vendor, , name, version] = vlnv.split(':');
    if (!bin || vendor !== 'xilinx.com' || !/^[\w-]+$/u.test(name || '') || !/^\d+(\.\d+)+$/u.test(version || '')) return;
    return path.resolve(bin, '..', 'data', 'ip', 'xilinx', `${name}_v${version.replaceAll('.', '_')}`, 'component.xml');
}

function annotate(parameters, { fields, layout, vlnv }) {
    const options = new Map();
    for (const parameter of parameters) {
        const key = parameter.key.slice(7), definition = fields.get(key), ui = layout.get(key);
        const dependency = vlnv === 'xilinx.com:ip:axi_gpio:2.0' && key === 'C_GPIO2_WIDTH'
            ? [['CONFIG.C_IS_DUAL', ['1', 'true']], ['CONFIG.GPIO2_BOARD_INTERFACE', ['Custom']]] : undefined;
        if (definition || ui) options.set(parameter.key, {
            ...definition, label: ui?.label || definition?.label || (ui ? key.replaceAll('_', ' ') : undefined), help: ui?.help || definition?.help,
            group: ui?.group, widget: ui?.widget, dependency
        });
    }
    const keys = new Set(parameters.map(parameter => parameter.key));
    const order = new Map([...layout.keys()].map((key, index) => ['CONFIG.' + key, index]));
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
                    entry.layout = await readAssetText(entry.gui, 2 * 1024 * 1024).then(result => guiLayout(result.text)).catch(() => new Map());
                    entry.guiMtime = stat.mtimeMs;
                    entry.guiSize = stat.size;
                }
            }
            return { ...info, parameters: annotate(info.parameters, { ...entry.metadata, layout: entry.layout || new Map() }) };
        } catch { return info; }
    };
}

module.exports = { createIpMetadata };
