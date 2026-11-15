import { JSDOM } from "jsdom";

// vitest 3.2 的 jsdom 测试环境未把 Web Storage 挂到 window 或全域，依赖本机保存
// 持久化的 desktop 测试因此在访问 localStorage／sessionStorage 时抛
// 「Cannot read properties of undefined」。以一个真实 jsdom Window 的 Storage
// 补上这两个全域，并于每个测试档起始清空，确保测试档之间状态不残留。
const { window: storageWindow } = new JSDOM("", { url: "http://localhost:3000/" });

for (const key of ["localStorage", "sessionStorage"] as const) {
  const storage = storageWindow[key];
  storage.clear();
  Object.defineProperty(globalThis, key, { configurable: true, value: storage });
}

// jsdom 未实作 Pointer Capture 与 scrollIntoView，Radix Select 开关与卷到选中项时
// 会直接调用。缺一即抛 TypeError——环境缺口，补 no-op stub。
if (typeof window !== "undefined") {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
}

// jsdom 未实作 ResizeObserver，面板卷动指示条与高度自适应会直接 new——
// 同属环境缺口，补 no-op stub（jsdom 无版面计算，观察本身无从触发）。
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom 未实作 Range 的版面量测，CodeMirror 挂载时会直接调用（项目设置的编辑器）——
// 补回空量测。
if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
}
