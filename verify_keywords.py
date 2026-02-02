#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""简单验证关键字转换功能"""
import sys
import os

# Add python directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))

from daemon import FormatterDaemon

# Test the specific keywords mentioned by user
test_cases = [
    ('fork', '\nfork\nbegin\n    stmt;\nend\njoin'),
    ('repeat', '\nrepeat (10)\nbegin\n    stmt;\nend'),
    ('while', '\nwhile (cond)\nbegin\n    stmt;\nend'),
    ('foreach', '\nforeach (arr[i])\nbegin\n    stmt;\nend'),
]

def verify():
    """Verify specific keywords"""
    daemon = FormatterDaemon()
    options = {'indentSyle': '1tbs'}

    print("=" * 60)
    print("关键字转换验证")
    print("=" * 60)

    all_passed = True

    for name, test_code in test_cases:
        result = daemon.preprocess_text(test_code, options)

        # Check if 'begin' is merged
        has_merged_begin = ' begin\n' in result or ' begin ' in result

        status = "✓ 通过" if has_merged_begin else "✗ 失败"
        print(f"{name:15s}: {status}")

        if not has_merged_begin:
            all_passed = False
            print(f"  输入: {repr(test_code)}")
            print(f"  输出: {repr(result)}")

    print("\n" + "=" * 60)
    if all_passed:
        print("✓ 所有关键字测试通过")
    else:
        print("✗ 部分关键字测试失败")
    print("=" * 60)

if __name__ == '__main__':
    verify()
