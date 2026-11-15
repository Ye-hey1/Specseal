import { useCallback, useEffect, useState } from "react";

import { WebApiError } from "../api/client";
import { useSession } from "../app/context";

// 每个 route 以此表示 loading／success／error 状态（D6：一致且可恢复）。
// server 数据留在调用 route 的 component state，不进全域 store（D1）。

// 401 有两种语意：session 失效（code=unauthenticated）与登录密码错误
// （code=invalid_credentials）。只有前者代表已加载的 route 失去授权，须重读
// session 让 route guard 导回登录页并保留 returnTo；后者属登录表单的字段错误，
// 由 LoginPage 自行呈现，不走这里（LoginPage 不使用 useAsync）。
function isSessionExpired(error: unknown): boolean {
  return error instanceof WebApiError && error.status === 401 && error.code === "unauthenticated";
}

export type AsyncState<T> = {
  loading: boolean;
  data: T | null;
  error: unknown;
  reload: () => void;
};

/** Run `fn` on mount and whenever `deps` change; `reload()` re-runs it. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: unknown }>({
    loading: true,
    data: null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const { refresh } = useSession();

  useEffect(() => {
    let alive = true;
    setState({ loading: true, data: null, error: null });
    fn().then(
      (data) => {
        if (alive) setState({ loading: false, data, error: null });
      },
      (error) => {
        if (alive) setState({ loading: false, data: null, error });
        // session 失效：重读 session 真相，由 route guard 导向登录页并带安全 returnTo。
        if (isSessionExpired(error)) void refresh();
      },
    );
    return () => {
      alive = false;
    };
    // fn 每次 render 皆为新闭包，故以调用端的 deps 控制重跑；nonce 触发 reload。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload };
}

/**
 * 留着最近一次成功的回应：`useAsync` 重抓时会先清空 data，画面若照着清空就会退回加载中、把里面
 * 开着的对话框或分页一起卸掉。这里在重抓期间回传上一份；出错时回 null，让调用端呈现错误。
 */
export function useLastData<T>(fresh: T | null, error: unknown): T | null {
  const [last, setLast] = useState<T | null>(null);
  if (fresh && fresh !== last) setLast(fresh);
  return error == null ? (fresh ?? last) : null;
}
