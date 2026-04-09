/**
 * Test script to verify native module integration with extension.js
 */

const path = require('path');

// Simulate VSCode API
const mockVscode = {
    workspace: {
        getConfiguration: (section) => {
            const configs = {
                'svAlign': {
                    get: (key, defaultValue) => {
                        const values = {
                            'indentStyle': '1tbs',
                            'useTab': false,
                            'tabSize': 4,
                            'maxConsecutiveEmptyLines': 1,
                            'ignoreTick': true,
                            'oneDeclPerLine': false,
                            'oneBindPerLine': true,
                            'alignComma': true,
                            'paramOneLine': true,
                            'importSameLine': false,
                            'instAlignPort': true
                        };
                        return values[key] !== undefined ? values[key] : defaultValue;
                    }
                },
                'svGadget': {
                    get: (key, defaultValue) => {
                        const values = {
                            'instPrefix': 'inst_',
                            'reset': ['rst_n', 'reset'],
                            'sreset': ['sreset_n'],
                            'clock': ['clk', 'uclk'],
                            'waveType': 'fsdb',
                            'taskInit': true,
                            'taskDrive': true,
                            'includePortDeclarations': true
                        };
                        return values[key] !== undefined ? values[key] : defaultValue;
                    }
                }
            };
            return configs[section] || { get: (_, d) => d };
        }
    },
    window: {
        showInformationMessage: (msg) => console.log('[INFO]', msg),
        showWarningMessage: (msg) => console.log('[WARN]', msg),
        showErrorMessage: (msg) => console.log('[ERROR]', msg)
    }
};

// Load native module
const svtools = require('./svtools.win32-x64-msvc.node');
console.log('Native module loaded');

// Test 1: Format text
console.log('\n=== Test 1: formatText ===');
const testCode = `module test(input clk,input rst,output reg q);always @(posedge clk)q<=1;endmodule`;
const formatOptions = {
    indentStyle: '1tbs',
    useTab: false,
    nbSpace: 4,
    maxConsecutiveEmptyLines: 1,
    reindentOnly: false,
    ignoreTick: true,
    oneDeclPerLine: false,
    oneBindPerLine: true,
    alignComma: true,
    paramOneLine: true,
    importSameLine: false,
    instAlignPort: true
};
const formatted = svtools.formatText(testCode, formatOptions);
console.log('Formatted output:\n' + formatted);

// Test 2: Generate module instance
console.log('\n=== Test 2: generateModuleInst ===');
const moduleCode = `
module my_module #(
    parameter WIDTH = 8
)(
    input wire clk,
    input wire rst_n,
    input wire [WIDTH-1:0] data_in,
    output reg [WIDTH-1:0] data_out
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) data_out <= 0;
        else data_out <= data_in;
    end
endmodule
`;
const gadgetOptions = {
    instPrefix: 'inst_',
    reset: ['rst_n', 'reset'],
    clock: ['clk'],
    includeDeclarations: true
};
const instResult = svtools.generateModuleInst(moduleCode, gadgetOptions);
console.log('Module inst result:', instResult);

// Test 3: Generate testbench
console.log('\n=== Test 3: generateTestbench ===');
const tbOptions = {
    instPrefix: 'inst_',
    reset: ['rst_n'],
    clock: ['clk'],
    waveType: 'fsdb',
    taskInit: true,
    taskDrive: true
};
const tbResult = svtools.generateTestbench(moduleCode, tbOptions);
console.log('Testbench generated:', tbResult.success);

// Test 4: Repeat code
console.log('\n=== Test 4: repeatCode ===');
const repeatOptions = {
    start: 0,
    end: 3,
    rowStep: 1,
    colStep: 0,
    clipboardLines: []
};
const repeatResult = svtools.repeatCode('wire [7:0] signal_{#};', repeatOptions);
console.log('Repeat result:\n' + repeatResult);

// Test 5: Align code
console.log('\n=== Test 5: alignCode ===');
const alignCode = `
wire a;
wire [7:0] b;
wire [15:0] c;
`;
const aligned = svtools.alignCode(alignCode, 4);
console.log('Aligned:\n' + aligned);

// Test 6: Generate header
console.log('\n=== Test 6: generateHeader ===');
const headerTemplate = `// File: {FILE}
// Date: {DATE}
// Year: {YEAR}
`;
const header = svtools.generateHeader(headerTemplate, 'test.v', 4);
console.log('Header:\n' + header);

console.log('\n=== All tests completed ===');
