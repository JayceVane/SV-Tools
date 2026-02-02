#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测试 always 关键字的所有形式"""
import sys
import os

# Add python directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))

from daemon import FormatterDaemon

# Test all forms of always
test_always_forms = """
// Test traditional always with posedge
always @(posedge clk)
begin
    q <= d;
end

// Test traditional always with negedge
always @(negedge rst_n)
begin
    counter <= 0;
end

// Test traditional always with combo
always @(*)
begin
    c = a | b;
end

// Test traditional always with multiple signals
always @(a or b or c)
begin
    result = a & b & c;
end

// Test always_ff
always_ff @(posedge clk)
begin
    if (enable)
        data_out <= data_in;
end

// Test always_comb
always_comb
begin
    sum = a + b;
end

// Test always_latch
always_latch
begin
    if (clk)
        q <= d;
end
"""

def verify():
    """Verify all always forms"""
    daemon = FormatterDaemon()
    options = {'indentSyle': '1tbs'}

    result = daemon.preprocess_text(test_always_forms, options)

    print("=" * 70)
    print("Always 关键字所有形式测试")
    print("=" * 70)

    # Count occurrences
    original_always_count = test_always_forms.count('always')
    result_merged_count = result.count(' begin\n')

    print(f"\n原始 always 出现次数: {original_always_count}")
    print(f"合并 ' begin' 出现次数: {result_merged_count}")

    # Check specific forms
    test_cases = [
        ('always @(posedge clk)', 'always @(posedge clk) begin'),
        ('always @(negedge rst_n)', 'always @(negedge rst_n) begin'),
        ('always @(*)', 'always @(*) begin'),
        ('always @(a or b or c)', 'always @(a or b or c) begin'),
        ('always_ff @(posedge clk)', 'always_ff @(posedge clk) begin'),
        ('always_comb', 'always_comb begin'),
        ('always_latch', 'always_latch begin'),
    ]

    all_passed = True
    for original, expected in test_cases:
        if expected in result:
            print(f"✓ {original:40s} → 合并成功")
        else:
            print(f"✗ {original:40s} → 合并失败")
            all_passed = False

    print("\n" + "=" * 70)
    if all_passed:
        print("✓ 所有 always 形式测试通过")
    else:
        print("✗ 部分 always 形式测试失败")

    print("\n[完整结果]")
    print("=" * 70)
    print(result)

if __name__ == '__main__':
    verify()
