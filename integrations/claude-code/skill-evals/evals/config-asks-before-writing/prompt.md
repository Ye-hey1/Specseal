---
name: config-asks-before-writing
description: config 一次只问一个政策字段，或先呈现待核准的 diff；核准前不写入 workflow config。
tags: [skill:config]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-config
