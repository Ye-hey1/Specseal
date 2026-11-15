// 触摸板手势事件的测试替身（desktop-swipe-back-finger-lift design D4）：SwipeBack 组件面
// （swipeBack.test.tsx）与 App 面（App.test.tsx）共用。测试档的 `@tauri-apps/api/event` mock
// 把 trackpad-gesture 的订阅交给 subscribeGesture，再以 gesture() 仿真原生层的手指按下与离开。
import { act } from "@testing-library/react";
import type { TrackpadGesture } from "../../components/SwipeBack";

export type GestureHandler = (e: { payload: TrackpadGesture }) => void;

/** 目前订阅中的 trackpad-gesture handler；测试结束时清空。 */
export const gestureHandlers: GestureHandler[] = [];

/** listen mock 的 trackpad-gesture 分支：登记 handler，回传的取消函数移除它。 */
export function subscribeGesture(handler: GestureHandler) {
  gestureHandlers.push(handler);
  return Promise.resolve(() => {
    const i = gestureHandlers.indexOf(handler);
    if (i >= 0) gestureHandlers.splice(i, 1);
  });
}

/** 原生层的手指按下／离开；ended 的 swipeEnabled 恒为 false（Rust 端如此送）。 */
export function gesture(phase: TrackpadGesture["phase"], swipeEnabled = phase === "began") {
  act(() => {
    for (const h of [...gestureHandlers]) h({ payload: { phase, swipeEnabled } });
  });
}
