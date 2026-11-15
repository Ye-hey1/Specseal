---
name: propose-from-discussion
description: propose 从讨论创建 change；人工验收任务的 [M] 标记紧贴 checkbox、跑 validate、不自动接着 apply。
tags: [skill:propose]
max_turns: 80
timeout_seconds: 1800
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-propose --from-discussion search-bar（直接使用这份讨论，change 名称用 add-search-bar）
