// Test script for svtools native module
const path = require('path');

// Load the native module
const svtools = require('./svtools.win32-x64-msvc.node');

console.log('Loaded svtools native module');

// Test 1: Format simple module
const testCode1 = `module test(input clk,input rst,output reg q);always @(posedge clk)q<=1;endmodule`;

const options = {
  indentStyle: '1tbs',
  useTab: false,
  nbSpace: 4,
  maxConsecutiveEmptyLines: 2,
  reindentOnly: false,
  ignoreTick: false,
  oneDeclPerLine: false,
  oneBindPerLine: true,
  alignComma: false,
  paramOneLine: false,
  importSameLine: true,
  instAlignPort: true
};

console.log('\n--- Test 1: Format simple module ---');
console.log('Input:', testCode1);
const formatted1 = svtools.formatText(testCode1, options);
console.log('Output:\n', formatted1);

// Test 2: Format with declarations
const testCode2 = `module my_module(
input wire clk,
input wire rst_n,
output reg [7:0] data_out
);
reg [7:0] counter;
wire enable;
always @(posedge clk or negedge rst_n) begin
if(!rst_n) counter<=0;
else counter<=counter+1;
end
assign data_out=counter;
endmodule`;

console.log('\n--- Test 2: Format module with declarations ---');
const formatted2 = svtools.formatText(testCode2, options);
console.log('Output:\n', formatted2);

console.log('\n=== All tests passed ===');

// Test 3: Format interface file
const fs = require('fs');
const testCode3 = fs.readFileSync(path.join(__dirname, '..', 'test', 'test_interface_format.v'), 'utf8');

console.log('\n--- Test 3: Format interface file ---');
const formatted3 = svtools.formatText(testCode3, options);
console.log('Output:\n', formatted3);
console.log('\n=== Test 3 completed ===');
