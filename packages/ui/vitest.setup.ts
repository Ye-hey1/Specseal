// jsdom 未实作 Pointer Capture 与 scrollIntoView，Radix Select 在开关与卷到选中项时
// 会直接调用这三支。缺一即在测试中抛 TypeError——这是环境缺口，不是组件行为，
// 所以补 no-op stub 而非改组件。
if (typeof window !== "undefined") {
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};

  // Radix Presence 的 animationend 处理以 CSS.escape 比对动画名；jsdom 没有 CSS 全域，
  // 缺了关闭动画结束事件会在 handler 内抛错、面板永不卸载。
  if (!window.CSS) {
    window.CSS = { escape: (value: string) => value } as unknown as typeof CSS;
  }

  // Radix Select 的 Content 以 ResizeObserver 量测可用高度。
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
}
