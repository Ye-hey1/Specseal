import { defineConfig } from "vitest/config";

// 与 apps/desktop 一致：jsdom + globals + 自动 JSX；不做任何 console 过滤或 act
// 警告压制（delivery-baseline「禁止以压制方式清零」——警告一律由测试侧明确等待消除）。
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
