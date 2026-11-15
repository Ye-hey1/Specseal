// 更新日志弹窗的纯判定（desktop-app spec「更新日志弹窗」Example「弹出判定」）与已看过记录
// 的本机持久化：不依赖 Tauri，Storage 可注入（比照 assetPrompt.ts）。
import { describe, it, expect, beforeEach } from "vitest";

import {
  readLastSeenVersion,
  whatsNewDecision,
  writeLastSeenVersion,
} from "../core/whatsNew";
import type { ReleaseNotesEntry } from "../release-notes/release-notes";

const entry = (version: string): ReleaseNotesEntry => ({
  version,
  date: "2026-09-10",
  sections: [{ kind: "features", items: [{ en: `${version} notes`, "zh-CN": `${version} 的内容` }] }],
});
const ENTRIES = [entry("0.3.1"), entry("0.3.0"), entry("0.2.0")];
const versions = (decision: ReturnType<typeof whatsNewDecision>) =>
  decision.kind === "show" ? decision.entries.map((e) => e.version) : decision.kind;

describe("whatsNewDecision", () => {
  it("dev 建置永不自动弹、也不写记录", () => {
    expect(
      whatsNewDecision({ appVersion: "0.3.0", entries: ENTRIES.slice(1), lastSeen: "0.2.0", dev: true }),
    ).toEqual({ kind: "none" });
  });

  it("JSON 顶端版号不等于 app 版号时不弹（建置链版号不齐）", () => {
    expect(
      whatsNewDecision({ appVersion: "0.3.0", entries: [entry("0.2.0")], lastSeen: "0.2.0", dev: false }),
    ).toEqual({ kind: "none" });
    expect(whatsNewDecision({ appVersion: "0.3.0", entries: [], lastSeen: null, dev: false })).toEqual({
      kind: "none",
    });
  });

  it("无已看过记录（首次安装）→ record：不弹、记现版号", () => {
    expect(
      whatsNewDecision({ appVersion: "0.3.0", entries: ENTRIES.slice(1), lastSeen: null, dev: false }),
    ).toEqual({ kind: "record" });
  });

  it("已看过记录等于 app 版号 → none", () => {
    expect(
      whatsNewDecision({ appVersion: "0.3.0", entries: ENTRIES.slice(1), lastSeen: "0.3.0", dev: false }),
    ).toEqual({ kind: "none" });
  });

  it("由 0.2.0 更新到 0.3.0 → show 只含 0.3.0", () => {
    expect(
      versions(
        whatsNewDecision({ appVersion: "0.3.0", entries: ENTRIES.slice(1), lastSeen: "0.2.0", dev: false }),
      ),
    ).toEqual(["0.3.0"]);
  });

  it("跳版：已看过 0.2.0、清单 0.3.1／0.3.0／0.2.0 → show 依序含 0.3.1 与 0.3.0", () => {
    expect(
      versions(whatsNewDecision({ appVersion: "0.3.1", entries: ENTRIES, lastSeen: "0.2.0", dev: false })),
    ).toEqual(["0.3.1", "0.3.0"]);
  });

  it("降版：已看过记录比 app 版号新且不在清单内 → none（不把看过的内容再弹一次）", () => {
    expect(
      whatsNewDecision({ appVersion: "0.3.1", entries: ENTRIES, lastSeen: "0.4.0", dev: false }),
    ).toEqual({ kind: "none" });
  });

  it("已看过记录不在清单内 → show 只含顶端一笔", () => {
    expect(
      versions(whatsNewDecision({ appVersion: "0.3.1", entries: ENTRIES, lastSeen: "0.1.9", dev: false })),
    ).toEqual(["0.3.1"]);
  });
});

describe("已看过记录的本机持久化", () => {
  const KEY = "specseal.lastSeenVersion";
  beforeEach(() => localStorage.clear());

  it("writeLastSeenVersion 写入键 specseal.lastSeenVersion，readLastSeenVersion 读回", () => {
    writeLastSeenVersion("0.3.0");
    expect(localStorage.getItem(KEY)).toBe("0.3.0");
    expect(readLastSeenVersion()).toBe("0.3.0");
  });

  it("无记录回 null", () => {
    expect(readLastSeenVersion()).toBeNull();
  });

  it("坏值（非版号字符串、JSON 对象、数字）一律视为无记录", () => {
    for (const bad of ['{"version":"0.3.0"}', "123", '"0.3.0"', "", "abc"]) {
      localStorage.setItem(KEY, bad);
      expect(readLastSeenVersion(), `坏值 ${bad}`).toBeNull();
    }
  });

  it("Storage 可注入", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as unknown as Storage;
    writeLastSeenVersion("0.2.0", storage);
    expect(store.get(KEY)).toBe("0.2.0");
    expect(readLastSeenVersion(storage)).toBe("0.2.0");
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
