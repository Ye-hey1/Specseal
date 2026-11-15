#!/usr/bin/env node
// Claude Code 和 Codex 的 hook：看送出的消息、模型叫用的技能和跑的 specseal 指令，帮这个终端机贴标签，
// 面板才知道它在做哪个变更或讨论。规则在 model.js 的 hookLabels。
// 设置方式见 integrations/herdr/README.md。不在 Herdr 里或贴不上时什么都不做。
// 不可以输出任何东西：hook 的输出会变成对话内容。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hookLabels } from "./model.js";

const terminal = process.env.HC_TERMINAL_ID;
if (terminal) {
  try {
    const labels = hookLabels(JSON.parse(readFileSync(0, "utf8")));
    if (labels) execFileSync("hc", ["label", terminal, ...labels], { stdio: "ignore", timeout: 3000 });
  } catch {
    // 贴不上标签不能挡住用户送出消息。
  }
}
