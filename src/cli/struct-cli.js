'use strict';

const { argumentsFor } = require('./main');
const { fail, failure } = require('../agent/protocol');
const { command } = require('../design/struct');
const operations = require('../agent/operations');

const help = `svtools-struct — SystemVerilog source architecture
  parse [--file <hdl>]
  arch --top <module> [--save <name>]
  check --top <module>
  render --top <module> [--out <dir>] [--detail interfaces|signals]
         [--style document|presentation] [--title <text>]
  lower [--file <hdl>] [--out <dir>]
  diff --top <module> --baseline <name|file>

All commands accept --workspace <dir> and repeatable --source <hdl>.
Exit codes: 0 success, 1 structural findings, 2 invalid input or tool failure.
`;

async function runStruct(argv, { version, loadNative }) {
    let operation = 'struct';
    try {
        const { input, positionals: [action, ...extra] } = argumentsFor(argv);
        if (input.help || (!action && !input.version)) return { text: help, exitCode: 0 };
        if (input.version) return { text: `svtools-struct ${version} (API 1)\n`, exitCode: 0 };
        if (extra.length || !['parse', 'arch', 'check', 'render', 'lower', 'diff'].includes(action)) {
            fail('INVALID_ARGUMENT', '未知命令或参数，请使用 --help');
        }
        operation = action === 'parse' ? 'struct.parse' : 'design.' + action;
        if (input.engine !== undefined && input.engine !== 'struct') fail('INVALID_ARGUMENT', '此工具使用 struct 引擎');
        if (input.imageFormat !== undefined && input.imageFormat !== 'svg') fail('INVALID_ARGUMENT', '此工具的图形输出格式为 SVG');
        const runtime = { native: await loadNative() };
        const output = action === 'parse' || action === 'lower'
            ? await command(action, input, runtime)
            : await operations[action]({ ...input, engine: 'struct' }, runtime);
        return { output, exitCode: output.status === 'success' ? 0 : 1 };
    } catch (error) {
        return { output: failure(operation, error), exitCode: error.exitCode || 2 };
    }
}

module.exports = { runStruct };
