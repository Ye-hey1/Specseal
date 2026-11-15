import { createContext, useContext, type ReactNode } from "react";
import type { SessionData, WebClient } from "../api/client";

// client 是 HTTP adapter（非 server 数据），放 context 供全 app 使用（D1 允许：
// 「跨路由且非服务器真相」）。session 是 App 开机读取一次的角色真相，供导览与
// guard 使用；login／logout 后 reload。

const ClientContext = createContext<WebClient | null>(null);

export function ClientProvider({ client, children }: { client: WebClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useClient(): WebClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useClient must be used within ClientProvider");
  return client;
}

// refresh 重新读取 session 并在完成后 resolve——login／logout 后须等它完成再导向，
// 否则 guard 读到旧 session 会把用户弹回登录。
export type SessionValue = { session: SessionData; refresh: () => Promise<void> };

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ value, children }: { value: SessionValue; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used within SessionProvider");
  return value;
}
