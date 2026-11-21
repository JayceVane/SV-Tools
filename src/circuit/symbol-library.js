/* 布局与SVG共用的纯符号几何，不解析RTL，也不从实例名猜功能。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CircuitSymbols = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const STUB = 16, PITCH = 24, HEADER = 40;
    const TERMINAL_WIDTH = 20, TERMINAL_GAP = 8, TERMINAL_PADDING = 6;
    const PORT_KINDS = new Set(['input', 'output', 'inout']);
    const GATES = new Map([
        ['and', ['$and', '$_AND_', 'RTL_AND']], ['nand', ['$_NAND_', 'RTL_NAND']],
        ['or', ['$or', '$_OR_', 'RTL_OR']], ['nor', ['$_NOR_', 'RTL_NOR']],
        ['xor', ['$xor', '$_XOR_', 'RTL_XOR']], ['xnor', ['$xnor', '$_XNOR_', 'RTL_XNOR']],
        ['inv', ['$not', '$_NOT_', 'RTL_NOT']], ['buf', ['$pos', '$_BUF_', 'RTL_BUF']],
    ].flatMap(([kind, types]) => types.map(type => [type, kind])));
    const MUXES = new Set(['$mux', '$_MUX_', 'RTL_MUX']);
    const OPERATORS = { $add: '+', $sub: '−', $mul: '×', $mult: '×', $div: '÷', $mod: '%', $neg: '−',
        $and: '&', $or: 'OR', $xor: 'XOR', $xnor: 'XNOR', $not: 'NOT', $logic_not: '!', $logic_and: '&&', $logic_or: '||',
        $eq: '=', $ne: '≠', $lt: '<', $le: '≤', $gt: '>', $ge: '≥', $shl: '≪', $shr: '≫', $sshl: '≪', $sshr: '≫' };
    const FUNCTIONS = { register: 'REG', mux: 'MUX', memory: 'MEM', instance: '模块', logic: 'LOGIC', arithmetic: 'ƒ', unknown: '?' };
    const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
    const grid = value => Math.ceil(value / 8) * 8;

    const terminalTextWidth = char => char.codePointAt(0) > 255 ? 14 : /[MW@%&]/u.test(char) ? 12 : 8;

    function terminalCaption(label, available = 320) {
        const chars = [...String(label ?? '')];
        let width = 0;
        for (let index = 0; index < chars.length; index++) {
            const next = terminalTextWidth(chars[index]);
            if (width + next > available) {
                while (index && width + 14 > available) width -= terminalTextWidth(chars[--index]);
                return { text: chars.slice(0, index).join('') + '…', width: width + 14 };
            }
            width += next;
        }
        return { text: chars.join(''), width };
    }

    function terminalWidth(label) {
        return Math.max(64, terminalCaption(label).width + TERMINAL_WIDTH + TERMINAL_GAP + TERMINAL_PADDING);
    }

    // 布局宽度包含外侧文字，接线点仍贴在图形朝向电路的一侧。
    function terminalSymbol(width, height, side, direction) {
        const east = side === 'EAST', centerY = height / 2;
        const left = east ? width - TERMINAL_WIDTH : 0, right = left + TERMINAL_WIDTH;
        const top = centerY - 6, bottom = centerY + 6, tip = 6;
        const base = direction === 'inout' ? left + tip : left;
        const head = PORT_KINDS.has(direction) ? right - tip : right;
        const points = [[base, top], [head, top], [right, centerY], [head, bottom], [base, bottom], [left, centerY]];
        return { points: points.map(([x, y]) => `${x},${y}`).join(' '), left, right, top, bottom, centerY,
            labelX: east ? left - TERMINAL_GAP : right + TERMINAL_GAP, anchor: east ? 'end' : 'start',
            labelWidth: width - TERMINAL_WIDTH - TERMINAL_GAP - TERMINAL_PADDING };
    }

    function kindFor(node) {
        if (node.terminal || PORT_KINDS.has(node.kind) || ['bus', 'constant', 'junction'].includes(node.kind)) return node.kind;
        if (node.moduleId) return 'block';
        const ports = node.ports || [], type = String(node.detail || ''), candidate = GATES.get(type);
        const unary = ['inv', 'buf'].includes(candidate), expected = unary ? ['A', 'Y'] : ['A', 'B', 'Y'];
        if (candidate && ports.length === expected.length && expected.every(name => ports.some(port => port.label === name
            && port.bits?.length === 1 && port.direction === (name === 'Y' ? 'output' : 'input')))) return candidate;
        if (MUXES.has(type) && ports.length === 4 && ['A', 'B', 'S', 'Y'].every(name => ports.some(port => port.label === name
            && port.direction === (name === 'Y' ? 'output' : 'input'))) && ports.find(port => port.label === 'S').bits.length === 1) return 'mux';
        return 'block';
    }

    /** @param {object} node 展示节点。 @returns {object} 相对于节点原点的符号合同；无副作用，兼容已有布局。 */
    function geometry(node) {
        const kind = node.symbolKind || kindFor(node), width = finite(node.width, 160), height = finite(node.height, 96);
        const port = node.ports?.[0];
        const side = port?.side || (finite(port?.x, kind === 'input' ? width : 0) >= width / 2 ? 'EAST' : 'WEST');
        const terminal = PORT_KINDS.has(kind) || node.terminal ? terminalSymbol(width, height, side, kind) : undefined;
        const isGate = [...GATES.values()].includes(kind), isTerminal = ['constant', 'junction'].includes(kind);
        const body = terminal ? { x: terminal.left, y: terminal.top, width: terminal.right - terminal.left, height: terminal.bottom - terminal.top }
            : isGate ? { x: STUB, y: 8, width: width - STUB * 2, height: height - 32 }
            : { x: isTerminal || !node.symbolKind ? 0 : STUB, y: 0, width: isTerminal || !node.symbolKind ? width : width - STUB * 2, height };
        return { kind, isGate, body, terminal, paintBounds: node.paintBounds || { left: -8, top: -8, right: width + 8, bottom: height + (isGate ? 8 : 0) } };
    }

    /**
     * 为独立展示节点分配8px网格尺寸和固定引脚锚点，保留位序和领域身份。
     * @param {object} source 无布局的展示节点。 @returns {object} 可直接供ELK与SVG使用的新节点。
     */
    function prepareNode(source) {
        const node = { ...source, ports: (source.ports || []).map(port => ({ ...port, width: 0, height: 0 })) };
        const kind = node.symbolKind = kindFor(node), isGate = [...GATES.values()].includes(kind);
        const isPort = PORT_KINDS.has(kind) || node.terminal;
        const header = HEADER + (node.modeLabel ? 16 : 0);
        const inputs = node.ports.filter(port => port.direction !== 'output'), outputs = node.ports.filter(port => port.direction === 'output');
        if (isGate) { node.width = 112; node.height = 96; }
        else if (kind === 'mux') { node.width = Math.max(144, node.width || 0); node.height = 128; }
        else if (isPort) {
            const bitCount = node.ports[0]?.bits?.length || 0;
            node.width = grid(Math.max(terminalWidth(node.label), bitCount > 1 ? terminalWidth(`${bitCount} bit`) : 0));
            node.height = bitCount > 1 ? 40 : 32;
        } else if (['constant', 'junction'].includes(kind)) {
            node.width = grid(Math.max(64, Math.min(256, String(node.label || '').length * 7.3 + 28)));
            node.height = 32;
        } else {
            const labelWidth = Math.max(0, ...node.ports.map(port => String(port.wireLabel || port.label || '').length * 7.3));
            node.width = grid(Math.max(node.width || 160, Math.min(400, labelWidth * 2 + 96)));
            node.height = grid(Math.max(node.height || 0, header + PITCH * Math.max(inputs.length, outputs.length, 1) + 16));
        }
        for (const [list, side] of [[inputs, 'WEST'], [outputs, 'EAST']]) {
            list.forEach((port, index) => {
                port.side = side; port.x = side === 'WEST' ? 0 : node.width;
                port.y = isGate ? inputs.includes(port) ? list.length === 1 ? 40 : 24 + index * 32 : 40
                    : isPort || ['constant', 'junction'].includes(kind) ? node.height / 2
                    : header + index * PITCH;
            });
        }
        if (kind === 'mux') {
            for (const port of node.ports) {
                if (port.label === 'S') { port.side = 'SOUTH'; port.x = node.width / 2; port.y = node.height; }
                else port.y = port.label === 'A' ? 32 : port.label === 'B' ? 72 : 52;
            }
        }
        node.paintBounds = { left: -8, top: -8, right: node.width + 8, bottom: node.height + 8 };
        return node;
    }

    /** @param {object} node 展示节点。 @returns {string} 字级功能标记；未知器件保留工具类型。 */
    function functionLabel(node) {
        const type = String(node.detail || '').replace(/^RTL_/, '$').toLowerCase();
        return node.symbol || (Object.hasOwn(OPERATORS, type) ? OPERATORS[type] : FUNCTIONS[node.kind]) || node.detail || '?';
    }

    /**
     * 可绘制主体轮廓，供节点填充与选中外框共用同一几何。
     * @param {object} node 展示节点。 @param {number} [width] 节点宽。 @param {number} [height] 节点高。
     * @returns {{type:'path'|'polygon'|'rect', attrs:object}} SVG 形状描述；总线由单独主干绘制。
     */
    function bodyShape(node, width = finite(node.width, 120), height = finite(node.height, 56)) {
        const g = geometry(node);
        if (g.isGate) return { type: 'path', attrs: { d: gateOutline(node).d } };
        if (g.kind === 'mux') {
            const b = g.body;
            return { type: 'polygon', attrs: { points: `${b.x},0 ${b.x + b.width},16 ${b.x + b.width},${height - 32} ${b.x},${height - 16}` } };
        }
        if (g.terminal) return { type: 'polygon', attrs: { points: g.terminal.points } };
        return { type: 'rect', attrs: { x: g.body.x, y: g.body.y, width: g.body.width, height: g.body.height } };
    }

    /** @param {object} node 展示节点。 @returns {{d:string,inverted:boolean}|null} 标准门轮廓；非门返回null。 */
    function gateOutline(node) {
        const g = geometry(node); if (!g.isGate) return null;
        const { x, y, width: w, height: h } = g.body, right = x + w, cy = y + h / 2;
        const inverted = ['inv', 'nand', 'nor', 'xnor'].includes(g.kind), end = right - (inverted ? 8 : 0);
        let d;
        if (['buf', 'inv'].includes(g.kind)) d = `M ${x} ${y} L ${end} ${cy} L ${x} ${y + h} Z`;
        else if (['and', 'nand'].includes(g.kind)) d = `M ${x} ${y} L ${end - h / 2} ${y} A ${h / 2} ${h / 2} 0 0 1 ${end - h / 2} ${y + h} L ${x} ${y + h} Z`;
        else d = `M ${x} ${y} Q ${x + w * .65} ${y} ${end} ${cy} Q ${x + w * .65} ${y + h} ${x} ${y + h} Q ${x + w * .3} ${cy} ${x} ${y} Z`;
        return { d, inverted, x: right - 4, y: cy, radius: 4 };
    }
    return { prepareNode, geometry, functionLabel, gateOutline, bodyShape, terminalCaption, terminalWidth, terminalSymbol };
});
