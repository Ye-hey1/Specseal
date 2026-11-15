import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { NO_BUILT_CLI, builtCli } from './built-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const zhPath = path.join(root, 'docs/remote-getting-started.zh-CN.md');
const enPath = path.join(root, 'docs/remote-getting-started.md');

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

/// H2 行首带 `<a id="..."></a>`：两语言标题文本不同，靠 id 对齐章节。
const ANCHOR = /^<a id="([^"]+)"><\/a>/;

function h2s(markdown) {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
}

function h2Anchors(markdown) {
  return h2s(markdown).map((heading) => ANCHOR.exec(heading)?.[1] ?? `（缺锚点）${heading}`);
}

function localMarkdownLinks(markdown) {
  return [...markdown.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ''))
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target));
}

function literal(text) {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/// 取出锚点为 id 的 h2 章节内文，让断言绑在该章节而不是整份文档。
function section(markdown, id, relativePath) {
  const body = markdown
    .split(/^## /m)
    .slice(1)
    .find((chunk) => ANCHOR.exec(chunk)?.[1] === id);
  assert.ok(body, `${relativePath}: 找不到锚点为「${id}」的章节`);
  return body;
}

const remoteGuides = [
  'docs/remote-getting-started.zh-CN.md',
  'docs/remote-getting-started.md',
];

test('remote getting-started guides exist with matching section order', () => {
  assert.equal(existsSync(zhPath), true, 'missing Traditional Chinese remote guide');
  assert.equal(existsSync(enPath), true, 'missing English remote guide');

  const zh = read('docs/remote-getting-started.zh-CN.md');
  const en = read('docs/remote-getting-started.md');
  assert.deepEqual(h2Anchors(zh), h2Anchors(en));
});

test('development guides exist with matching section order', () => {
  const zh = read('docs/development.zh-CN.md');
  const en = read('docs/development.md');
  assert.deepEqual(h2Anchors(zh), h2Anchors(en));

  // 五个一键入口各有一节（规格「开发者入口文档双语对」）。
  for (const entry of [
    'npm run dev`',
    'npm run dev:server`',
    'npm run dev:desktop`',
    'npm run dev:reset`',
    'npm run cli -- <args>`',
  ]) {
    assert.equal(
      h2s(zh).some((heading) => heading.includes(entry)),
      true,
      `development 文档缺少 ${entry} 章节`,
    );
  }
});

test('both guides cover the remote setup, authorization, and recovery contract', () => {
  for (const relativePath of remoteGuides) {
    const guide = read(relativePath);
    for (const required of [
      '/account',
      'POST `/api/specseal/v1/web/account/tokens`',
      '/admin/users',
      '403',
      'permission_denied',
      'membership',
      'project-scoped URL',
      'spec-only',
      'checkout',
      'offline',
      'npm run dev:reset',
    ]) {
      assert.match(guide, literal(required));
    }
  }
});

test('existing user entry points link to the matching remote guide', () => {
  assert.match(read('README.zh-CN.md'), /docs\/remote-getting-started\.zh-CN\.md/);
  assert.match(read('README.md'), /docs\/remote-getting-started\.md/);
  assert.match(read('docs/product-status.zh-CN.md'), /remote-getting-started\.zh-CN\.md/);
  assert.match(read('docs/product-status.md'), /remote-getting-started\.md/);
  assert.match(read('docs/server-deployment.zh-CN.md'), /remote-getting-started\.zh-CN\.md/);
});

test('documented browser routes reflect the SPA + browser-API surface', () => {
  const routes = read('crates/host/specseal-server/src/app.rs');
  // After the SPA migration the server-rendered /account and /admin/users HTML
  // pages are gone; every browser route is served by the SPA shell fallback.
  assert.match(routes, /\.fallback\(assets::spa_fallback\)/);
  assert.doesNotMatch(routes, /web::account_page/);
  assert.doesNotMatch(routes, /admin::users_page/);
  // PAT creation is a same-origin browser-API POST, never a browsable GET page.
  const webApi = read('crates/host/specseal-server/src/web.rs');
  assert.match(webApi, /\.route\("\/account\/tokens", post\(api_create_pat\)\)/);

  for (const relativePath of remoteGuides) {
    const guide = read(relativePath);
    // The guides create a PAT through the account SPA page's browser API.
    assert.match(guide, /\/api\/specseal\/v1\/web\/account\/tokens/);
    assert.equal(
      localMarkdownLinks(guide).some((target) => target.endsWith('/account/tokens')),
      false,
      `${relativePath} must not link to the POST-only action as a browser page`,
    );
  }
});

// checkout 内的开发入口（先建 CLI、wrapper 核对）属开发环境文档；Remote 入门只连过去。
const devGuides = ['docs/development.zh-CN.md', 'docs/development.md'];

test('development guides tie the dev startup step to the checkout CLI build', () => {
  for (const relativePath of devGuides) {
    assert.match(section(read(relativePath), 'dev', relativePath), literal('specseal-cli'));
  }
});

test('development guides verify the CLI through the checkout wrapper', () => {
  for (const relativePath of devGuides) {
    const guide = read(relativePath);
    for (const required of ['npm run cli -- ', 'npm run --silent cli -- ', 'npm --prefix ']) {
      assert.match(guide, literal(required), `${relativePath}: 缺少 ${required}`);
    }
  }
});

test('no guide teaches the absolute path of the checkout binary', () => {
  for (const relativePath of [...remoteGuides, ...devGuides]) {
    assert.doesNotMatch(
      read(relativePath),
      /path\/to\/specseal\/target\/debug\/specseal/,
      `${relativePath}: 不应再教用户手打 binary 绝对路径`,
    );
  }
});

test('both guides troubleshoot a stale specseal on PATH', () => {
  for (const relativePath of remoteGuides) {
    const troubleshooting = section(read(relativePath), 'troubleshooting', relativePath);
    assert.match(troubleshooting, literal('PATH'));
    assert.match(troubleshooting, literal('npm run cli'));
  }
});

const cli = builtCli();

test(
  'documented CLI commands are present in the current help surface',
  { skip: !cli && NO_BUILT_CLI },
  () => {
    // clap 的 Usage 行用的是运行文档名——Windows 上是 specseal.exe，故进程名后
    // 容许 .exe 尾码；文档教的指令写法不受影响。
    const cases = [
      [[], /Commands:[\s\S]*\blink\b[\s\S]*\bauth\b/],
      [['link', '--help'], /Usage: specseal(?:\.exe)? link \[OPTIONS\] <URL>[\s\S]*--repo <REPO>/],
      [['auth', 'login', '--help'], /Usage: specseal(?:\.exe)? auth login \[OPTIONS\][\s\S]*--token-stdin/],
    ];

    for (const [args, expected] of cases) {
      const result = spawnSync(cli, args.length === 0 ? ['--help'] : args, {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, expected);
    }
  },
);

test('relative Markdown links in the changed documentation resolve', () => {
  const documents = [
    'README.md',
    'README.zh-CN.md',
    'docs/remote-getting-started.zh-CN.md',
    'docs/remote-getting-started.md',
    'docs/product-status.zh-CN.md',
    'docs/product-status.md',
    'docs/server-deployment.zh-CN.md',
    'docs/development.zh-CN.md',
    'docs/development.md',
  ];

  for (const relativePath of documents) {
    const markdown = read(relativePath);
    for (const target of localMarkdownLinks(markdown)) {
      const withoutFragment = target.split('#', 1)[0];
      if (withoutFragment === '') continue;
      const resolved = path.resolve(root, path.dirname(relativePath), withoutFragment);
      assert.equal(existsSync(resolved), true, `${relativePath}: broken link ${target}`);
    }
  }
});
