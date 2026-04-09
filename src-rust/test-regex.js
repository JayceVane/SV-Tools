const text = `
module my_module #(
    parameter WIDTH = 8
)(
    input wire clk,
    input wire rst_n
);
endmodule
`;

// Test with 's' flag for dotAll
const re = new RegExp('(?<!\\S)module(?!\\S).+?(?<!\\S)endmodule(?!\\S)', 's');
const match = text.match(re);
console.log('Match:', match ? match[0].substring(0, 100) + '...' : 'NO MATCH');

// Test without lookbehind
const re2 = new RegExp('module\\s+\\w+.+?endmodule', 's');
const match2 = text.match(re2);
console.log('Match2:', match2 ? match2[0].substring(0, 100) + '...' : 'NO MATCH');

// Test module definition
const re3 = new RegExp('module[^;]+;', 's');
const match3 = text.match(re3);
console.log('Match3:', match3 ? match3[0] : 'NO MATCH');
