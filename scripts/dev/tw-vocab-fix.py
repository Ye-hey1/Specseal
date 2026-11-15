#!/usr/bin/env python3
"""桌面 i18n 简中用语润色：台湾用语 → 大陆用语（词级替换，测试断言同步保持一致）。
从 stdin 读 git 文件清单。"""
import sys

VOCAB = [
    ("应用进程", "应用"),
    ("范本", "模板"),
    ("回呼", "回调"),
    ("复本", "副本"),
    ("拖曳", "拖拽"),
    ("点按", "点击"),
    ("挡住", "卡住"),
    ("讯息", "消息"),
]

for line in sys.stdin.buffer.read().split(b"\0"):
    if not line:
        continue
    path = line.decode("utf-8", "replace")
    try:
        text = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError):
        continue
    new = text
    for old, modern in VOCAB:
        new = new.replace(old, modern)
    if new != text:
        open(path, "w", encoding="utf-8").write(new)
        print(f"vocab: {path}")
