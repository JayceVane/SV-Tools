'use strict';
const { randomUUID } = require('node:crypto');
const API_VERSION = '1';
class ServiceError extends Error {
    constructor(code, message, details = {}, exitCode = 2) { super(message); this.code = code; this.details = details; this.exitCode = exitCode; }
}
const fail = (code, message, details, exitCode) => { throw new ServiceError(code, message, details, exitCode); };
function identity(context) {
    if (!context) return null;
    const { id, revision, workspace, project, fileset, top } = context;
    return { id, revision, workspace, project, fileset, top };
}
function result(operation, data = {}, context = null, diagnostics = [], artifacts = []) {
    return { apiVersion: API_VERSION, requestId: randomUUID(), operation, status: 'success', context: identity(context), diagnostics, artifacts, data };
}
function failure(operation, error) {
    return { apiVersion: API_VERSION, requestId: randomUUID(), operation, status: error.code === 'TOOL_CANCELLED' ? 'cancelled' : 'failed', context: error.details?.context || null,
        diagnostics: [{ code: error.code || 'SERVICE_FAILED', severity: 'error', message: error.message }], artifacts: error.details?.artifacts || [], data: error.details || {} };
}
module.exports = { API_VERSION, ServiceError, fail, identity, result, failure };
