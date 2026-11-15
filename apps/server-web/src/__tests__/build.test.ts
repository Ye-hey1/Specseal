// @vitest-environment node
// 以 node 环境运行：Vite build 内部使用 esbuild，在 jsdom 环境下其
// TextEncoder/Uint8Array 不变式会被破坏。此测试仅查看 build 产物，不需 DOM。
import { describe, it, expect } from "vitest";
import { build, type RollupOutput } from "vite";
import { fileURLToPath } from "node:url";

// Production build 契约（server-web-console D5 / delivery-baseline）：Vite 产出的
// JS chunk 与 CSS 资产必须带内容哈希——immutable 缓存与 binary 内嵌都靠这个保证。
// 以 Vite build API 就地建置（write:false，不落地），查看 emitted chunk 文件名。
const SERVER_WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const HASHED = /-[A-Za-z0-9_-]{8,}\.(js|css)$/;

describe("Vite production build", () => {
  it(
    "emits content-hashed JS chunks and CSS assets",
    async () => {
      const result = (await build({
        root: SERVER_WEB_ROOT,
        logLevel: "silent",
        build: { write: false },
      })) as RollupOutput | RollupOutput[];

      const outputs = Array.isArray(result) ? result : [result];
      const items = outputs.flatMap((o) => o.output);

      const jsChunks = items.filter(
        (i) => i.type === "chunk" && i.fileName.endsWith(".js"),
      );
      const cssAssets = items.filter(
        (i) => i.type === "asset" && i.fileName.endsWith(".css"),
      );

      expect(jsChunks.length).toBeGreaterThan(0);
      expect(cssAssets.length).toBeGreaterThan(0);

      for (const item of [...jsChunks, ...cssAssets]) {
        expect(item.fileName, `${item.fileName} should be content-hashed`).toMatch(
          HASHED,
        );
      }
    },
    60_000,
  );
});
