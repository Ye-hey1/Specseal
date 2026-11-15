---
name: commit-gate-shows-plan
description: commit 先呈现只含本 change 文件的计划与消息、请用户确认，确认前不 commit。
tags: [skill:commit]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-commit add-greeting
