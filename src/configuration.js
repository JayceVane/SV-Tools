'use strict';

// VS Code 清单集中提供配置默认值；这里仅映射编辑器名称与 napi 字段。
const configuration = require('../package.json').contributes.configuration;
const sections = Array.isArray(configuration) ? configuration : [configuration];
const properties = Object.assign({}, ...sections.map(section => section.properties));

/** @param {{get: (key: string, defaultValue: unknown) => unknown}} config @param {string} name @returns {unknown} */
function readOption(config, name) {
    return config.get(name, properties['svtools.' + name].default);
}

/** @param {Parameters<typeof readOption>[0]} config @returns {object} Rust 格式化选项。 */
function buildFormatOptions(config) {
    const names = ['indentStyle', 'useTab', 'maxConsecutiveEmptyLines', 'stripEmptyLine',
        'ignoreTick', 'oneDeclPerLine', 'oneBindPerLine', 'alignComma', 'paramOneLine',
        'importSameLine', 'instAlignPort', 'inlineCompact', 'blankCompact', 'portNameGap'];
    const options = Object.fromEntries(names.map(name => [name, readOption(config, name)]));
    return { ...options, nbSpace: readOption(config, 'tabSize'), reindentOnly: false };
}

/** @param {Parameters<typeof readOption>[0]} config @returns {object} Rust 例化选项。 */
function buildModuleOptions(config) {
    return { instPrefix: readOption(config, 'instPrefix'), reset: readOption(config, 'reset'),
        includeDeclarations: readOption(config, 'includePortDeclarations') };
}

/** @param {Parameters<typeof readOption>[0]} config @returns {object} Rust 测试台生成选项。 */
function buildTestbenchOptions(config) {
    const names = ['instPrefix', 'reset', 'sreset', 'clock', 'waveType', 'taskInit', 'taskDrive'];
    return Object.fromEntries(names.map(name => [name, readOption(config, name)]));
}

module.exports = { buildFormatOptions, buildModuleOptions, buildTestbenchOptions };
