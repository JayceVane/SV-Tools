const svtools = require('./svtools.win32-x64-msvc.node');

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

console.log('Testing generateModuleInst...');
const result = svtools.generateModuleInst(moduleCode, gadgetOptions);
console.log('Result:', JSON.stringify(result, null, 2));

console.log('\n\nTesting generateTestbench...');
const tbOptions = {
    instPrefix: 'inst_',
    reset: ['rst_n'],
    clock: ['clk'],
    waveType: 'fsdb',
    taskInit: true,
    taskDrive: true
};
const tbResult = svtools.generateTestbench(moduleCode, tbOptions);
console.log('TB Result:', JSON.stringify(tbResult, null, 2));
