'use strict';

/**
 * 接口束的方向证据。
 * 查看器（architecture-model）与结构投影报告（struct → arch）必须共用同一套判定，
 * 否则同一条接口会在图上显示"正向"、在报告表格里写成"成员方向未知"。
 */

// 角色词表与 skills/svtools-design/references/architecture.md 的命名约定一致；observer 类不表态。
const PRODUCER_ROLE = /^(?:master|manager|initiator|source|src|tx|transmitter|producer|host|driver|requester)$/i;
const CONSUMER_ROLE = /^(?:slave|subordinate|target|sink|destination|dst|rx|receiver|consumer|responder|ack)$/i;

function roleScore(endpoint) {
    if (PRODUCER_ROLE.test(endpoint.modport || '')) return 1;
    if (CONSUMER_ROLE.test(endpoint.modport || '')) return -1;
    return 0;
}

/**
 * 依据 modport 成员方向和端点角色给出成员流向、束级通路与证据来源。
 * @param {Array<{modport?:string, invalid?:boolean, boundary?:boolean}>} endpoints 两端（或更多）端点。
 * @param {{members:object[], modports:object[]}} model 接口成员的声明视图。
 * @returns {{members:object[], handshake:boolean, routes:object[], flowEvidence:string|null}}
 */
function connectionEvidence(endpoints, model) {
    const members = model.members.map(member => {
        const directions = endpoints.map(endpoint => {
            if (!endpoint.modport || endpoint.invalid) return 'unknown';
            const view = model.modports.find(item => item.name === endpoint.modport);
            if (!view) return 'unknown';
            const declared = view.members.find(item => item.name === member.name);
            if (!declared) return 'unlisted';
            return declared.direction || 'unknown';
        });
        // 边界端口的声明方向是模块外侧视角，换算成模块内侧再看驱动关系。
        const effective = directions.map((direction, index) => endpoints[index].boundary
            ? ({ input: 'output', output: 'input' })[direction] || direction : direction);
        const drivers = effective.flatMap((direction, index) => direction === 'output' ? [index] : []);
        const receivers = effective.flatMap((direction, index) => direction === 'input' ? [index] : []);
        const proven = drivers.length === 1 && receivers.length > 0
            && effective.every(direction => ['input', 'output', 'unlisted'].includes(direction));
        return { ...member, directions, drivers, receivers, proven };
    });
    const valid = members.find(member => member.name === 'valid');
    const ready = members.find(member => member.name === 'ready');
    const producer = valid?.proven ? valid.drivers[0] : null;
    const handshake = producer !== null && Boolean(ready?.proven)
        && ready.receivers.includes(producer) && valid.receivers.includes(ready.drivers[0]);
    for (const member of members) {
        member.flow = !member.proven ? 'unknown'
            : producer === member.drivers[0] ? 'forward'
                : producer !== null && member.receivers.includes(producer) ? 'reverse' : 'directed';
    }
    const senders = new Set(members.filter(member => member.proven).flatMap(member => member.drivers));
    let leading = producer, evidence = producer === null ? null : 'valid';
    if (leading === null && senders.size === 1) {
        leading = [...senders][0];
        evidence = 'single';
    }
    // 全双工总线两端都驱动成员：先按 modport 角色名，再按驱动位宽定主流向。
    if (leading === null && endpoints.length === 2) {
        const [left, right] = endpoints.map(roleScore);
        if (left !== right) {
            leading = left > right ? 0 : 1;
            evidence = 'role';
        } else {
            const bits = index => members.filter(member => member.proven)
                .reduce((sum, member) => sum + (member.drivers.includes(index) ? member.width || 1 : 0), 0);
            const [fromLeft, fromRight] = [bits(0), bits(1)];
            if (fromLeft !== fromRight) {
                leading = fromLeft > fromRight ? 0 : 1;
                evidence = 'width';
            }
        }
    }
    let routes = leading === null ? [] : [...new Set(members.filter(member => member.proven && member.drivers[0] === leading)
        .flatMap(member => member.receivers))].map(target => ({ source: leading, target }));
    // 三端以上的共享束没有单一主流向端，改用逐成员证据；两端束已有主流向端时不再展开，避免两套结论。
    if (!routes.length && endpoints.length > 2) {
        const pairs = new Map();
        for (const member of members.filter(item => item.proven))
            for (const source of member.drivers) for (const target of member.receivers)
                if (source !== target) pairs.set(source + '>' + target, { source, target });
        routes = [...pairs.values()];
        if (routes.length) evidence = 'member';
    }
    return { members, handshake, routes, flowEvidence: routes.length ? evidence : null };
}

module.exports = { connectionEvidence, roleScore };
