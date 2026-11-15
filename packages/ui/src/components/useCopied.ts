import { useEffect, useRef, useState } from "react";

/** 勾号维持时间（spec「共用组件唯一来源」：主色勾号 1.5 秒）。 */
const COPIED_MS = 1500;

/** 拷贝钮的 copied 回馈：触发后亮 1.5 秒自动复原，重复触发重新计时。
 * 计时器随 unmount 取消；卸载后才到的触发（剪贴板异步写入晚于卸载完成）直接忽略——
 * 晚于卸载的 setState 在测试环境拆除后会炸（window 已不存在），真实页面则是对已卸载
 * 组件白做工、留下没人清的计时器。 */
export function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const markCopied = () => {
    if (!mounted.current) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return [copied, markCopied];
}
