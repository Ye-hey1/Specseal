// 技能档提示承载规格文件夹迁移（desktop-app spec「技能档提示承载规格文件夹迁移」；
// desktop-spec-dir-migration design D2）：探测回报的迁移状态也会触发提示，略过照旧只记这一版。
import { describe, expect, it } from "vitest";

import type { AssetProbeResult, MigrationProbe } from "../adapter/workspace";
import { assetPrompt } from "../assetPrompt";
import { REMOTE_STALE_PROBE } from "./helpers/assetFixtures";

const PENDING: MigrationProbe = { state: "pending", folder: "openspec", metaFiles: 4 };
const DEFERRED: MigrationProbe = {
  state: "deferred",
  folder: "openspec",
  reason: "otherWorktrees",
  worktrees: ["/work/side"],
};

function probe(over: Partial<AssetProbeResult> = {}): AssetProbeResult {
  return {
    status: "current",
    currentVersion: "v1.3.0",
    tools: [{ tool: "claude", workspaceVersion: "v1.3.0", stale: false, newer: false, missing: false }],
    differingFiles: [],
    migration: { state: "none" },
    ...over,
  };
}

const STALE_TOOLS = [{ tool: "claude", workspaceVersion: "v0.9.0", stale: true, newer: false, missing: false }];

describe("assetPrompt：规格文件夹迁移", () => {
  it("技能档不过期但待迁移：照样出现提示", () => {
    expect(assetPrompt(probe({ migration: PENDING }), "A", {})).toEqual({
      kind: "migrate",
      fileCount: 0,
      version: "v1.3.0",
      projectVersion: "v1.3.0",
      migration: PENDING,
    });
  });

  it("技能档不过期而暂缓：不提示——略过会压掉排除原因后的待迁移提示，那时才提示", () => {
    expect(assetPrompt(probe({ migration: DEFERRED }), "A", {})).toBeNull();
  });

  it("技能档过期且暂缓：维持过期提示并带暂缓原因与 worktree 路径", () => {
    const prompt = assetPrompt(probe({ status: "stale", tools: STALE_TOOLS, migration: DEFERRED }), "A", {});
    expect(prompt?.kind).toBe("stale");
    expect(prompt?.migration).toEqual(DEFERRED);
  });

  it("技能档过期且待迁移：维持过期提示并带迁移内容", () => {
    const prompt = assetPrompt(
      probe({ status: "stale", tools: STALE_TOOLS, differingFiles: ["a", "b"], migration: PENDING }),
      "A",
      {},
    );
    expect(prompt?.kind).toBe("stale");
    expect(prompt?.fileCount).toBe(2);
    expect(prompt?.migration).toEqual(PENDING);
  });

  it("较新态不带迁移：引擎会拒绝这次更新，文件夹不会动", () => {
    const prompt = assetPrompt(
      probe({
        status: "newer",
        tools: [{ tool: "claude", workspaceVersion: "v1.4.0", stale: false, newer: true, missing: false }],
        migration: PENDING,
      }),
      "A",
      {},
    );
    expect(prompt?.kind).toBe("newer");
    expect(prompt?.migration).toEqual({ state: "none" });
  });

  it("没有迁移：现版不提示", () => {
    expect(assetPrompt(probe(), "A", {})).toBeNull();
  });

  it("略过只记这一版：同版不再提示，换版后再出现", () => {
    expect(assetPrompt(probe({ migration: PENDING }), "A", { A: "v1.3.0" })).toBeNull();
    expect(assetPrompt(probe({ migration: PENDING, currentVersion: "v1.4.0" }), "A", { A: "v1.3.0" })?.kind).toBe(
      "migrate",
    );
  });
});

// remote 项目的基准是 Server 提供的技能（desktop-app spec「指令档过期提示」的 remote 情境）。
describe("assetPrompt：remote 项目", () => {
  const KEY = "remote:c1/demo/backend";

  it("和 Server 不同：过期提示带 Server 的版本与这个 app 的版本", () => {
    expect(assetPrompt(REMOTE_STALE_PROBE, KEY, {})).toEqual({
      kind: "stale",
      fileCount: 1,
      version: "v1.58.0",
      projectVersion: "v1.56.0",
      migration: { state: "none" },
      server: { appVersion: "v1.57.0", appOlder: false },
    });
  });

  it("没有任何技能档：缺失提示，项目版本为 null", () => {
    const prompt = assetPrompt(
      {
        ...REMOTE_STALE_PROBE,
        status: "missing",
        tools: [{ tool: "claude", workspaceVersion: null, stale: false, newer: false, missing: true }],
        differingFiles: ["a", "b", "c"],
      },
      KEY,
      {},
    );
    expect(prompt?.kind).toBe("missing");
    expect(prompt?.fileCount).toBe(3);
    expect(prompt?.projectVersion).toBeNull();
  });

  it("app 比 Server 旧：提示带 appOlder", () => {
    const prompt = assetPrompt({ ...REMOTE_STALE_PROBE, appOlderThanServer: true }, KEY, {});
    expect(prompt?.server).toEqual({ appVersion: "v1.57.0", appOlder: true });
  });

  it("略过以项目与 Server 的版本为键：同一版不再提示，Server 换版后再出现；app 升版不影响", () => {
    expect(assetPrompt(REMOTE_STALE_PROBE, KEY, { [KEY]: "v1.58.0" })).toBeNull();
    expect(assetPrompt({ ...REMOTE_STALE_PROBE, serverVersion: "v1.59.0" }, KEY, { [KEY]: "v1.58.0" })?.kind).toBe(
      "stale",
    );
    // 以 app 的版号记下的略过（本机项目的键）压不掉 remote 的提示。
    expect(assetPrompt(REMOTE_STALE_PROBE, KEY, { [KEY]: "v1.57.0" })?.kind).toBe("stale");
    expect(assetPrompt({ ...REMOTE_STALE_PROBE, currentVersion: "v1.60.0" }, KEY, { [KEY]: "v1.58.0" })).toBeNull();
  });

  it("和 Server 相同、或无法判定：不提示", () => {
    expect(assetPrompt({ ...REMOTE_STALE_PROBE, status: "current", differingFiles: [] }, KEY, {})).toBeNull();
    expect(assetPrompt({ ...REMOTE_STALE_PROBE, status: "unknown", tools: [], differingFiles: [] }, KEY, {})).toBeNull();
  });

  it("本机项目的提示不带 server", () => {
    const local = assetPrompt(probe({ status: "stale", tools: STALE_TOOLS }), "A", {});
    expect(local && "server" in local).toBe(false);
  });
});
