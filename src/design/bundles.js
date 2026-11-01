'use strict';

// 架构图端口折叠：把实例端口按公共前缀聚合为虚拟接口端口，供渲染与 arch 数据使用。
// 只影响展示层；完整 ports[] 始终保留，成员名与位宽在 bundles[].members 中可追溯。
const RESERVED_PREFIXES = new Set(['clk', 'clock', 'rst', 'reset', 'nrst', 'arst', 'srst', 'por']);

/** @param {string} name 端口名。 @returns {string|null} 第一个 '_' 前的分组键；无下划线或时钟/复位端口返回 null。 */
function bucketOf(name) {
    const index = name.indexOf('_');
    if (index <= 0) {
        return null;
    }
    const bucket = name.slice(0, index);
    return RESERVED_PREFIXES.has(bucket.toLowerCase()) ? null : bucket;
}

/** @param {string[]} names @returns {string} 字符级公共前缀。 */
function commonPrefix(names) {
    let prefix = names[0] || '';
    for (const name of names.slice(1)) {
        while (prefix && !name.startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
        }
    }
    return prefix;
}

/** @param {object} port 端口。 @returns {object} 单成员端口束。 */
function singleton(port) {
    return { name: port.name, prefix: null, direction: port.direction, bits: port.width,
        members: [{ name: port.name, width: port.width, direction: port.direction }] };
}

/** @param {object[]} ports 端口列表。 @param {{names?:Record<string,string>}} [options] names 按前缀覆盖显示名。 @returns {object[]} 端口束（按首次出现顺序）。 */
function bundlePorts(ports, { names = {} } = {}) {
    const groups = new Map();
    const order = [];
    for (const port of ports) {
        const bucket = bucketOf(port.name);
        const key = bucket ? 'bucket:' + bucket : 'port:' + port.name;
        if (!groups.has(key)) {
            groups.set(key, { bucket, ports: [] });
            order.push(key);
        }
        groups.get(key).ports.push(port);
    }
    return order.map(key => {
        const group = groups.get(key), members = group.ports;
        const prefix = group.bucket ? commonPrefix(members.map(port => port.name)).replace(/_+$/, '') : '';
        if (!group.bucket || members.length < 2 || prefix.length < 1) {
            return singleton(members[0]);
        }
        const directions = new Set(members.map(port => port.direction));
        const direction = directions.size === 1 ? [...directions][0] : 'inout';
        return {
            name: names[prefix] || prefix, prefix, direction,
            bits: members.reduce((total, port) => total + port.width, 0),
            members: members.map(port => ({ name: port.name, width: port.width, direction: port.direction }))
        };
    });
}

module.exports = { bundlePorts, bucketOf, commonPrefix, RESERVED_PREFIXES };
