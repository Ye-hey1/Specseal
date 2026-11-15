import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, useI18n } from "@specseal/ui";
import { useClient, useSession } from "../app/context";
import { useAsync } from "../lib/useAsync";
import { readFormError } from "../lib/formError";
import { Field } from "../components/Field";
import { FocusFooter, FocusHeader, FocusNotice } from "../layouts/FocusLayout";
import type { SetupState } from "../api/client";

// 开箱流程（server-setup「setup 流程完成开箱四要素」, D2／D3／D8 第三阶段）。token 由
// URL query 带入；两个提交节点分别创建第一位 Admin 与第一组 Project／Repo，最后节点
// 完成后 Server 已创建 session 并回 `/admin?welcome=1`，SPA 站内导向。
export function SetupPage() {
  const { t } = useI18n();
  const client = useClient();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { loading, data } = useAsync(() => client.getSetupState(token), [token]);
  // 创建管理员后前进至 registry 步骤：后续状态覆盖初载状态。
  const [advanced, setAdvanced] = useState<SetupState | null>(null);

  const state = advanced ?? data;

  if (!state) {
    if (loading) {
      return (
        <p role="status" aria-live="polite" className="text-muted-foreground">
          {t("common.loading")}
        </p>
      );
    }
    // 无效／过期／已耗用 token：不可区分的固定消息，不回显内部原因。
    return <FocusNotice title={t("setup.invalidTitle")} body={t("setup.invalidBody")} />;
  }

  return state.step === "admin" ? (
    <AdminStep token={token} onAdvance={setAdvanced} />
  ) : (
    <RegistryStep token={token} />
  );
}

// 节点一：创建第一位管理员（active 且带 admin 旗标）。成功前进至 registry 步骤。
function AdminStep({
  token,
  onAdvance,
}: {
  token: string;
  onAdvance: (state: SetupState) => void;
}) {
  const { t } = useI18n();
  const client = useClient();
  const [email, setEmail] = useState("");
  const [display, setDisplay] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const next = await client.submitSetupAdmin(token, { email, display, password });
      onAdvance(next);
    } catch (error) {
      const read = readFormError(error, t("setup.createAdminError"));
      setMessage(read.message);
      setFieldErrors(read.fieldErrors);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <FocusHeader
        step={{ current: 1, total: 2, label: t("setup.stepLabel") }}
        title={t("setup.step1")}
        description={t("setup.step1Body")}
      />
      <Field
        id="email"
        label={t("field.email")}
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        error={fieldErrors.email}
      />
      <Field id="display" label={t("field.display")} value={display} onChange={setDisplay} error={fieldErrors.display} />
      <Field
        id="password"
        label={t("field.password")}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        error={fieldErrors.password}
      />
      {message && Object.keys(fieldErrors).length === 0 && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <FocusFooter>
        <Button type="submit" disabled={pending}>
          {pending ? t("common.creating") : t("setup.createAdmin")}
        </Button>
      </FocusFooter>
    </form>
  );
}

// 节点二：创建第一组 Project／Repo，完成 setup。成功后 Server 已创建 admin session，
// SPA 导向回传的 `/admin?welcome=1`。
function RegistryStep({ token }: { token: string }) {
  const { t } = useI18n();
  const client = useClient();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [projectKey, setProjectKey] = useState("");
  const [projectName, setProjectName] = useState("");
  const [repoKey, setRepoKey] = useState("");
  const [repoName, setRepoName] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const { destination } = await client.submitSetupRegistry(token, {
        projectKey,
        projectName,
        repoKey,
        repoName,
      });
      await refresh();
      navigate(destination);
    } catch (error) {
      const read = readFormError(error, t("setup.createRegistryError"));
      setMessage(read.message);
      setFieldErrors(read.fieldErrors);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <FocusHeader
        step={{ current: 2, total: 2, label: t("setup.stepLabel") }}
        title={t("setup.step2")}
        description={t("setup.step2Body")}
      />
      <Field
        id="project-key"
        label={t("field.projectKey")}
        hint={t("field.keyImmutable")}
        value={projectKey}
        onChange={setProjectKey}
        error={fieldErrors.projectKey}
      />
      <Field id="project-name" label={t("registry.projectNameLabel")} value={projectName} onChange={setProjectName} />
      <Field
        id="repo-key"
        label={t("field.repoKey")}
        hint={t("field.keyImmutable")}
        value={repoKey}
        onChange={setRepoKey}
        error={fieldErrors.repoKey}
      />
      <Field id="repo-name" label={t("registry.repoNameLabel")} value={repoName} onChange={setRepoName} />
      {message && Object.keys(fieldErrors).length === 0 && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <FocusFooter>
        <Button type="submit" disabled={pending}>
          {pending ? t("common.creating") : t("setup.createRegistry")}
        </Button>
      </FocusFooter>
    </form>
  );
}
