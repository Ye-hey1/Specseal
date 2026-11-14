# 工作指引

> 本仓库是 **Specseal**，fork 自 [Speclink](https://github.com/MomoChenisMe/speclink)（MIT，版权与授权保留在 LICENSE）。改名分阶段进行：品牌与文档已切到 Specseal，二进位、crate、npm、工作区文档夹仍叫 `speclink`，完整计划见 `REBRAND-NOTES.md`。

## 项目惯例

- **Commit 用 `conventional-commit` 技能**：description 与 body 写简体中文。例：`feat(auth): 添加 GitHub OAuth 登录`、`fix(collab): 修正 Y.js 同步冲突`。
- **查数据顺序**：项目内既有规格与代码（搭配对应 Skills）→ `context7` 等已接的 MCP → 最后才网络搜索。不要凭印象猜 API 签名。

## 代码取舍

- 不为一次性使用的代码创建抽象层；不加没被要求的「弹性」或「可配置性」。
- 错误处理只在系统边界验证（用户输入、外部 API），内部代码当成可信；不为不可能发生的情境写防护。
- 写了 200 行但 50 行能搞定就重写。判准：资深工程师会不会觉得这太复杂？
- 死码不对称处理：清掉「因为这次改动」而孤儿化的 imports／变量／函数；原本就存在的死码提一句就好，不要删。
- 有更简单的做法直接说出来，并讲清楚你的假设。

## 表达习惯

- 用「白话」、「白话」、「白话」！很重要！
- 请不要过多的术语，若有术语请附上说明。
