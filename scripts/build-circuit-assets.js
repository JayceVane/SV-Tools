'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 将固定版本 ELK 的运行文件和许可带入 VSIX，不在运行时依赖 node_modules。 */
function buildCircuitAssets() {
    const root = path.resolve(__dirname, '..');
    const library = path.dirname(require.resolve('elkjs/package.json'));
    const destination = path.join(root, 'bin', 'vendor');
    fs.mkdirSync(destination, { recursive: true });
    for (const [source, target] of [['lib/elk.bundled.js', 'elk.bundled.js'], ['LICENSE.md', 'ELK-LICENSE.md']]) {
        fs.copyFileSync(path.join(library, source), path.join(destination, target));
    }
    console.log('电路布局资源：ELK ' + require('elkjs/package.json').version);
}

if (require.main === module) buildCircuitAssets();
module.exports = { buildCircuitAssets };
