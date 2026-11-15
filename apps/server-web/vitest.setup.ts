import { JSDOM } from "jsdom";

// vitest 3.2 的 jsdom 环境未把 Web Storage 挂到 window 或全域（与 apps/desktop 同一个
// 问题）。导览的「看过了」状态存 localStorage，没有它连测试的初始状态都无从设置。
const { window: storageWindow } = new JSDOM("", { url: "http://localhost:3000/" });
for (const key of ["localStorage", "sessionStorage"] as const) {
  const storage = storageWindow[key];
  storage.clear();
  Object.defineProperty(globalThis, key, { configurable: true, value: storage });
}

// jsdom 的 navigator.language 缺省是 en-US，而既有测试断言的是中文接口。把测试环境的
// 浏览器语言钉成 zh-CN——这是环境默认值，不是 app 状态；要验语言侦测的测试自己覆写它。
if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "language", { value: "zh-CN", configurable: true });
}

// jsdom 未实作 matchMedia，Radix Sheet 与 responsive／reduced-motion 判断都依赖它。
// 缺省所有 media query 不匹配；个别测试可覆写（例如窄屏幕或 prefers-reduced-motion）。
// node 环境的测试（如 build.test.ts）没有 window，跳过。
if (typeof window !== "undefined") {
  // jsdom 未实作 Pointer Capture 与 scrollIntoView，Radix Select 开关与卷到选中项时
  // 会直接调用。缺一即抛 TypeError——环境缺口，补 no-op stub。
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};

  // jsdom 未实作 ResizeObserver；Radix Checkbox 等原语内部依赖它。no-op stub 即可
  //（测试不断言尺寸观察行为）。
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
}
