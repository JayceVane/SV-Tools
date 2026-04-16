#!/usr/bin/env python3
"""
SystemVerilog formatter wrapper for VSCode extension
Accepts a file path and formatting options, outputs formatted text

Copyright (c) 2025 JayceVane (JayceVane@163.com)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

This is a VSCode extension adapted from the Sublime Text SystemVerilog plugin
by Nicolas Belmonte (https://github.com/nicolas3d/SystemVerilog)
"""

import sys
import os
import json
import io

# Force UTF-8 encoding for output to handle Chinese and other non-ASCII characters
# This is critical for Windows systems where the default encoding may be GBK or CP936
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

# Add parent directory to path to import verilog_beautifier
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Add verilogutil to path so verilog_beautifier can import it
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'verilogutil'))
from verilog_beautifier import VerilogBeautifier


def main():
    if len(sys.argv) < 2:
        print("Usage: formatter.py <input_file> [options_json]", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]

    # Parse options if provided
    options = {
        'nbSpace': 3,
        'useTab': False,
        'oneBindPerLine': True,
        'oneDeclPerLine': False,
        'paramOneLine': True,
        'indentSyle': '1tbs',
        'reindentOnly': False,
        'stripEmptyLine': True,
        'instAlignPort': True,
        'ignoreTick': True,
        'importSameLine': False,
        'alignComma': True
    }

    if len(sys.argv) >= 3:
        try:
            user_options = json.loads(sys.argv[2])
            options.update(user_options)
        except json.JSONDecodeError as e:
            print(f"Error parsing options: {e}", file=sys.stderr)
            # Continue with default options

    try:
        # Read input file
        with open(input_file, 'r', encoding='utf-8') as f:
            text = f.read()

        # Create beautifier with options
        beautifier = VerilogBeautifier(
            nbSpace=options.get('nbSpace', 3),
            useTab=options.get('useTab', False),
            oneBindPerLine=options.get('oneBindPerLine', True),
            oneDeclPerLine=options.get('oneDeclPerLine', False),
            paramOneLine=options.get('paramOneLine', True),
            indentSyle=options.get('indentSyle', '1tbs'),
            reindentOnly=options.get('reindentOnly', False),
            stripEmptyLine=options.get('stripEmptyLine', True),
            instAlignPort=options.get('instAlignPort', True),
            ignoreTick=options.get('ignoreTick', True),
            importSameLine=options.get('importSameLine', False),
            alignComma=options.get('alignComma', True)
        )

        # Format text
        formatted_text = beautifier.beautifyText(text)

        # Output formatted text
        print(formatted_text, end='')

    except FileNotFoundError:
        print(f"Error: File not found: {input_file}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error formatting file: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
