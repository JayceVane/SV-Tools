'use strict';

// 架构图端口折叠：可选地把实例端口按公共前缀聚合为虚拟接口端口，供渲染与 arch 数据使用。
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

/** @param {string} name @param {string} bucket @returns {string} 分组键之后的第二段 token（可能为空）。 */
function secondToken(name, bucket) {
    const rest = name.slice(bucket.length + 1);
    const index = rest.indexOf('_');
    return index < 0 ? rest : rest.slice(0, index);
}

/** @param {object} port 端口。 @returns {object} 单成员端口束。 */
function singleton(port) {
    return { name: port.name, prefix: null, direction: port.direction, bits: port.width,
        members: [{ name: port.name, width: port.width, direction: port.direction }] };
}

/** @param {object[]} ports 端口列表。 @param {string} prefix 折叠前缀。 @param {Record<string,string>} names 显示名覆盖。 @returns {object} 多成员端口束。 */
function bundle(ports, prefix, names) {
    const directions = new Set(ports.map(port => port.direction));
    return {
        name: names[prefix] || prefix, prefix,
        direction: directions.size === 1 ? [...directions][0] : 'inout',
        bits: ports.reduce((total, port) => total + port.width, 0),
        members: ports.map(port => ({ name: port.name, width: port.width, direction: port.direction }))
    };
}

/** @param {string[]} names @param {string} key 桶键。 @returns {string|null} 满足整个桶折叠条件时的前缀，否则 null。 */
function foldablePrefix(names, key) {
    const prefix = commonPrefix(names).replace(/_+$/, '');
    return prefix.length > key.length || (prefix.length === key.length && key.length >= 2) ? prefix : null;
}

/** @param {object[]} ports 同一桶的端口。 @param {string} key 桶键。 @param {Record<string,string>} names 显示名覆盖。 @returns {object[]} 端口束（按首次出现顺序）。 */
function bundleBucket(ports, key, names) {
    const prefix = foldablePrefix(ports.map(port => port.name), key);
    if (prefix) {
        return [bundle(ports, prefix, names)];
    }
    // 桶内不同子前缀混在一起时按第二段 token 再聚类；不满足条件则每个成员独立输出。
    const groups = new Map();
    for (const port of ports) {
        const groupKey = 'token:' + secondToken(port.name, key);
        if (!groups.has(groupKey)) {
            groups.set(groupKey, []);
        }
        groups.get(groupKey).push(port);
    }
    const result = [];
    for (const group of groups.values()) {
        if (group.length < 2) {
            result.push(singleton(group[0]));
            continue;
        }
        const subPrefix = commonPrefix(group.map(port => port.name)).replace(/_+$/, '');
        if (subPrefix.length > key.length) {
            result.push(bundle(group, subPrefix, names));
        } else {
            result.push(...group.map(singleton));
        }
    }
    return result;
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
    return order.flatMap(key => {
        const group = groups.get(key);
        return group.bucket ? bundleBucket(group.ports, group.bucket, names) : group.ports.map(singleton);
    });
}

module.exports = { bundlePorts, bucketOf, secondToken, commonPrefix, RESERVED_PREFIXES };
