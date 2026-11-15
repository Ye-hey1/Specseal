import { Navigate, Route, Routes } from "react-router-dom";
import { OverviewPage } from "./OverviewPage";
import { UsersSection } from "./UsersPage";
import { RegistrySection } from "./RegistryPage";
import { CredentialsPage } from "./CredentialsPage";
import { SystemPage } from "./SystemPage";
import { AuditPage } from "./AuditPage";

// 管理面的六个目的地。整个 section 由 router 以 lazy import 切出独立 chunk，
// 使登录／帐号的初载 bundle 不含管理代码（D1）。用户与项目各是一个区段，
// 列表与详情页在区段内切换（server-web-detail-pages design D1）。
export default function AdminSection() {
  return (
    <Routes>
      <Route index element={<OverviewPage />} />
      <Route path="users/*" element={<UsersSection />} />
      <Route path="registry/*" element={<RegistrySection />} />
      <Route path="credentials" element={<CredentialsPage />} />
      <Route path="system" element={<SystemPage />} />
      <Route path="audit" element={<AuditPage />} />
      {/* 数据操作已并入系统：旧书签送到内容搬去的地方，而不是空白画面。 */}
      <Route path="data" element={<Navigate to="/admin/system" replace />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
