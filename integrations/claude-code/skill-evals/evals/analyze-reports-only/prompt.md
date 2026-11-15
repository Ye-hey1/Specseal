---
name: analyze-reports-only
description: analyze 只回报跨 artifact 的检查发现，不改任何文件。
tags: [skill:analyze]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-analyze demo-change
