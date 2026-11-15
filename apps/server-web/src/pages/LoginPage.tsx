import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, useI18n } from "@specseal/ui";
import { useClient, useSession } from "../app/context";
import { WebApiError } from "../api/client";
import { Field } from "../components/Field";
import { FocusFooter, FocusHeader } from "../layouts/FocusLayout";

// 本机密码登录。提交期间停用避免重复；失败保留输入、把错误放字段旁并以 role=alert
// 声明；成功依 Server 回传的 destination 导向（D3）。
export function LoginPage() {
  const { t } = useI18n();
  const client = useClient();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = params.get("returnTo") ?? undefined;
  const userCode = params.get("user_code") ?? undefined;

  const [email, setEmail] = useState("");
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
      const { destination } = await client.login({ email, password, userCode, returnTo });
      await refresh();
      navigate(destination);
    } catch (error) {
      if (error instanceof WebApiError) {
        setMessage(error.message);
        setFieldErrors(error.fieldErrors ?? {});
      } else {
        setMessage(t("login.error"));
      }
      setPending(false);
    }
  }

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  // 说明点名这台主机（等宽字），让用户确认自己登录的是哪一台 server。
  const [beforeHost, afterHost] = t("login.description").split("{host}");

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <FocusHeader
        title={t("login.title")}
        description={
          <>
            {beforeHost}
            <span className="font-mono">{window.location.host}</span>
            {afterHost}
          </>
        }
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
      <Field
        id="password"
        label={t("field.password")}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={fieldErrors.password}
      />
      {message && !hasFieldErrors && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <FocusFooter>
        <Button type="submit" disabled={pending}>
          {pending ? t("login.pending") : t("login.submit")}
        </Button>
      </FocusFooter>
    </form>
  );
}
