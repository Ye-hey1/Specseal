// 技能分页表，依工作流程排序。表上没有的技能一律落到 `other`，不会消失；
// `a+b` 是一颗合并钮，填入 `/specseal-a + /specseal-b`。
//
// scripts/claude-code/skill-groups.test.mjs 拿这张表对照 repo 里 `specseal update`
// 写出的技能：新技能要明确放进某个分页，改名或移除的技能不得留在表上。
export type GroupId = 'plan' | 'build' | 'quality' | 'ship' | 'other'

export const GROUPS: { id: GroupId; skills: string[] }[] = [
  { id: 'plan', skills: ['discuss', 'improve', 'propose', 'ingest'] },
  { id: 'build', skills: ['apply', 'apply-with-worktree'] },
  { id: 'quality', skills: ['quality', 'review', 'verify'] },
  { id: 'ship', skills: ['archive', 'archive+commit', 'worktree-merge'] },
  {
    id: 'other',
    skills: ['commit', 'analyze', 'drift', 'audit', 'trace', 'manual', 'baseline', 'config'],
  },
]
