#!/usr/bin/env node
// 用户文档的链接完整性检查（user-documentation spec「文档内部链接全部可解析」）。
// 扫出两份 README 与 docs/ 下每一份 markdown 的相对链接与图片路径，逐一确认文档
// 存在；任一断链即以非零结束并点名该路径。
//
// 用法：node scripts/docs/docs-links.mjs
// 也由 scripts/docs/docs-links.test.mjs 带进 scripts 测试面，改文档时就会挡下来。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/// 检查面：入口的两份 README，加上 docs/ 底下全部 markdown。
const README_FILES = ['README.md', 'README.zh-CN.md'];
const DOCS_DIR = 'docs';

/// markdown 的 [text](target) 与 ![alt](target)。
const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)\s]+)/g;
/// README 的品牌图与语言切换写成 HTML，同样要检查。
const HTML_ATTR = /(?:src|href)="([^"]+)"/g;
/// 不在检查范围：外部网址、mailto、以及只指向本档章节的锚点。
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/// 逐行抽取本地目标，附上行号——报断链时要能直接跳到出事的那一行。
export function extractTargets(markdown) {
  const found = [];
  markdown.split('\n').forEach((text, index) => {
    for (const pattern of [MARKDOWN_LINK, HTML_ATTR]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const target = match[1];
        if (!EXTERNAL.test(target)) found.push({ target, line: index + 1 });
      }
    }
  });
  return found;
}

/// 相对路径以「该档所在目录」为基准；锚点与 query 不是文档名的一部分，先剥掉。
/// 空格等字符在 markdown 里以百分号编码出现，比对文档前要还原。
export function resolveTarget({ fromFile, target, root }) {
  const bare = target.split('#')[0].split('?')[0];
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // 不是合法的百分号编码就照字面看待——那本来就是文档名的一部分。
  }
  return path.resolve(root, path.dirname(fromFile), decoded);
}

export function brokenIn({ file, markdown, root, exists = existsSync }) {
  return extractTargets(markdown)
    .map(({ target, line }) => ({ file, line, target, resolved: resolveTarget({ fromFile: file, target, root }) }))
    .filter((entry) => !exists(entry.resolved));
}

/// 检查面清单，路径相对版本库根目录。
export function docFilesIn(root) {
  const docs = readdirSync(path.join(root, DOCS_DIR), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name)))
    .map((relative) => relative.split(path.sep).join('/'))
    .sort();
  return [...README_FILES, ...docs];
}

export function scanDocs(root) {
  return docFilesIn(root).flatMap((file) =>
    brokenIn({ file, markdown: readFileSync(path.join(root, file), 'utf8'), root }),
  );
}

function main() {
  const broken = scanDocs(ROOT);
  const files = docFilesIn(ROOT);

  if (broken.length === 0) {
    console.log(`✓ ${files.length} 份用户文档的相对链接与图片路径全部指得到文档。`);
    return;
  }

  console.error(`✗ ${broken.length} 条断链：`);
  for (const entry of broken) {
    console.error(`  ${entry.file}:${entry.line} → ${entry.target}`);
    console.error(`      指向不存在的 ${path.relative(ROOT, entry.resolved)}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
