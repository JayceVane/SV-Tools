#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Convert SVG to PNG using Pillow and svglib"""
import sys
import os

# Set UTF-8 encoding for Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

try:
    from svglib.svglib import svg2rlg
    from reportlab.graphics import renderPM

    # Load SVG
    print("Loading icon.svg...")
    drawing = svg2rlg("icon.svg")

    # Convert to PNG
    print("Converting to PNG (256x256)...")
    renderPM.drawToFile(drawing, "icon.png", fmt="PNG", dpi=96)

    file_size = os.path.getsize("icon.png")
    print(f"[OK] Icon created: icon.png (256x256, {file_size} bytes)")

except ImportError as e:
    print(f"Error: {e}")
    print("\nPlease install required packages:")
    print("  pip install svglib reportlab")
    print("\nOr use online tool:")
    print("  https://cloudconvert.com/svg-to-png")
except Exception as e:
    print(f"Error: {e}")
