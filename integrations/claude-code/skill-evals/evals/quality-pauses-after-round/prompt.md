---
name: quality-pauses-after-round
description: 'quality 跑完两站后把发现一起回报并停下，不盖章。技能错（保留）：旧版在 Haiku 上跑完 review 站就结束这一轮（说「Verify runs next」却没跑 verify），没有两站一起回报。'
tags: [skill:quality]
max_turns: 100
timeout_seconds: 2400
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-quality add-greeting
