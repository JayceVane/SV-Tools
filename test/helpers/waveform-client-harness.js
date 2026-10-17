'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');
const model = require('../../src/waveform/model');
const interactions = require('../../src/waveform/interaction');
const layout = require('../../src/waveform/row-layout');
const columns = require('../../src/waveform/column-layout');

/** 运行真实 client 和 Pointer 控制器；只替换 DOM、Canvas 和消息边界。 */
function clientHarness(saved, { vars, height = 400, width = 900, reducedMotion = false } = {}) {
    const nodes = new Map(), messages = [], documentListeners = {}, windowListeners = {}, frames = new Map(), saves = [], paints = [];
    let clock = 0, frameId = 0, state, menuOptions, preferenceListener, viewportWidth = width + 252;
    const document = { activeElement: null, addEventListener(name, callback) { documentListeners[name] = callback; } };
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.listeners = {};
            this.clientWidth = width; this.clientHeight = height; this.scrollTop = 0; this.value = ''; this.captures = new Set();
            this.classList = { toggle() {}, add() {}, remove() {} };
        }
        setAttribute(name, value) { this.attributes[name] = value; }
        removeAttribute(name) { delete this.attributes[name]; }
        append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
        appendChild(child) { this.append(child); return child; }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
        addEventListener(name, callback) { this.listeners[name] = callback; }
        focus() { document.activeElement = this; }
        click() { this.onclick?.(); }
        setPointerCapture(id) { this.captures.add(id); }
        hasPointerCapture(id) { return this.captures.has(id); }
        releasePointerCapture(id) { this.captures.delete(id); this.listeners.lostpointercapture?.({ pointerId: id }); }
        getBoundingClientRect() { return { left: 250, top: 140, right: 250 + width, bottom: 140 + height, width, height }; }
    }
    document.createElement = tag => new Element(tag); document.body = new Element('body');
    document.getElementById = id => {
        if (!nodes.has(id)) {
            const node = new Element(id === 'waveCanvas' ? 'canvas' : ['search', 'jumpTime'].includes(id) ? 'input' : 'div');
            node.id = id; nodes.set(id, node);
        }
        return nodes.get(id);
    };
    const window = { WaveSignalDisplay: require('../../src/waveform/signal-display'), WaveModel: model, WaveInteractions: interactions, WaveRowLayout: layout, WaveColumnLayout: columns, innerWidth: viewportWidth,
        addEventListener(name, callback) { windowListeners[name] = callback; },
        matchMedia: () => ({ matches: reducedMotion, addEventListener(name, callback) { preferenceListener = callback; } }),
        createWaveRenderer(options) {
            state = options.state;
            return { draw() { paints.push({ rows: layout.visibleRows(state.rowPresentation?.targetRows || state.rows, nodes.get('tracks').scrollTop,
                height, state.rowPresentation?.positions).length, height }); }, colors() {},
                geometry: () => columns.waveGeometry(document.getElementById('tracks').clientWidth, state.columns.names, state.fullName),
                rowAt: y => layout.rowAt(state.rows, y + document.getElementById('tracks').scrollTop) };
        }, createMemoryInspector: () => ({ refresh() {}, initialize() {}, toggle() {}, snapshot: () => ({}) }),
        createWaveMenu(options) { menuOptions = options; return { contains: () => false, close: () => options.onClose() }; } };
    const metadata = { vars: vars || ['a', 'b', 'c'].map(name => ({ name, path: 'tb.' + name, scopePath: 'tb', width: 32, type: 'reg', id: name, changeCount: 2 })),
        endTime: 100, secondsPerTick: 1e-9, timescale: '1 ns', scopes: [{ path: 'tb' }], fileBytes: 1000 };
    const catalogPane = document.getElementById('catalogPane');
    for (const id of ['tracks', 'right', 'ruler']) Object.defineProperty(document.getElementById(id), 'clientWidth',
        { get: () => viewportWidth - (parseFloat(catalogPane.style.width) || 252) });
    Object.defineProperty(document.getElementById('layout'), 'clientWidth', { get: () => viewportWidth });
    document.getElementById('ruler').clientHeight = 35;
    const context = { window, document, BOOT: { fileName: 'test.vcd', fileKey: 'test', metadata },
        acquireVsCodeApi: () => ({ postMessage: message => messages.push(message), getState: () => saved, setState: value => saves.push(structuredClone(value)) }),
        performance: { now: () => clock }, requestAnimationFrame: callback => { const id = ++frameId; frames.set(id, callback); return id; },
        cancelAnimationFrame: id => frames.delete(id), setTimeout, clearTimeout,
        ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} } };
    for (const name of ['row-gesture.js', 'column-resize.js', 'client.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/waveform', name), 'utf8'), context);
    const canvas = document.getElementById('waveCanvas'), tracks = document.getElementById('tracks');
    function event(type, x, y, modifiers = {}) {
        const result = { button: 0, pointerId: 1, clientX: 250 + x, clientY: 140 + y, offsetX: x, offsetY: y,
            target: canvas, preventDefault() { this.prevented = true; }, ...modifiers };
        canvas.listeners[type](result); return result;
    }
    function pointer(key, modifiers = {}) {
        const row = state.rows.find(item => model.signalKey(item.signal) === key);
        event('pointerdown', 10, row.y - tracks.scrollTop + 5, modifiers); event('pointerup', 10, row.y - tracks.scrollTop + 5, modifiers);
    }
    function runFrame(elapsed = 16) { clock += elapsed; const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(clock); }
    function settleFrames() { for (let count = 0; frames.size && count < 30; count++) runFrame(); }
    async function flush() {
        for (let pass = 0; pass < 4; pass++) {
            for (const message of messages) if (!message.done && message.requestId) {
                message.done = true;
                const result = message.type === 'window' ? { series: message.params.ids.map(id => ({ id, dense: [], changes: [] })) }
                    : { values: Object.fromEntries(message.params.ids.map(id => [id, '0'])) };
                windowListeners.message({ data: { type: 'response', requestId: message.requestId, result } });
            }
            await nextTurn(); runFrame();
        }
    }
    return { state, messages, pointer, event, flush, runFrame, settleFrames, frames, saves, paints, document, canvas, tracks, documentListeners, windowListeners,
        resize(nextWidth) { viewportWidth = nextWidth; window.innerWidth = nextWidth; windowListeners.resize({}); },
        node: id => document.getElementById(id), persisted: () => saves.at(-1), changeMotion: value => preferenceListener({ matches: value }),
        contextMenu(key) {
            const row = state.rows.find(item => model.signalKey(item.signal) === key);
            canvas.oncontextmenu({ offsetY: row.y - tracks.scrollTop + 5, clientX: 260, clientY: 140 + row.y - tracks.scrollTop + 5, preventDefault() {} });
            return menuOptions;
        }, find(id) { const visit = item => item.id === id ? item : item.children.map(visit).find(Boolean); return visit(document.body); } };
}
module.exports = { clientHarness };
