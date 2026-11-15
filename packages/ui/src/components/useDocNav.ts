import { useCallback, useRef, useState } from "react";

import type { DecisionJump } from "./DesignDoc";

/**
 * 变更文档之间的跳转状态（变更详情页与已封存页共用；design D5／D11／D14）：提案能力签→规格段、
 * 任务 D 签→设计决策卡、手动提示框「前往」→任务列。每个请求由目标组件处理完即清；`setTab` 切到目标文档。
 * 决策卡与任务列的请求带递增 seq，同一个目标可重复跳。
 */
export function useDocNav(setTab: (tab: string) => void) {
  // 规格段选定的能力：「打开 ▾」指向它。
  const [specCap, setSpecCap] = useState<string | null>(null);
  // 能力签的卷动请求：该规格段卷到后即清——自文档树切回规格文档时自顶端呈现。
  const [specJump, setSpecJump] = useState<{ cap: string } | null>(null);
  const [designJump, setDesignJump] = useState<DecisionJump | null>(null);
  const [taskLocate, setTaskLocate] = useState<{ ordinal: number; seq: number } | null>(null);
  const seq = useRef(0);
  const clearSpecJump = useCallback(() => setSpecJump(null), []);
  const clearDesignJump = useCallback(() => setDesignJump(null), []);
  const clearTaskLocate = useCallback(() => setTaskLocate(null), []);
  return {
    specCap,
    specJump,
    designJump,
    taskLocate,
    clearSpecJump,
    clearDesignJump,
    clearTaskLocate,
    openSpec: (cap: string) => {
      setSpecCap(cap);
      setSpecJump({ cap });
      setTab("specs");
    },
    jumpDecision: (id: string) => {
      setDesignJump({ id, seq: ++seq.current });
      setTab("design");
    },
    locateTask: (ordinal: number) => setTaskLocate({ ordinal, seq: ++seq.current }),
    /** 换变更时清掉选定的能力与在途请求。 */
    reset: () => {
      setSpecCap(null);
      setSpecJump(null);
      setDesignJump(null);
      setTaskLocate(null);
    },
  };
}
