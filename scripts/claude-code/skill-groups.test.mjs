// Claude Code mod 技能分页表的同步守门（integrations/claude-code/specseal-skills）。
// mod 的分页表写死在 hooks/groups.ts；表上没有的技能虽然会落到「其他」不会消失，
// 但新技能该放哪一页要有人决定。这里拿表对照 repo 里 `specseal update` 写出的
// `.claude/skills/specseal-*`：新技能没进表、或表上留着已移除的名字，都在这里红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GROUPS_FILE = 'integrations/claude-code/specseal-skills/hooks/groups.ts';

/// groups.ts 的 `skills: [...]` 数组里的短名；合并钮 `a+b` 拆成各自的技能。
function tabledSkills(source) {
  const names = [...source.matchAll(/skills:\s*\[([^\]]*)\]/g)].flatMap((block) =>
    [...block[1].matchAll(/'([^']+)'/g)].map((name) => name[1]),
  );
  return new Set(names.flatMap((name) => name.split('+')));
}

const tabled = tabledSkills(readFileSync(path.join(ROOT, GROUPS_FILE), 'utf8'));
const written = readdirSync(path.join(ROOT, '.claude/skills'))
  .filter((name) => name.startsWith('specseal-'))
  .map((name) => name.slice('specseal-'.length))
  .sort();

test('解析：读得到分页表，合并钮拆成各自的技能', () => {
  const sample = "{ id: 'ship', skills: ['archive', 'archive+commit'] },\n{ id: 'x', skills: [\n 'trace',\n] }";
  assert.deepEqual([...tabledSkills(sample)].sort(), ['archive', 'commit', 'trace']);
  assert.ok(tabled.size > 0, `${GROUPS_FILE} 解析不到任何技能`);
});

test('specseal update 写出的每个技能都在 mod 的分页表上', () => {
  const missing = written.filter((name) => !tabled.has(name));
  assert.deepEqual(missing, [], `请把这些技能放进 ${GROUPS_FILE} 的某个分页：${missing.join(', ')}`);
});

test('mod 的分页表没有已不存在的技能', () => {
  const stale = [...tabled].filter((name) => !written.includes(name)).sort();
  assert.deepEqual(stale, [], `${GROUPS_FILE} 里这些技能已不存在：${stale.join(', ')}`);
});
