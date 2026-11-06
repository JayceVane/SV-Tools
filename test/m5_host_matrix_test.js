'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMatrix } = require('../scripts/verify-m5-host-matrix.cjs');

test('发行矩阵拒绝旧候选、空检查和重复宿主报告', () => {
    const candidate = { commit: '1'.repeat(40), version: '4.2.0', vsixSha256: 'a'.repeat(64) };
    const ides = ['Visual Studio Code', 'Qoder CN IDE'].map((name, index) => ({ name, sha256: String(index).repeat(64) }));
    const hosts = { circuit: 6, completion: 22, project: 10, vivado: 8, waveform: 5 };
    const rows = ides.flatMap((ide, index) => Object.entries(hosts).map(([host, passed]) => ({
        app: ide.name, host, vscode: '1.106.3', extension: candidate.version, passed, failed: 0,
        sha256: 'a'.repeat(64), report: index + '-' + host + '/host-report.json'
    })));
    const matrix = { schemaVersion: 2, candidate, ides, rows };
    assert.equal(validateMatrix(matrix, candidate), matrix);
    assert.throws(() => validateMatrix(matrix, { ...candidate, vsixSha256: 'b'.repeat(64) }));
    assert.throws(() => validateMatrix({ ...matrix, rows: Array(10).fill(rows[0]) }, candidate));
    assert.throws(() => validateMatrix({ ...matrix, rows: [{ ...rows[0], passed: 0 }, ...rows.slice(1)] }, candidate));
});
