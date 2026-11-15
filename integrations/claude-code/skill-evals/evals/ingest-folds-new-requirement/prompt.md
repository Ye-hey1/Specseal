---
name: ingest-folds-new-requirement
description: ingest 把新需求并进进行中 change 的规格 delta，并跑 validate。
tags: [skill:ingest]
max_turns: 50
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-ingest add-greeting 新需求：greeting.txt 第二行要加上中文问候「你好」
