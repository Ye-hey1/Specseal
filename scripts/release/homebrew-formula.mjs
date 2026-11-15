// 由 CLI npm 发布产出的 tgz 校验清单产生 Homebrew formula（cli-distribution spec
// 「Homebrew formula 产生器」，design D4／release-assets-trim D5：binary 的唯一来源是
// npm，formula 的 url 指向 registry.npmjs.org 的平台子套件 tgz——homebrew-core 对
// Node CLI 的既有写法）。
//
// 用法：node scripts/release/homebrew-formula.mjs --tag v0.5.0 --sums cli-npm-sums.txt
//
// --sums 是 cli-npm-publish job 在发布并等 registry 可见后，对自 registry 取回的 tgz
// （formula 指向的同一个 tarball 网址，拿到的是 registry 原 bytes）跑 sha256sum 的输出（digest、
// 两空白、文件名），所以 sha256 对 registry 上的档成立——重跑时已上架的同版被跳过也一样。
// 输出到 stdout，贴进 tap repo 的 Formula/specseal.rb 即可。四组平台资产
// 缺任一即以非零结束——checksum 每版都变，手抄或漏抄要到用户 brew install 失败
// 才会发现，因此宁可不产出也不产出半套。
import { readFileSync } from 'node:fs';

const REPO = 'MomoChenisMe/speclink';
const SCOPE = '@specseal';
const BIN = 'specseal';

// brew 只用得到这四个；win32 子套件不在 formula 范围。
const TARGETS = [
  { key: 'macosArm', platform: 'darwin-arm64' },
  { key: 'macosIntel', platform: 'darwin-x64' },
  { key: 'linuxArm', platform: 'linux-arm64' },
  { key: 'linuxIntel', platform: 'linux-x64' },
];

/// npm pack 的产物名：@specseal/cli-darwin-arm64@0.5.0 → specseal-cli-darwin-arm64-0.5.0.tgz。
const packName = (platform, version) => `${SCOPE.slice(1)}-cli-${platform}-${version}.tgz`;
/// registry 上该 tgz 的下载网址（registry 的文件名不带 scope）。
const registryUrl = (platform, version) =>
  `https://registry.npmjs.org/${SCOPE}/cli-${platform}/-/cli-${platform}-${version}.tgz`;

function fail(message) {
  console.error(`homebrew-formula: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!/^--(tag|sums)$/.test(flag) || value === undefined) {
      fail(`无法解析的参数：${flag}——用法：--tag <v0.5.0> --sums <cli-npm-sums.txt>`);
    }
    args[flag.slice(2)] = value;
  }
  for (const required of ['tag', 'sums']) {
    if (!args[required]) fail(`缺少必要参数 --${required}`);
  }
  return args;
}

const { tag, sums } = parseArgs(process.argv.slice(2));

let sumsText;
try {
  sumsText = readFileSync(sums, 'utf8');
} catch {
  fail(`读不到校验清单：${sums}`);
}

const version = tag.replace(/^v/, '');

/// 校验清单的每一行是「digest<空白>文件名」。以完整文件名（含版本）比对：版本不符的
/// 清单等同缺条目，不会把上一版的 sha256 套到这一版。
const digests = new Map();
for (const line of sumsText.split('\n')) {
  const match = line.trim().match(/^([0-9a-fA-F]{64})\s+(\S+)$/);
  if (match) digests.set(match[2], match[1].toLowerCase());
}

const assets = [];
const missing = [];
for (const { key, platform } of TARGETS) {
  const digest = digests.get(packName(platform, version));
  if (!digest) {
    missing.push(platform);
    continue;
  }
  assets.push({ key, platform, digest, url: registryUrl(platform, version) });
}

if (missing.length > 0) {
  fail(
    `校验清单缺少下列平台的 ${BIN} tgz 条目：${missing.join('、')}` +
      `——确认 tag（${tag}）与 cli-npm-publish 产出的清单同版后重试`,
  );
}

const byKey = Object.fromEntries(assets.map((a) => [a.key, a]));

process.stdout.write(`# 由 scripts/release/homebrew-formula.mjs 产生，请勿手改；改版时重新产生。
class Specseal < Formula
  desc "Spec-Driven Development engine and toolkit"
  homepage "https://github.com/${REPO}"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${byKey.macosArm.url}"
      sha256 "${byKey.macosArm.digest}"
    else
      url "${byKey.macosIntel.url}"
      sha256 "${byKey.macosIntel.digest}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${byKey.linuxArm.url}"
      sha256 "${byKey.linuxArm.digest}"
    else
      url "${byKey.linuxIntel.url}"
      sha256 "${byKey.linuxIntel.digest}"
    end
  end

  def install
    bin.install "${BIN}"
  end

  test do
    assert_match "${version}", shell_output("#{bin}/${BIN} --version")
  end
end
`);
