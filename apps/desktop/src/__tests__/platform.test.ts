import { afterEach, describe, expect, it, vi } from "vitest";

import { detectPlatform, modKey } from "../platform";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/120.0";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("detectPlatform（design D1）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("macOS 的 UA 回 macos", () => {
    expect(detectPlatform(MAC_UA)).toBe("macos");
  });

  it("Windows 的 UA 回 windows", () => {
    expect(detectPlatform(WINDOWS_UA)).toBe("windows");
  });

  it("Linux 的 UA 回 linux", () => {
    expect(detectPlatform(LINUX_UA)).toBe("linux");
  });

  it("非浏览器环境（无 navigator）回 linux", () => {
    vi.stubGlobal("navigator", undefined);
    expect(detectPlatform()).toBe("linux");
  });

  it("未传 UA 时读 navigator.userAgent", () => {
    vi.stubGlobal("navigator", { userAgent: MAC_UA });
    expect(detectPlatform()).toBe("macos");
  });
});

describe("modKey：快捷键标签的修饰键", () => {
  it("macOS 为 ⌘，Windows／Linux 为 Ctrl+", () => {
    expect(modKey("macos")).toBe("⌘");
    expect(modKey("windows")).toBe("Ctrl+");
    expect(modKey("linux")).toBe("Ctrl+");
  });
});
