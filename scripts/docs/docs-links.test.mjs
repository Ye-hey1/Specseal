// 用户文档的链接完整性（user-documentation spec「文档内部链接全部可解析」）。
// 纯函数部分以字符串验证；最后两条扫过版本库实况，让断链与没有文档引用的截屏在 scripts
// 测试面就挡下来（后者对应 spec「用户文档以截屏呈现实际接口」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { brokenIn, docFilesIn, extractTargets, resolveTarget, scanDocs } from './docs-links.mjs';
import { SHOT_DIR, SHOT_LIST, SHOT_LOCALES } from './docs-screenshots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('抽取：markdown 链接与图片都算，行号指向出现的那一行', () => {
  const md = ['# T', '', 'see [guide](docs/guide.md)', '', '![shot](assets/a.png)'].join('\n');
  assert.deepEqual(extractTargets(md), [
    { target: 'docs/guide.md', line: 3 },
    { target: 'assets/a.png', line: 5 },
  ]);
});

test('抽取：HTML 的 src 与 href 也算（README 的品牌图与语言切换就是这种写法）', () => {
  const md = '<img src="docs/assets/brand/logo.png" alt="x" />\n<a href="README.zh-CN.md">繁体中文</a>\n';
  assert.deepEqual(extractTargets(md), [
    { target: 'docs/assets/brand/logo.png', line: 1 },
    { target: 'README.zh-CN.md', line: 2 },
  ]);
});

test('抽取：外部网址、mailto 与纯锚点不在检查范围', () => {
  const md = [
    '[a](https://example.com)',
    '[b](http://example.com)',
    '[c](mailto:x@example.com)',
    '[d](#section)',
    '[e](docs/real.md)',
  ].join('\n');
  assert.deepEqual(extractTargets(md), [{ target: 'docs/real.md', line: 5 }]);
});

test('解析：以该档所在目录为基准，不是以版本库根目录', () => {
  assert.equal(
    resolveTarget({ fromFile: 'docs/workflow.zh-CN.md', target: 'getting-started.zh-CN.md', root: ROOT }),
    path.join(ROOT, 'docs/getting-started.zh-CN.md'),
  );
  assert.equal(
    resolveTarget({ fromFile: 'docs/workflow.zh-CN.md', target: '../README.md', root: ROOT }),
    path.join(ROOT, 'README.md'),
  );
});

test('解析：锚点与 query 先剥掉再看文档存不存在', () => {
  const expected = path.join(ROOT, 'docs/workflow.md');
  assert.equal(resolveTarget({ fromFile: 'README.md', target: 'docs/workflow.md#apply', root: ROOT }), expected);
  assert.equal(resolveTarget({ fromFile: 'README.md', target: 'docs/workflow.md?plain=1', root: ROOT }), expected);
});

test('解析：百分号编码还原成真实文档名', () => {
  assert.equal(
    resolveTarget({ fromFile: 'README.md', target: 'docs/a%20b.md', root: ROOT }),
    path.join(ROOT, 'docs/a b.md'),
  );
});

test('比对：只回报指不到文档的那些，并带上文档名、行号与原始写法', () => {
  const md = ['[ok](good.md)', '[bad](missing.md)'].join('\n');
  const broken = brokenIn({
    file: 'docs/x.md',
    markdown: md,
    root: ROOT,
    exists: (target) => target === path.join(ROOT, 'docs/good.md'),
  });
  assert.equal(broken.length, 1);
  assert.deepEqual(
    { file: broken[0].file, line: broken[0].line, target: broken[0].target },
    { file: 'docs/x.md', line: 2, target: 'missing.md' },
  );
  assert.equal(broken[0].resolved, path.join(ROOT, 'docs/missing.md'));
});

test('比对：全部指得到时回空数组', () => {
  assert.deepEqual(brokenIn({ file: 'docs/x.md', markdown: '[ok](good.md)', root: ROOT, exists: () => true }), []);
});

test('检查面：两份 README 与 docs 下每一份 markdown 都在扫描范围内', () => {
  const files = docFilesIn(ROOT);
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('README.zh-CN.md'));
  assert.ok(files.includes('docs/workflow.zh-CN.md'));
  assert.ok(
    files.filter((f) => f.startsWith('docs/')).length >= 20,
    `docs 下的文档应全数纳入，实得 ${files.filter((f) => f.startsWith('docs/')).length} 份`,
  );
  assert.ok(!files.some((f) => f.includes('node_modules')));
});

test('版本库实况：用户文档没有任何断链', () => {
  const broken = scanDocs(ROOT);
  assert.deepEqual(
    broken.map((b) => `${b.file}:${b.line} → ${b.target}`),
    [],
  );
});

/// 文档的语言看文档名：`.zh-CN.md` 是繁中，其余是英文（docs 与 README 都是这个惯例）。
const docLocale = (file) => (file.endsWith('.zh-CN.md') ? 'zh-CN' : 'en');

test('版本库实况：截屏脚本清单里的每张截屏，在每个语言目录都被同语言的 README 或 docs/ 文档引用', () => {
  const referenced = new Set(
    docFilesIn(ROOT).flatMap((file) =>
      extractTargets(readFileSync(path.join(ROOT, file), 'utf8')).map(
        ({ target }) => `${docLocale(file)}:${resolveTarget({ fromFile: file, target, root: ROOT })}`,
      ),
    ),
  );
  const orphans = SHOT_LOCALES.flatMap((locale) =>
    SHOT_LIST.map((shot) => `${locale}/${shot.file}`).filter(
      (relative) => !referenced.has(`${locale}:${path.join(ROOT, SHOT_DIR, relative)}`),
    ),
  );
  assert.deepEqual(orphans, [], `没有同语言文档引用的截屏：${orphans.join('、')}`);
});
