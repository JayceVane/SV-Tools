'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tests = fs.readdirSync(path.join(__dirname, '..', 'test')).filter(name => /^circuit_.*_test\.js$/.test(name)).sort();
if (!tests.length) throw new Error('未找到电路回归测试');
const result = spawnSync(process.execPath, ['--test', ...tests.map(name => path.join('test', name))], {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status || (result.signal ? 1 : 0);
