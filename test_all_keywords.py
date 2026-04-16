#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test all SystemVerilog keywords for GNU-to-1tbs preprocessing"""
import sys
import os

# Add python directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))

from daemon import FormatterDaemon

# Comprehensive test with all possible SystemVerilog keywords
test_cases = """
// Test fork-join
fork
begin
    statement1;
end
join

// Test repeat
repeat (10)
begin
    statement;
end

// Test while
while (condition)
begin
    statement;
end

// Test do-while
do
begin
    statement;
end
while (condition);

// Test foreach
foreach (array[i])
begin
    statement;
end

// Test forever
forever
begin
    statement;
end

// Test for
for (int i = 0; i < 10; i++)
begin
    statement;
end

// Test if
if (condition)
begin
    statement;
end

// Test else if
else if (condition2)
begin
    statement;
end

// Test else
else
begin
    statement;
end

// Test case
case (expression)
1'b0:
begin
    statement;
end
1'b1:
begin
    statement;
end
endcase

// Test always_ff
always_ff @(posedge clk)
begin
    q <= d;
end

// Test always_comb
always_comb
begin
    c = a | b;
end

// Test always_latch
always_latch
begin
    if (enable)
        q <= d;
end

// Test initial
initial
begin
    value = 0;
end

// Test final
final
begin
    $display("Done");
end

// Test task
task my_task;
begin
    statement;
end
endtask

// Test function
function my_func;
begin
    statement;
end
endfunction

// Test class
class MyClass;
begin
    int value;
end
endclass

// Test interface
interface MyInterface;
begin
    logic sig;
end
endinterface

// Test module
module TestModule;
begin
    wire w;
end
endmodule

// Test package
package MyPackage;
begin
    typedef int my_int;
end
endpackage

// Test program
program TestProgram;
begin
    initial $display("test");
end
endprogram

// Test clocking
clocking cb @(posedge clk);
begin
    default input #1step output #1step;
end
endclocking

// Test block
begin
    statement;
end

// Test generate
generate
begin
    for (genvar i = 0; i < 8; i++) begin : gen_block
        // code
    end
end
endgenerate

// Test specify
specify
begin
    specparam delay = 1.0;
end
endspecify

// Test property
property my_prop;
begin
    @(posedge clk) disable iff (!rst_n) a |-> b;
end
endproperty

// Test sequence
sequence my_seq;
begin
    a ##1 b;
end
endsequence

// Test covergroup
covergroup cg @(posedge clk);
begin
    coverpoint cp;
end
endgroup

// Test randsequence
randsequence
begin
    body : prod1 prod2;
end
endsequence

// Test coverpoint
coverpoint cp
begin
    bins b = {0, 1};
end

// Test assert property
assert property (my_prop)
begin
    $display("pass");
end

// Test assume property
assume property (my_prop)
begin
    $display("assume");
end

// Test cover property
cover property (my_prop)
begin
    $display("cover");
end
"""

def run_test():
    """Run comprehensive test for all keywords"""
    daemon = FormatterDaemon()

    options = {'indentSyle': '1tbs'}
    result = daemon.preprocess_text(test_cases, options)

    print("=" * 80)
    print("全面关键字测试 - GNU 到 1tbs 转换")
    print("=" * 80)

    # Split into lines for analysis
    original_lines = test_cases.split('\n')
    result_lines = result.split('\n')

    keywords_tested = [
        'fork', 'repeat', 'while', 'do', 'foreach', 'forever', 'for',
        'if', 'else if', 'else', 'case', 'always_ff', 'always_comb',
        'always_latch', 'initial', 'final', 'task', 'function',
        'class', 'interface', 'module', 'package', 'program',
        'clocking', 'begin', 'generate', 'specify', 'property',
        'sequence', 'covergroup', 'randsequence', 'coverpoint'
    ]

    print("\n[测试结果分析]")
    print("=" * 80)

    # Check each keyword
    for keyword in keywords_tested:
        # Find lines with this keyword followed by standalone begin
        merged_count = 0
        not_merged_count = 0

        for i, line in enumerate(original_lines):
            if keyword in line and line.strip().startswith(keyword):
                # Check if next line is 'begin'
                if i + 1 < len(original_lines):
                    next_line_orig = original_lines[i + 1].strip()
                    if next_line_orig == 'begin':
                        # Check if merged in result
                        if i < len(result_lines):
                            result_line = result_lines[i]
                            if result_line.strip().endswith(' begin'):
                                merged_count += 1
                            else:
                                not_merged_count += 1

        status = "✓ 已合并" if merged_count > 0 else "✗ 未合并"
        print(f"{keyword:15s}: {status} (合并:{merged_count}, 未合并:{not_merged_count})")

    print("\n" + "=" * 80)
    print("[详细对比]")
    print("=" * 80)

    # Show first few differences
    diff_count = 0
    max_diff = 20

    for i in range(min(len(original_lines), len(result_lines))):
        orig = original_lines[i]
        res = result_lines[i]

        if orig != res:
            diff_count += 1
            if diff_count <= max_diff:
                print(f"\n行 {i+1}:")
                print(f"  原始: {orig}")
                print(f"  结果: {res}")

    print("\n" + "=" * 80)
    print(f"总共有 {diff_count} 行发生变化")
    print("=" * 80)

    # Save detailed result to file
    with open('test_result.txt', 'w', encoding='utf-8') as f:
        f.write("=" * 80 + "\n")
        f.write("完整转换结果\n")
        f.write("=" * 80 + "\n\n")
        f.write(result)

    print("\n完整结果已保存到 test_result.txt")

if __name__ == '__main__':
    run_test()
