'use strict';

// design report 的 Markdown 生成：模块接口分配表、接口连接表、结构检查与可追溯性。
// 表格方向缩写与 SVG 边界接口表一致（i/o/io，避免箭头在左右两侧含义翻转）；
// 连接表方向以端点 A 为视角：o=A 驱动 B、io=双向/混合、bus=共享网络（成员方向未声明）。

/** @param {string} direction 端口方向。 @returns {string} 表格方向缩写。 */
function directionAbbrev(direction) {
    return direction === 'input' ? 'i' : direction === 'output' ? 'o' : 'io';
}

/** @param {object} item 接口。 @returns {string} 连接方向缩写（A 视角）。 */
function interfaceDirection(item) {
    if (item.direction === 'forward') {
        return 'o';
    }
    if (item.direction === 'bidirectional') {
        return 'io';
    }
    return 'bus';
}

/** @param {object} port 端口。 @returns {string} `name[i/o/io:N]` 形式的单元格。 */
function portCell(port) {
    return port.name + ' [' + directionAbbrev(port.direction) + ':' + port.width + ']';
}

/** @param {object[]} checks 结构诊断。 @returns {string} 检查小节 Markdown。 */
function checksSection(checks) {
    if (!checks.length) {
        return ['## 结构检查', '', '`design check` 无诊断：未发现悬空 input、无驱动网络、多驱动、隐式位宽补常量或缺失模块。', ''].join('\n');
    }
    const lines = ['## 结构检查', '', '| 级别 | 诊断 | 实例/端口 | 说明 |', '| --- | --- | --- | --- |'];
    for (const item of checks) {
        const target = item.details.instance ? item.details.instance + '/' + (item.details.port || '')
            : item.details.port || (item.details.drivers || []).join('、');
        lines.push('| ' + item.severity + ' | ' + item.code + ' | ' + target + ' | ' + item.message.replaceAll('|', '\\|') + ' |');
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * 生成架构报告 Markdown。
 * @param {object} arch 架构数据（含 checks/instances/interfaces/sourceFiles/limitations）。
 * @param {{svgFile:string,pngFile:string,pngSha256:string|null,scale:number|null,svgSha256:string}} images 图像产物。
 * @returns {string} Markdown 文本。
 */
function generateReportMarkdown(arch, images) {
    const instances = arch.instances || [];
    const hasBlackbox = instances.some(item => item.implementation === 'blackbox');
    const lines = [];
    lines.push('# ' + (arch.top ? arch.top.name : 'architecture') + ' 架构报告', '');
    const errors = (arch.checks || []).filter(item => item.severity === 'error').length;
    const warnings = (arch.checks || []).filter(item => item.severity === 'warning').length;
    lines.push('顶层 `' + (arch.top ? arch.top.name : '?') + '`，' + instances.length + ' 个模块实例、'
        + (arch.interfaces || []).length + ' 个接口连接。结构检查：'
        + ((arch.checks || []).length ? errors + ' error / ' + warnings + ' warning' : '无诊断') + '。', '');
    lines.push('![架构图](' + images.svgFile + ')', '');
    if (images.pngFile) {
        lines.push('位图版本（' + images.scale + 'x 栅格化）：`' + images.pngFile + '`。', '');
    }
    lines.push('## 模块接口分配', '');
    lines.push('端口方向缩写：`i` 输入、`o` 输出、`io` 双向；位数为连接后的实际位宽。', '');
    lines.push('| 实例 | 模块 | 实现 | 端口（方向:位数） |');
    lines.push('| --- | --- | --- | --- |');
    for (const instance of instances) {
        const ports = instance.ports.length ? instance.ports.map(portCell).join(' ') : '（unresolved，不伪造端口表）';
        lines.push('| ' + instance.name + ' | ' + instance.module.replaceAll('|', '\\|') + ' | ' + instance.implementation
            + (instance.status === 'unresolved' ? '/unresolved' : '') + ' | ' + ports + ' |');
    }
    lines.push('', '## 接口连接', '');
    lines.push('方向以端点 A 为视角：`o` = A 驱动 B；`io` = 双向或成员混合方向；`bus` = 共享网络相连，成员级方向未声明。分组只用于展示，不代表协议识别。', '');
    lines.push('| 接口 | 端点 A | 端点 B | 位数 | 方向 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of arch.interfaces || []) {
        lines.push('| ' + item.label.replaceAll('|', '\\|') + ' | ' + item.from.name.replaceAll('+', ' + ')
            + ' | ' + item.to.name.replaceAll('+', ' + ') + ' | ' + item.bits + ' | ' + interfaceDirection(item) + ' |');
    }
    lines.push('', checksSection(arch.checks || []), '## 来源与可追溯性', '');
    lines.push('此报告是源级架构投影' + (hasBlackbox ? '（含空模块，未实现部分保留待实现状态）' : '')
        + '；不作为功能、综合或时序验证结论。', '');
    for (const file of arch.sourceFiles || []) {
        lines.push('- 源码：`' + file.path + '`，SHA-256 `' + file.sha256 + '`');
    }
    lines.push('- 架构 SHA-256：`' + arch.archSha256 + '`');
    lines.push('- SVG SHA-256：`' + images.svgSha256 + '`');
    if (images.pngSha256) {
        lines.push('- PNG SHA-256：`' + images.pngSha256 + '`（' + images.scale + 'x）');
    }
    lines.push('- 上下文版本：`' + (arch.contextRevision || 'unknown') + '`；设计身份：`' + arch.designId + '`');
    lines.push('- 边界：' + (arch.limitations || []).join(' '));
    lines.push('- 机器可读数据：`architecture.json`；导出参数与证据：`report.json`');
    return lines.join('\n') + '\n';
}

module.exports = { generateReportMarkdown, directionAbbrev, interfaceDirection };
