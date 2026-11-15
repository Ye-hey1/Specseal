# Specseal 与主流项目对比

对比依据是各项目 2026-11-14 的上游 README。星标数每天在变；下面的结构性差异不会。

## 一句话版本

- **Specseal**：规格驱动开发，变更要拿到「盖了章、机器可读的证据票据」才算做完。团队层通过公开协议内建。
- **[GitHub spec-kit](https://github.com/github/spec-kit)**：官方工具包。流程面广（SDD、bug 修复、idea 评估），外加庞大的 extension/preset/catalog 平台。纯单仓；agent 模板逐工具各一套。
- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)**：最精简的环路——proposal、apply、archive——用一份指令集覆盖 30+ 工具。验证是扩展 profile，不是封章票据。团队共享是没有服务器的 beta git-store。
- **[BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)**：多角色方法论（分析→PM→架构→开发→QA），先产出规划文档再写码。适合绿地规划的强结构；没有机器校验的规格符合性。
- **[claude-task-master](https://github.com/eyaltoledano/claude-task-master)**：任务执行器——PRD 拆成依赖排序的任务，带 MCP server。有任务、没有规格层。
- **[Kiro](https://kiro.dev)**（AWS，闭源）：规格驱动的 IDE，EARS 格式需求 + steering 文档。强，但锁 IDE、锁模型。

## 对比矩阵

| | Specseal | spec-kit | OpenSpec | BMAD | task-master |
|---|---|---|---|---|---|
| 规格优先工作流 | ✅ | ✅ | ✅ | ✅ | ❌（任务） |
| 记录在案的验证证据 | ✅ 范围 + 轮次 + 盖章 | ⚠️ 收敛报告 | ⚠️ verify profile | ❌ | ❌ |
| 有 must-fix 未清就不许盖章 | ✅ 引擎强制 | ❌ | ❌ | ❌ | ❌ |
| 仓库内置 CI 门禁模板 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 团队 Store（认证/版本/交易/事件） | ✅ 服务器 + 公开协议 | ❌ | ⚠️ beta git-store | ❌ | ❌ |
| PM/PO 参与面 | ✅ 讨论 + 桌面看板 | ❌ | ❌ | ⚠️ 文档角色 | ❌ |
| 项目原则层 | ✅ 文档化约定 | ✅ constitution | ❌ | ⚠️ 角色隐含 | ❌ |
| 桌面应用 | ✅ | ❌ | ⚡ 看板 | ❌ | ❌ |
| MCP server | ✅ 已交付（13 工具） | ❌ | ❌ | ❌ | ✅ |
| 逐工具生成技能 | ✅ 5 个工具 | ✅ 多集成 | ✅ 30+ 工具 | ✅ 多 IDE | ⚠️ 编辑器 |
| 通用指令（任意 agent） | ✅ 文档随仓提供 | ❌ | ✅ 单一指令集 | ❌ | ❌ |
| 运行时占用 | Rust 二进制 | Python + uv | Node CLI | markdown + agent | Node + MCP |

## 什幺时候选谁

- **你要的是证明，不是感觉——或者需要团队层。** 选 Specseal。verify 票据与盖章是差异所在；CI 可以拒绝未盖章的变更。Remote 模式让 PM、PO 与工程师、agent 走同一个工作流。
- **你要最宽的流程平台，且有 GitHub 背书。** 选 spec-kit。它的 extension/preset/catalog 机制远超这里的一切——成熟度是它的护城河，也是它的重量。
- **你要今天就能用的最小环路、且不挑工具。** 选 OpenSpec。如果封章证据链和服务器对你来说是仪式感，它就是合适的尺寸。
- **你在规划带角色分工的大型绿地项目。** 选 BMAD。
- **你已经有规格/PRD，缺的是任务执行。** 选 task-master，也可以与上面任意一家并用。

## Specseal 刻意不抄的东西

- spec-kit 的 extension/preset/workflow/bundle/catalog 平台——那套机制在 spec-kit 的体量下才配得上它的复杂度，不在年轻 fork 的体量下。
- BMAD 的角色仪式感——与「站点可选、按风险裁剪」直接冲突。
- task-master 的任务优先模型——这里任务是规格的下游，永远不会成为第一对象。
- Kiro 的 IDE 锁定——反向下注：一套引擎，任意 agent，行为一致。
