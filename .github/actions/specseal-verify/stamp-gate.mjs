#!/usr/bin/env node
// Specseal 盖章门禁：PR 触及的每个未归档变更，必须已盖 verify 章（可选要求 review 章）。
// 章的来源与桌面 app / Herdr 面板一致：specseal/changes/<name>/.meta.yaml 的
// verified_at / reviewed_at 字段。归档（目录已移入 changes/archive/）视为通过。
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const base = process.env.SPECSEAL_BASE || "";
const requireReviewed = process.env.SPECSEAL_REQUIRE_REVIEWED === "true";
const explicit = (process.env.SPECSEAL_CHANGES || "").split(/\s+/).filter(Boolean);

function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function touchedChanges() {
  if (explicit.length > 0) return explicit;
  const range = base ? `${base}...HEAD` : "HEAD~1...HEAD";
  let diff = "";
  try {
    diff = sh("git", ["diff", "--name-only", range]);
  } catch {
    // shallow checkout 等场景拿不到 base：退回最近一次提交的 diff
    diff = sh("git", ["diff", "--name-only", "HEAD~1", "HEAD"]);
  }
  const names = new Set();
  for (const line of diff.split("\n")) {
    const m = line.match(/^specseal\/changes\/([^/]+)\//);
    if (m && m[1] !== "archive") names.add(m[1]);
  }
  return [...names];
}

function stampState(name, field) {
  const meta = joinMeta(name);
  if (!meta) return "archived"; // 目录不存在：变更已封存，视为通过
  return new RegExp(`^${field}:`, "m").test(meta) ? "stamped" : "unstamped";
}

function joinMeta(name) {
  const p = `${repoRoot}/specseal/changes/${name}/.meta.yaml`;
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

const changes = touchedChanges();
if (changes.length === 0) {
  console.log("本 PR 未触及 specseal/changes/ 下的变更——无需盖章门禁。");
  process.exit(0);
}

const failures = [];
for (const name of changes) {
  const verify = stampState(name, "verified_at");
  const review = stampState(name, "reviewed_at");
  console.log(`变更 ${name}: verify=${verify} review=${review}`);
  if (verify !== "stamped" && verify !== "archived") {
    failures.push(`变更 '${name}' 尚未盖章（verify）。请先走验证站：specseal verify scope/add-round/stamp。`);
  } else if (requireReviewed && review !== "stamped" && review !== "archived") {
    failures.push(`变更 '${name}' 有 verify 章但缺 review 章（require-reviewed=true）。`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.log(`::error::${f}`);
  process.exit(1);
}
console.log(`盖章门禁通过（${changes.length} 个变更）。`);
