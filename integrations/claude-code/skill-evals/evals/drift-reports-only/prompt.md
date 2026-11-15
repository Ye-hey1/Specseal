---
name: drift-reports-only
description: drift 只回报 change 与代码的偏移（指出 src/old.js 已不存在），不改任何文件。
tags: [skill:drift]
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-drift add-greeting
