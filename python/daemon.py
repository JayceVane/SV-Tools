#!/usr/bin/env python3
"""
SystemVerilog formatter daemon for VSCode extension
Provides persistent process for fast formatting via JSON-RPC over stdin/stdout

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
import threading

# Force UTF-8 encoding for input/output to handle Chinese and other non-ASCII characters
# This is critical for Windows systems where the default encoding may be GBK or CP936
if sys.platform == 'win32':
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

# Add parent directory to path to import verilog_beautifier
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'verilogutil'))

from verilog_beautifier import VerilogBeautifier


class FormatterDaemon:
    """Daemon process for handling SystemVerilog formatting requests"""

    def __init__(self):
        self.beautifier = None
        self.request_id = 0

    def create_beautifier(self, options):
        """Create or update the VerilogBeautifier instance with given options"""
        self.beautifier = VerilogBeautifier(
            nbSpace=options.get('nbSpace', 4),
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

    def preprocess_text(self, text, options):
        """Preprocess text to handle GNU-to-1tbs style conversion"""
        import re

        # If using 1tbs style, merge standalone 'begin' to previous line
        if options.get('indentSyle', '1tbs') == '1tbs':
            lines = text.split('\n')
            processed_lines = []
            i = 0
            while i < len(lines):
                current_line = lines[i].rstrip()
                next_line = lines[i + 1].rstrip() if i + 1 < len(lines) else None

                # Check if current line ends with keywords that should have 'begin' on same line
                # and next line is a standalone 'begin'
                if next_line and next_line.strip() == 'begin':
                    # Keywords that should be followed by 'begin' on the same line in 1tbs style
                    start_keywords = [
                        r'\bfork\b',
                        r'\brepeat\b',
                        r'\bwhile\b',
                        r'\bdo\b',
                        r'\bforeach\b',
                        r'\balways(?:_(?:ff|comb|latch))?\b',  # Matches: always, always_ff, always_comb, always_latch
                        r'\bif\b',
                        r'\belse\b',
                        r'\belse\s+if\b',
                        r'\bcase\b',
                        r'\bfor\b',
                        r'\bforever\b',
                        r'\btask\b',
                        r'\bfunction\b',
                        r'\binterface\b',
                        r'\bmodule\b',
                        r'\bclass\b',
                        r'\bpackage\b',
                        r'\bprogram\b',
                        r'\bclocking\b',
                        r'\bblock\b',
                        r'\bgenerate\b',
                        r'\bspecify\b',
                        r'\bproperty\b',
                        r'\bsequence\b',
                        r'\bcovergroup\b',
                        r'\binitial\b',
                        r'\bfinal\b'
                    ]

                    # Check if current line matches any of these patterns
                    should_merge = False
                    for pattern in start_keywords:
                        if re.search(pattern, current_line):
                            should_merge = True
                            break

                    # Merge begin to current line if matched keyword pattern
                    if should_merge:
                        processed_lines.append(current_line + ' begin')
                        i += 2  # Skip the 'begin' line
                        continue

                processed_lines.append(lines[i])
                i += 1

            return '\n'.join(processed_lines)

        return text

    def postprocess_text(self, text, options):
        """Postprocess text to remove excessive empty lines"""
        max_empty_lines = options.get('maxConsecutiveEmptyLines', 1)

        # If not set or negative, return as-is
        if max_empty_lines < 0:
            return text

        lines = text.split('\n')
        processed_lines = []
        empty_line_count = 0

        for line in lines:
            # Check if line is empty (only whitespace)
            if line.strip() == '':
                empty_line_count += 1
                # Only add empty line if we haven't reached the limit
                if empty_line_count <= max_empty_lines:
                    processed_lines.append(line)
            else:
                # Non-empty line, reset counter and add the line
                empty_line_count = 0
                processed_lines.append(line)

        return '\n'.join(processed_lines)

    def format_text(self, text, options):
        """Format the given text using VerilogBeautifier"""
        # Preprocess text to merge standalone 'begin' in 1tbs mode
        text = self.preprocess_text(text, options)

        # Always recreate beautifier with current options to respect user configuration
        self.create_beautifier(options)

        try:
            formatted_text = self.beautifier.beautifyText(text)

            # Postprocess to remove excessive empty lines
            formatted_text = self.postprocess_text(formatted_text, options)

            return {
                'success': True,
                'result': formatted_text
            }
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }

    def send_response(self, request_id, result):
        """Send a JSON-RPC response to stdout"""
        response = {
            'jsonrpc': '2.0',
            'id': request_id,
            'result': result
        }
        # Use ensure_ascii=False to preserve Chinese/Unicode characters
        json_str = json.dumps(response, ensure_ascii=False)
        sys.stdout.write(json_str + '\n')
        sys.stdout.flush()

    def send_error(self, request_id, code, message, data=None):
        """Send a JSON-RPC error response to stdout"""
        error = {
            'code': code,
            'message': message
        }
        if data is not None:
            error['data'] = data

        response = {
            'jsonrpc': '2.0',
            'id': request_id,
            'error': error
        }
        json_str = json.dumps(response, ensure_ascii=False)
        sys.stdout.write(json_str + '\n')
        sys.stdout.flush()

    def handle_request(self, request):
        """Handle an incoming JSON-RPC request"""
        try:
            request_id = request.get('id')
            method = request.get('method')
            params = request.get('params', {})

            if method == 'format':
                text = params.get('text', '')
                options = params.get('options', {})

                if not text:
                    self.send_error(request_id, -32602, 'Invalid params: missing text')
                    return

                result = self.format_text(text, options)
                if result['success']:
                    self.send_response(request_id, result)
                else:
                    self.send_error(request_id, -32603, result['error'])

            elif method == 'ping':
                # Health check
                self.send_response(request_id, {'status': 'ok'})

            else:
                self.send_error(request_id, -32601, f'Method not found: {method}')

        except Exception as e:
            self.send_error(request.get('id'), -32603, f'Internal error: {str(e)}')

    def run(self):
        """Main daemon loop - read requests from stdin and process them"""
        # Initialize with default options
        default_options = {
            'nbSpace': 4,
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
        self.create_beautifier(default_options)

        # Send initialization message
        sys.stdout.write('{"jsonrpc":"2.0","method":"initialized","params":{"version":"1.0.0"}}\n')
        sys.stdout.flush()

        # Process requests from stdin
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
                self.handle_request(request)
            except json.JSONDecodeError as e:
                self.send_error(None, -32700, f'Parse error: {str(e)}')
            except Exception as e:
                self.send_error(None, -32603, f'Internal error: {str(e)}')


def main():
    """Main entry point for the daemon"""
    daemon = FormatterDaemon()
    daemon.run()


if __name__ == '__main__':
    main()
