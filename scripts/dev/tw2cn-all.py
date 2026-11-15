#!/usr/bin/env python3
"""从 stdin 读 git 文件清单，繁中→简中（tw2sp 词汇级），容错逐文件。
跳过已被简中的文件（内容无变化不写回）。"""
import sys

sys.path.insert(0, "/tmp/opencc-lib")
from opencc import OpenCC

cc = OpenCC("tw2sp")

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
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        continue
    new = cc.convert(text)
    if new != text:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(new)
        print(f"tw2sp: {path}")
