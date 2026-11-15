---
name: verify-freezes-scope
description: verify 冻结范围后回报规格不符与选项并停下，有必修发现时不盖章。
tags: [skill:verify]
max_turns: 60
timeout_seconds: 1500
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-verify add-greeting
