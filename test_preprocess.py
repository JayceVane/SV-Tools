#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test GNU-to-1tbs preprocessing"""
import sys
import os

# Add python directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))

from daemon import FormatterDaemon

# Test input: GNU-formatted code with standalone 'begin'
gnu_test_code = """
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

    initial
    begin
        data_out = 8'h00;
    end

endmodule
"""

# Expected output: 1tbs style with 'begin' on same line
expected_1tbs_code = """
module test_module
(
    input logic clk,
    input logic rst_n,
    output logic [7:0] data_out
);
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            data_out <= 8'h00;
        end
        else begin
            data_out <= data_in + 1;
        end
    end

    always_comb begin
        if (select == 1) begin
            result = a + b;
        end
        else begin
            result = a - b;
        end
    end

    initial begin
        data_out = 8'h00;
    end

endmodule
"""

def test_preprocessing():
    """Test the preprocessing functionality"""
    daemon = FormatterDaemon()

    # Test with 1tbs style
    options = {'indentSyle': '1tbs'}
    result = daemon.preprocess_text(gnu_test_code, options)

    print("=" * 60)
    print("GNU-to-1tbs Preprocessing Test")
    print("=" * 60)

    print("\n[Input] GNU-formatted code:")
    print("-" * 60)
    print(gnu_test_code)

    print("\n[Output] After preprocessing:")
    print("-" * 60)
    print(result)

    print("\n[Expected] 1tbs-style code:")
    print("-" * 60)
    print(expected_1tbs_code)

    # Check if begin was merged
    gnu_begin_count = gnu_test_code.count('\nbegin\n')
    result_begin_count = result.count(' begin\n')

    print("\n" + "=" * 60)
    print("[Statistics]")
    print("=" * 60)
    print(f"GNU standalone 'begin' count: {gnu_begin_count}")
    print(f"Result merged 'begin' count: {result_begin_count}")

    if result_begin_count > 0:
        print("\n✓ SUCCESS: Preprocessing merged 'begin' to previous lines")
    else:
        print("\n✗ FAILED: No 'begin' was merged")

    # Test with gnu style (should not merge)
    print("\n" + "=" * 60)
    print("[Test with GNU style] - Should NOT merge")
    print("=" * 60)
    options_gnu = {'indentSyle': 'gnu'}
    result_gnu = daemon.preprocess_text(gnu_test_code, options_gnu)

    gnu_begin_count_after = result_gnu.count('\nbegin\n')
    print(f"GNU standalone 'begin' count after: {gnu_begin_count_after}")

    if gnu_begin_count_after == gnu_begin_count:
        print("✓ CORRECT: GNU style did not merge 'begin'")
    else:
        print("✗ INCORRECT: GNU style merged 'begin' when it shouldn't")

if __name__ == '__main__':
    test_preprocessing()
