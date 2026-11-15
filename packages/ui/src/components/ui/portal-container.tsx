import * as React from "react";

// 浮层（Select 菜单之类）缺省 portal 到 document.body。但在 modal 对话框／抽屉内部，
// body 是 focus trap 的外面：Dialog 的 FocusScope 会把焦点拉回 content，Radix Select
// 又把焦点送去它 portal 出去的菜单，两边对同一次 focus 事件互推，直到爆堆栈。
//
// 因此 modal 容器把自己的 content 节点通过这个 context 提供出去，浮层改 portal 进去，
// 焦点就一直待在同一个 scope 里。容器外（一般页面）没有 provider，维持 portal 到 body。
const PortalContainerContext = React.createContext<HTMLElement | null>(null);

export const PortalContainerProvider = PortalContainerContext.Provider;

/** 目前应该 portal 进去的节点；不在 modal 容器内时为 null（＝portal 到 body）。 */
export function usePortalContainer(): HTMLElement | null {
  return React.useContext(PortalContainerContext);
}
