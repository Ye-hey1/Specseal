#!/usr/bin/env python3
"""从 stdin 读文件清单，逐文件替换 speclink/Speclink/SPECLINK → specseal/Specseal/SPECSEAL。
二进制或非 UTF-8 文件用 latin-1 字节级处理（ASCII 模式安全）。容错逐文件，不中断。"""
import sys

for line in sys.stdin.buffer.read().split(b"\0"):
    if not line:
        continue
    path = line.decode("utf-8", "replace")
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError as err:
        print(f"SKIP {path}: {err}", file=sys.stderr)
        continue
    if b"speclink" not in data and b"Speclink" not in data and b"SPECLINK" not in data:
        continue
    new = data.replace(b"speclink", b"specseal").replace(b"Speclink", b"Specseal").replace(b"SPECLINK", b"SPECSEAL")
    with open(path, "wb") as handle:
        handle.write(new)
    print(f"renamed: {path}")
