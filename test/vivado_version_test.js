'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseProjectVersion, projectVersion, same } = require('../src/vivado/version');

test('从 XPR 头部注释解析创建工具版本', () => {
    assert.equal(parseProjectVersion('<?xml version="1.0"?>\n<!-- Product Version: Vivado v2022.1.2 (64-bit) -->'), '2022.1.2');
    assert.equal(parseProjectVersion('<!-- Product Version: Vivado v2023.2 (64-bit) -->'), '2023.2');
    assert.equal(parseProjectVersion('<Project Version="7"/>'), undefined);
    assert.equal(parseProjectVersion(''), undefined);
});

test('版本比对要求完全一致', () => {
    assert.equal(same('2022.1.2', '2022.1.2'), true);
    assert.equal(same('2022.1', '2022.1.2'), false);
    assert.equal(same('2022.1.2', '2022.1'), false);
    assert.equal(same(undefined, '2022.1'), false);
    assert.equal(same('2022.1', undefined), false);
});

test('projectVersion 读取并缓存 XPR 文件', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-version-'));
    const file = path.join(directory, 'demo.xpr');
    try {
        await fs.writeFile(file, '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<!-- Product Version: Vivado v2023.2 (64-bit) -->\n<Project Version="7"/>');
        assert.equal(await projectVersion(file), '2023.2');
        // 文件未变化时命中缓存。
        await fs.writeFile(file, '<!-- Product Version: Vivado v2024.1 (64-bit) -->\n<Project/>');
        assert.equal(await projectVersion(file), '2024.1');
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('版本核验失败时不启动 Vivado 会话', async () => {
    const { createVivadoSessions } = require('../src/vivado/session');
    const calls = [];
    const sessions = createVivadoSessions({ verify: async (xpr, binDir) => { calls.push([xpr, binDir]); return false; } });
    try {
        const result = await sessions.run({ binDir: 'C:/vivado/bin', xpr: 'C:/proj/demo.xpr', task: {},
            directory: os.tmpdir(), scriptPath: 'unused.tcl' });
        assert.equal(result.ok, false);
        assert.match(result.error, /版本/u);
        assert.deepEqual(calls, [['C:/proj/demo.xpr', 'C:/vivado/bin']]);
    } finally {
        await sessions.dispose();
    }
});
