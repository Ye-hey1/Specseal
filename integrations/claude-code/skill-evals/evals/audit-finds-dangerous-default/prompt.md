---
name: audit-finds-dangerous-default
description: 'audit 回报缺省关闭 TLS 验证的危险默认值，不改档（技能 frontmatter 禁用 Edit／Write）。技能错（保留）：旧版本文 Phase 3 写「If fixable: apply the fix directly」，与 frontmatter 矛盾，旧版会尝试 Edit 而被拒。'
tags: [skill:audit]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write, Skill, Agent]
---

/specseal-audit src/http.js
