'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, result } = require('./protocol');
const { readOptions } = require('./context');
const { createNativeLoader } = require('../native-loader');

/** 模块例化与测试台生成：复用扩展的原生生成器，结果可写文件或直接输出。 */
function createRtlCommands({ native, loader } = {}) {
    const load = () => native || (loader || createNativeLoader()).load();
    async function generate(kind, input) {
        const { options } = await readOptions(input);
        const file = input.file ? path.resolve(options.workspace, input.file) : null;
        if (!file) fail('FILE_REQUIRED', 'rtl ' + kind + ' 需要 --file <hdl>');
        const text = await fs.readFile(file, 'utf8').catch(error => fail('SOURCE_NOT_FOUND', '无法读取源文件：' + error.message, { file }));
        let api;
        try { api = load(); }
        catch (error) { fail('NATIVE_ENGINE_UNAVAILABLE', '需要原生生成器（svtools-native）：' + error.message, {}, 2); }
        const generateFn = kind === 'instantiate' ? api.generateModuleInst : api.generateTestbench;
        if (typeof generateFn !== 'function') fail('NATIVE_ENGINE_UNAVAILABLE', '原生生成器缺少 ' + kind + ' 接口', {}, 2);
        let output;
        try { output = generateFn(text, {}); }
        catch (error) { fail('GENERATE_FAILED', error.message || '生成失败', { file }, 1); }
        if (!output || output.success !== true) fail('GENERATE_FAILED', output?.error || '生成失败', { file }, 1);
        let written = null;
        if (input.out) {
            written = path.resolve(options.workspace, input.out);
            await fs.mkdir(path.dirname(written), { recursive: true });
            await fs.writeFile(written, output.result, 'utf8');
        }
        return result('rtl.' + kind, { file, module: output.module || null, text: output.result, output: written });
    }
    return {
        instantiate: input => generate('instantiate', input),
        testbench: input => generate('testbench', input)
    };
}

module.exports = { createRtlCommands };
