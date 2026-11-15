// CLI 布署纯逻辑（desktop-app spec「安装 CLI 指令到 PATH」，design D5）：状态
// 判定（未安装／已安装同版／版本不符）、平台分流的布署计划（macOS symlink、
// AppImage 拷贝、Windows 与 deb 仅回报）、AppImage 版本不符自我修复判定、
// 布署目录不在 PATH 的提示旗标。文件系统操作归 adapter，core 只做决策。
import { describe, expect, it, vi } from "vitest";

import {
  cliDeployPlan,
  cliInstallStatus,
  isDirOnPath,
  needsRedeploy,
  parseCliVersion,
  zprofilePlan,
} from "../core/cliInstall";
import type { CliInstallAdapter, CliInstallProbe } from "../adapter/cliInstall";
import { createAppStore } from "../store";

describe("CLI 布署状态判定", () => {
  it("未侦测到已布署版本＝未安装", () => {
    expect(cliInstallStatus(null, "0.2.0")).toEqual({ kind: "not-installed" });
  });

  it("已布署且与 app 同版＝已安装", () => {
    expect(cliInstallStatus("0.2.0", "0.2.0")).toEqual({ kind: "installed", version: "0.2.0" });
  });

  it("已布署但与 app 版本不符＝版本不符", () => {
    expect(cliInstallStatus("0.1.0", "0.2.0")).toEqual({
      kind: "version-mismatch",
      version: "0.1.0",
    });
  });
});

describe("CLI --version 输出解析", () => {
  it("specseal 0.1.0 (arm64) 解析出 0.1.0", () => {
    expect(parseCliVersion("specseal 0.1.0 (arm64)\n")).toBe("0.1.0");
  });

  it("带 engine 版号的现行格式同样解析出套件版号（instruction-downgrade-guard 的刻意变更）", () => {
    expect(parseCliVersion("specseal 0.1.0 (arm64, engine v1.14.0)\n")).toBe("0.1.0");
  });

  it("无法解析时回 null", () => {
    expect(parseCliVersion("garbage")).toBeNull();
  });
});

describe("布署计划平台分流", () => {
  const ctx = { home: "/Users/u", bundledCliPath: "/Applications/Specseal.app/Contents/MacOS/specseal" };

  it("macOS：于 ~/.local/bin 建 symlink 指向 app bundle 内 CLI", () => {
    expect(cliDeployPlan("macos", ctx)).toEqual({
      action: "symlink",
      linkPath: "/Users/u/.local/bin/specseal",
      targetPath: "/Applications/Specseal.app/Contents/MacOS/specseal",
    });
  });

  it("Linux AppImage：拷贝至 ~/.local/bin（挂载点随运行变动、symlink 不可行）", () => {
    const linuxCtx = { home: "/home/u", bundledCliPath: "/tmp/.mount_abc/usr/bin/specseal" };
    expect(cliDeployPlan("linux-appimage", linuxCtx)).toEqual({
      action: "copy",
      destPath: "/home/u/.local/bin/specseal",
      sourcePath: "/tmp/.mount_abc/usr/bin/specseal",
    });
  });

  it("Windows：安装器负责 PATH，app 内仅回报状态", () => {
    expect(cliDeployPlan("windows", ctx)).toEqual({
      action: "none",
      reason: "installer-managed",
    });
  });

  it("Linux 非 AppImage（开发建置或手动解开的 app）：不布署，app 内仅回报状态", () => {
    expect(cliDeployPlan("linux-unpackaged", ctx)).toEqual({
      action: "none",
      reason: "unpackaged",
    });
  });
});

describe("启动自动布署判定（macOS 全自动、AppImage 版本不符自我修复）", () => {
  it("AppImage 且版本不符→需重布署", () => {
    expect(needsRedeploy("linux-appimage", { kind: "version-mismatch", version: "0.1.0" })).toBe(
      true,
    );
  });

  it("AppImage 已安装同版→不重布署", () => {
    expect(needsRedeploy("linux-appimage", { kind: "installed", version: "0.2.0" })).toBe(false);
  });

  it("AppImage 未安装→不主动布署（安装是用户的显式动作）", () => {
    expect(needsRedeploy("linux-appimage", { kind: "not-installed" })).toBe(false);
  });

  it("macOS 未安装→启动自动布署（spec 修订：毋须用户操作）", () => {
    expect(needsRedeploy("macos", { kind: "not-installed" })).toBe(true);
  });

  it("macOS 版本不符→自动重布署", () => {
    expect(needsRedeploy("macos", { kind: "version-mismatch", version: "0.1.0" })).toBe(true);
  });

  it("macOS 已安装同版→不重布署", () => {
    expect(needsRedeploy("macos", { kind: "installed", version: "0.2.0" })).toBe(false);
  });

  it("Windows 不自我修复（安装器职责）", () => {
    expect(needsRedeploy("windows", { kind: "not-installed" })).toBe(false);
  });

  it("Linux 非 AppImage 三种状态都不自动布署（没有可布署的来源）", () => {
    expect(needsRedeploy("linux-unpackaged", { kind: "not-installed" })).toBe(false);
    expect(needsRedeploy("linux-unpackaged", { kind: "installed", version: "0.5.0" })).toBe(false);
    expect(needsRedeploy("linux-unpackaged", { kind: "version-mismatch", version: "0.1.0" })).toBe(false);
  });
});

describe("zprofile PATH 追加决策（macOS，幂等）", () => {
  it("不在 PATH 且无识别行→输出带识别注解的追加行", () => {
    const plan = zprofilePlan(false, "");
    expect(plan.action).toBe("append");
    if (plan.action === "append") {
      expect(plan.line).toContain('export PATH="$HOME/.local/bin:$PATH"');
      expect(plan.line).toContain("# specseal cli");
    }
  });

  it("已在 PATH→不写入", () => {
    expect(zprofilePlan(true, "")).toEqual({ action: "none" });
  });

  it("zprofile 已有识别行→不重复追加（幂等）", () => {
    const existing = 'export PATH="$HOME/.local/bin:$PATH" # specseal cli\n';
    expect(zprofilePlan(false, existing)).toEqual({ action: "none" });
  });

  it("zprofile 读不到（null）视为空档可追加", () => {
    expect(zprofilePlan(false, null).action).toBe("append");
  });
});

describe("布署目录不在 PATH 的提示旗标", () => {
  it("目录在 PATH 上→不提示", () => {
    expect(isDirOnPath("/Users/u/.local/bin", "/usr/bin:/Users/u/.local/bin", ":")).toBe(true);
  });

  it("目录不在 PATH 上→提示加入方式", () => {
    expect(isDirOnPath("/Users/u/.local/bin", "/usr/bin:/usr/local/bin", ":")).toBe(false);
  });

  it("Windows 以分号分隔", () => {
    expect(isDirOnPath("C:\\Specseal", "C:\\Windows;C:\\Specseal", ";")).toBe(true);
  });
});

// --- store 接线（probe → core 判定 → 视图；动作与 AppImage 自我修复） ---

function macProbe(over: Partial<CliInstallProbe> = {}): CliInstallProbe {
  return {
    platform: "macos",
    home: "/Users/u",
    pathEnv: "/usr/bin:/Users/u/.local/bin",
    pathDelimiter: ":",
    bundledCliPath: "/Applications/Specseal.app/Contents/MacOS/specseal",
    appVersion: "0.2.0",
    deployedVersionOutput: null,
    zprofile: null,
    ...over,
  };
}

/** probe 依调用次序回传 results（超出即重复末项）；deploy 可注入断言。 */
function storeWith(results: CliInstallProbe[], deploy = vi.fn().mockResolvedValue(undefined)) {
  let calls = 0;
  const appendZprofile = vi.fn().mockResolvedValue(undefined);
  const adapter: CliInstallAdapter = {
    probe: vi.fn().mockImplementation(() => {
      const probe = results[Math.min(calls, results.length - 1)];
      calls += 1;
      return Promise.resolve(probe);
    }),
    deploy,
    appendZprofile,
  };
  return {
    store: createAppStore({ createSession: vi.fn() as never, cliInstall: adapter }),
    deploy,
    appendZprofile,
  };
}

describe("CLI 布署 store 接线", () => {
  it("macOS 未安装：探测后呈现未安装且可布署", async () => {
    const { store } = storeWith([macProbe()]);
    await store.getState().refreshCliInstall();

    expect(store.getState().cliInstall).toMatchObject({
      platform: "macos",
      status: { kind: "not-installed" },
      canDeploy: true,
      pathHint: false,
    });
  });

  it("installCli：对壳层送出 symlink 计划并重探测为已安装", async () => {
    const { store, deploy } = storeWith([
      macProbe(),
      macProbe({ deployedVersionOutput: "specseal 0.2.0 (arm64)\n" }),
    ]);
    await store.getState().refreshCliInstall();
    await store.getState().installCli();

    expect(deploy).toHaveBeenCalledWith({
      action: "symlink",
      linkPath: "/Users/u/.local/bin/specseal",
      targetPath: "/Applications/Specseal.app/Contents/MacOS/specseal",
    });
    expect(store.getState().cliInstall).toMatchObject({
      status: { kind: "installed", version: "0.2.0" },
      busy: false,
    });
  });

  it("已安装但 ~/.local/bin 不在 PATH：pathHint 亮起", async () => {
    const { store } = storeWith([
      macProbe({
        pathEnv: "/usr/bin:/usr/local/bin",
        deployedVersionOutput: "specseal 0.2.0 (arm64)\n",
      }),
    ]);
    await store.getState().refreshCliInstall();

    expect(store.getState().cliInstall).toMatchObject({
      status: { kind: "installed", version: "0.2.0" },
      pathHint: true,
      deployDir: "/Users/u/.local/bin",
    });
  });

  it("AppImage 版本不符：refreshCliInstall 自动重布署（启动自我修复）", async () => {
    const appImage = macProbe({
      platform: "linux-appimage",
      home: "/home/u",
      bundledCliPath: "/tmp/.mount_abc/usr/bin/specseal",
      deployedVersionOutput: "specseal 0.1.0 (x86_64)\n",
    });
    const { store, deploy } = storeWith([
      appImage,
      { ...appImage, deployedVersionOutput: "specseal 0.2.0 (x86_64)\n" },
    ]);
    await store.getState().refreshCliInstall();

    expect(deploy).toHaveBeenCalledWith({
      action: "copy",
      destPath: "/home/u/.local/bin/specseal",
      sourcePath: "/tmp/.mount_abc/usr/bin/specseal",
    });
    expect(store.getState().cliInstall).toMatchObject({
      status: { kind: "installed", version: "0.2.0" },
    });
  });

  it("macOS 版本不符：refreshCliInstall 自动重布署（spec 修订：启动自我修复）", async () => {
    const { store, deploy } = storeWith([
      macProbe({ deployedVersionOutput: "specseal 0.1.0 (arm64)\n" }),
      macProbe({ deployedVersionOutput: "specseal 0.2.0 (arm64)\n" }),
    ]);
    await store.getState().refreshCliInstall();

    expect(deploy).toHaveBeenCalledWith({
      action: "symlink",
      linkPath: "/Users/u/.local/bin/specseal",
      targetPath: "/Applications/Specseal.app/Contents/MacOS/specseal",
    });
    expect(store.getState().cliInstall).toMatchObject({
      status: { kind: "installed", version: "0.2.0" },
    });
  });

  it("macOS 未安装：启动即自动布署（spec 修订：毋须用户操作）", async () => {
    const { store, deploy } = storeWith([
      macProbe(),
      macProbe({ deployedVersionOutput: "specseal 0.2.0 (arm64)\n" }),
    ]);
    await store.getState().refreshCliInstall();

    expect(deploy).toHaveBeenCalledTimes(1);
    expect(store.getState().cliInstall).toMatchObject({
      status: { kind: "installed", version: "0.2.0" },
    });
  });

  it("macOS 启动自动布署失败：不阻断、卡片浮出错误", async () => {
    const deploy = vi.fn().mockRejectedValue(new Error("permission denied"));
    const { store } = storeWith([macProbe()], deploy);
    await store.getState().refreshCliInstall();

    expect(store.getState().cliInstall).toMatchObject({
      status: { kind: "not-installed" },
      error: "permission denied",
      busy: false,
    });
  });

  it("macOS 布署完成且 ~/.local/bin 不在 PATH：自动追加 zprofile 一行", async () => {
    const { store, appendZprofile } = storeWith([
      macProbe({
        pathEnv: "/usr/bin",
        zprofile: "",
        deployedVersionOutput: "specseal 0.2.0 (arm64)\n",
      }),
    ]);
    await store.getState().refreshCliInstall();

    expect(appendZprofile).toHaveBeenCalledTimes(1);
    expect(appendZprofile.mock.calls[0][0]).toContain("# specseal cli");
  });

  it("zprofile 已有识别行或已在 PATH：不重复追加（幂等）", async () => {
    const marked = storeWith([
      macProbe({
        pathEnv: "/usr/bin",
        zprofile: 'export PATH="$HOME/.local/bin:$PATH" # specseal cli\n',
        deployedVersionOutput: "specseal 0.2.0 (arm64)\n",
      }),
    ]);
    await marked.store.getState().refreshCliInstall();
    expect(marked.appendZprofile).not.toHaveBeenCalled();

    const onPath = storeWith([
      macProbe({ deployedVersionOutput: "specseal 0.2.0 (arm64)\n" }),
    ]);
    await onPath.store.getState().refreshCliInstall();
    expect(onPath.appendZprofile).not.toHaveBeenCalled();
  });

  it("Linux 非 AppImage 运行：仅回报 ~/.local/bin 的状态、不可布署、启动不自动布署", async () => {
    const { store, deploy } = storeWith([
      macProbe({
        platform: "linux-unpackaged",
        home: "/home/u",
        pathEnv: "/usr/bin",
        bundledCliPath: null,
        deployedVersionOutput: "specseal 0.2.0 (x86_64)\n",
      }),
    ]);
    await store.getState().refreshCliInstall();
    await store.getState().installCli();

    expect(deploy).not.toHaveBeenCalled();
    expect(store.getState().cliInstall).toMatchObject({
      platform: "linux-unpackaged",
      status: { kind: "installed", version: "0.2.0" },
      canDeploy: false,
      pathHint: false,
    });
  });

  it("Windows：仅回报状态、不可布署", async () => {
    const { store, deploy } = storeWith([
      macProbe({
        platform: "windows",
        home: "C:\\Users\\u",
        pathDelimiter: ";",
        pathEnv: "C:\\Windows",
        deployedVersionOutput: "specseal 0.2.0 (x86_64)\n",
      }),
    ]);
    await store.getState().refreshCliInstall();
    await store.getState().installCli();

    expect(deploy).not.toHaveBeenCalled();
    expect(store.getState().cliInstall).toMatchObject({
      status: { kind: "installed", version: "0.2.0" },
      canDeploy: false,
      pathHint: false,
    });
  });

  it("布署失败：浮出错误、解除 busy", async () => {
    const deploy = vi.fn().mockRejectedValue(new Error("permission denied"));
    const { store } = storeWith([macProbe()], deploy);
    await store.getState().refreshCliInstall();
    await store.getState().installCli();

    expect(store.getState().cliInstall).toMatchObject({
      busy: false,
      error: "permission denied",
    });
  });
});
