'use strict';
// 真实Vivado门控测试：仅当指定工程且本机存在Vivado时运行，CI无Vivado时自动跳过。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { status } = require('../src/agent/vivado');
const { findVivadoBinDir } = require('../src/vivado/toolchain');

const project = process.env.SVTOOLS_TEST_VIVADO_PROJECT;
const ready = !!project && !!findVivadoBinDir('');

test('真实Vivado状态查询绑定工程并返回器件与runs', { skip: !ready && '未设置SVTOOLS_TEST_VIVADO_PROJECT或未安装Vivado' }, async () => {
    const output = await status({ workspace: path.dirname(project), project: path.basename(project) });
    assert.equal(output.status, 'success', JSON.stringify(output.diagnostics));
    assert.equal(typeof output.data.version, 'string');
    assert.equal(typeof output.data.part, 'string');
    assert(Array.isArray(output.data.runs) && output.data.runs.length >= 1);
    assert.equal(output.context.project.kind, 'vivado');
});
