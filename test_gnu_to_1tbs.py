#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test script for GNU to 1tbs conversion - preprocess only"""
import sys
import os

# Set UTF-8 encoding for Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

def preprocess_text(text, indent_style='1tbs'):
    """Preprocess text to handle GNU-to-1tbs style conversion"""
    import re

    # If using 1tbs style, merge standalone 'begin' to previous line
    if indent_style == '1tbs':
        lines = text.split('\n')
        processed_lines = []
        i = 0
        while i < len(lines):
            current_line = lines[i].rstrip()
            next_line = lines[i + 1].rstrip() if i + 1 < len(lines) else None

            # Check if next line is a standalone 'begin'
            if next_line and next_line.strip() == 'begin':
                # Keywords that should be followed by 'begin' on the same line in 1tbs style
                start_keywords = [
                    r'\balways\b.*\b(?:ff|comb|latch)\b',
                    r'\b(?:if|else\s+if|case|for(?:ever)?\b.*\b(?:begin|end)\b',
                    r'\b(?:task|function|interface|module|class|package|program|clocking)\b',
                    r'\b(?:block|generate|specify|property)\b',
                    r'\bsequence\b',
                    r'\bcovergroup\b',
                    r'\b(?:initial|final)\b'
                ]

                # Check if current line matches any of these patterns
                should_merge = False
                for pattern in start_keywords:
                    if re.search(pattern, current_line, re.IGNORECASE):
                        should_merge = True
                        break

                # Also check if current line ends with : or just content that shouldn't have begin on next line
                if (should_merge or
                    (current_line and
                     not current_line.rstrip().endswith(')') and  # Not port list end
                     not current_line.strip().endswith(';') and      # Not statement end
                     not current_line.strip().endswith('//') and      # Not comment
                     not current_line.strip().endswith('*/') and      # Not block comment
                     len(current_line.strip()) > 0)):                # Not empty line
                    # Merge begin to current line
                    processed_lines.append(current_line + ' begin')
                    i += 2  # Skip the 'begin' line
                    continue

            processed_lines.append(lines[i])
            i += 1

        return '\n'.join(processed_lines)

    return text

# Test code that has GNU style (begin on separate line)
test_code_gnu = """module test
(
   input clk,
   output reg [7:0] data
);
begin
   if (condition)
   begin
      q <= d;
   end
end
endmodule"""

print("Original GNU-style code:")
print("=" * 60)
print(test_code_gnu)

print("\n" + "=" * 60)
print("After preprocessing (1tbs mode):")
print("=" * 60)

result = preprocess_text(test_code_gnu, '1tbs')
print(result)
