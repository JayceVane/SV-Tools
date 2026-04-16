#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测试最大连续空行控制功能"""
import sys
import os

# Add python directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))

from daemon import FormatterDaemon

# Test code with excessive empty lines
test_code = """
module test_module
(
    input logic clk,
    input logic rst_n,
    output logic [7:0] data_out
);




    always_ff @(posedge clk or negedge rst_n)




    begin




        if (!rst_n)



        begin
            data_out <= 8'h00;



        end
        else



        begin
            data_out <= data_in + 1;




        end




    end




    always_comb




    begin
        if (select == 1)



        begin
            result = a + b;



        end
        else



        begin
            result = a - b;



        end




    end




endmodule
"""

def test_empty_lines():
    """Test the postprocessing of empty lines"""
    daemon = FormatterDaemon()

    test_cases = [
        (0, "移除所有空行"),
        (1, "最多1个连续空行（默认）"),
        (2, "最多2个连续空行"),
    ]

    print("=" * 70)
    print("最大连续空行控制测试")
    print("=" * 70)

    for max_lines, description in test_cases:
        print(f"\n{'=' * 70}")
        print(f"测试配置: maxConsecutiveEmptyLines = {max_lines} ({description})")
        print("=" * 70)

        options = {
            'indentSyle': '1tbs',
            'maxConsecutiveEmptyLines': max_lines
        }

        result = daemon.postprocess_text(test_code, options)

        # Count consecutive empty lines in result
        lines = result.split('\n')
        max_consecutive = 0
        current_consecutive = 0

        for line in lines:
            if line.strip() == '':
                current_consecutive += 1
                max_consecutive = max(max_consecutive, current_consecutive)
            else:
                current_consecutive = 0

        print(f"\n实际最大连续空行数: {max_consecutive}")

        # Show a snippet of the result
        result_lines = result.split('\n')
        print("\n代码片段预览:")
        print("-" * 70)
        for i, line in enumerate(result_lines[15:35], start=15):
            print(f"{i:3d}: {line}")

        if max_consecutive <= max_lines:
            print(f"\n✓ 测试通过: 实际空行数 ({max_consecutive}) <= 配置值 ({max_lines})")
        else:
            print(f"\n✗ 测试失败: 实际空行数 ({max_consecutive}) > 配置值 ({max_lines})")

    print("\n" + "=" * 70)
    print("测试完成")
    print("=" * 70)

if __name__ == '__main__':
    test_empty_lines()
