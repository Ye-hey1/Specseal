// 触摸板滑动返回（desktop-readonly-detail-pages design D8；desktop-swipe-back-finger-lift design D4）：
// DOM 的 wheel 事件不带手指放开的相位，改由 macOS 原生层的 trackpad-gesture 事件界定一次手势——
// 只在手指按下（began）到离开（ended）之间累计朝返回方向（手指向右）的位移，主区左缘的「←」指示
// 随之推出、达门槛转实心；手指离开的当下结算，已达门槛即返回、未达收回。惯性卷动与没有手势阶段的
// 输入（一般鼠标滚轮）都落在按下之外，不推进。
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft } from "lucide-react";
import { cn } from "@specseal/ui";

/** 触发返回所需的累计水平位移（px）。 */
export const SWIPE_THRESHOLD = 120;
/** 一次手势累计垂直移动超过此值且多于累计水平移动时，整次手势取消（px）。 */
const VERTICAL_CANCEL = 10;

/** 原生层的手指按下／离开（Rust specseal-desktop-core 的 TrackpadGestureEvent）；
 * swipeEnabled 为系统设置「在页面之间滑动」是否允许两指滑动，只在 began 有意义。 */
export type TrackpadGesture = { phase: "began" | "ended"; swipeEnabled: boolean };

/** 朝返回方向的位移（正值）。WebKit 以 webkitDirectionInvertedFromDevice 标出自然卷动：
 * 打开（macOS 缺省）时手指向右 deltaX 为负；关闭时相反。缺席（非 WebKit）视同打开。 */
function backDelta(e: WheelEvent): number {
  const inverted = (e as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean })
    .webkitDirectionInvertedFromDevice;
  return inverted === false ? e.deltaX : -e.deltaX;
}

/** 事件目标或其祖先是否为仍可沿 deltaX 方向卷动的水平卷动区块（宽表格、代码区块）——先让它卷。
 * 方向看 deltaX 本身而非手指方向：自然卷动关闭时，手指向右是把区块往右卷。只裁切不卷动的
 * 区块（overflow hidden，如截断的长名称）不算。 */
function canScrollX(target: EventTarget | null, deltaX: number): boolean {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth || !/auto|scroll/.test(getComputedStyle(el).overflowX)) continue;
    if (deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth) return true;
  }
  return false;
}

export function SwipeBack({ enabled, onBack }: { enabled: boolean; onBack: () => void }) {
  const [progress, setProgress] = useState(0);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled) return;
    // idle：手指未按下；tracking：累计中；cancelled：垂直为主，等手指离开。
    let state: "idle" | "tracking" | "cancelled" = "idle";
    let total = 0; // 朝返回方向的累计位移
    let sumX = 0;
    let sumAbsY = 0;
    const reset = (next: typeof state) => {
      state = next;
      total = sumX = sumAbsY = 0;
      setProgress(0);
    };
    const onGesture = ({ payload }: { payload: TrackpadGesture }) => {
      if (payload.phase === "began") {
        // 每次 began 都从零开始：同一手势的 MayBegin 与 Began 之间没有位移，归零无损；
        // ended 遗失时，下一次按下（轻触也是 MayBegin→Cancelled＝began→ended）由此复原。
        reset(payload.swipeEnabled ? "tracking" : "idle");
        return;
      }
      const fire = state === "tracking" && total >= SWIPE_THRESHOLD;
      reset("idle");
      if (fire) onBackRef.current();
    };
    const onWheel = (e: WheelEvent) => {
      // 缩放（ctrl＋滚轮）不是返回手势。
      if (state !== "tracking" || e.ctrlKey) return;
      sumX += e.deltaX;
      sumAbsY += Math.abs(e.deltaY);
      if (sumAbsY > VERTICAL_CANCEL && sumAbsY > Math.abs(sumX)) {
        reset("cancelled");
        return;
      }
      const delta = backDelta(e);
      // 手势起点只认朝返回方向、且不在仍可沿此方向卷的区块内；开始后反向滑回会扣减。
      if (total === 0 && (delta <= 0 || canScrollX(e.target, e.deltaX))) return;
      total = Math.max(0, total + delta);
      setProgress(Math.min(1, total / SWIPE_THRESHOLD));
    };
    // 订阅失败（非 Tauri 环境）静默：没有阶段事件就不会触发。
    const unlisten = listen<TrackpadGesture>("trackpad-gesture", onGesture).catch(() => undefined);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      void unlisten.then((f) => f?.());
      setProgress(0);
    };
  }, [enabled]);

  const armed = progress >= 1;
  return (
    <div
      data-swipe-back
      data-progress={progress.toFixed(2)}
      data-armed={armed || undefined}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-0 top-1/2 z-20 flex h-16 w-10 items-center justify-center rounded-r-2xl shadow-sm transition-colors duration-150",
        armed ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
      )}
      // 随累计位移自左缘推出；位移为 0 时完全收在左缘外。
      style={{ transform: `translate(${(progress - 1) * 100}%, -50%)`, opacity: progress === 0 ? 0 : 1 }}
    >
      <ArrowLeft className="h-5 w-5" />
    </div>
  );
}
