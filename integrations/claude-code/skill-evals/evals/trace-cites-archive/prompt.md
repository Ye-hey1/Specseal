---
name: trace-cites-archive
description: trace 说出 greeting 规格的来源 change，不改任何文件。
tags: [skill:trace]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-trace greeting 这个能力是怎么来的？
