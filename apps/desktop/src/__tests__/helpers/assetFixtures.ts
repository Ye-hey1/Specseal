// 技能档探测的共用 fixture（desktop-app spec「指令档过期提示」）：store 面
// （store.test.ts）与 App 面（App.test.tsx）测试共用同一份过期探测回报。
import type { AssetProbeResult } from "../../adapter/workspace";

/** 过期探测：claude 工具的受管档落后引擎，两个文件内容有异。 */
export const STALE_PROBE: AssetProbeResult = {
  status: "stale",
  currentVersion: "v1.3.0",
  tools: [{ tool: "claude", workspaceVersion: "v0.9.0", stale: true, newer: false, missing: false }],
  differingFiles: ["CLAUDE.md", ".claude/skills/specseal-apply/SKILL.md"],
  migration: { state: "none" },
};

/** remote 项目的过期探测：基准是 Server 提供的技能（v1.58.0），一个技能档和它不同；
 * 这个 app 内置的技能版号是 v1.57.0。 */
export const REMOTE_STALE_PROBE: AssetProbeResult = {
  status: "stale",
  currentVersion: "v1.57.0",
  tools: [{ tool: "claude", workspaceVersion: "v1.56.0", stale: true, newer: false, missing: false }],
  differingFiles: [".claude/skills/specseal-apply/SKILL.md"],
  migration: { state: "none" },
  serverVersion: "v1.58.0",
  appOlderThanServer: false,
};

/** 有 checkout 的 remote 分页要探测的对象（对应 remoteFixtures 的 REMOTE_KEY）。 */
export const REMOTE_CHECKOUT = { connectionId: "c1", project: "demo", repo: "backend", checkout: "/work/demo" };
