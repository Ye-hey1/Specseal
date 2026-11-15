import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, useI18n } from "@specseal/ui";
import { useClient, useSession } from "../app/context";
import { useAsync } from "../lib/useAsync";
import { readFormError } from "../lib/formError";
import { Field } from "../components/Field";
import { FocusFooter, FocusHeader, FocusNotice } from "../layouts/FocusLayout";

// 邀请接受（server-identity「邀请一次性且到期失效」, D2／D3）。token 由 URL path 带入；
// 有效邀请显示设置密码表单，提交后 Server 原子建帐号并创建 session，SPA 依回传的
// destination 导向（admin→/admin，一般→/account）。已用／过期／未知 token 一律显示
// 不可区分的「邀请无效」且无表单。
export function InvitePage() {
  const { t } = useI18n();
  const client = useClient();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const { token = "" } = useParams();
  const { loading, data } = useAsync(() => client.getInvitation(token), [token]);
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
      const { destination } = await client.acceptInvitation(token, { password });
      await refresh();
      navigate(destination);
    } catch (error) {
      const read = readFormError(error, t("invite.error"));
      setMessage(read.message);
      setFieldErrors(read.fieldErrors);
      setPending(false);
    }
  }

  if (loading) {
    return (
      <p role="status" aria-live="polite" className="text-muted-foreground">
        {t("common.loading")}
      </p>
    );
  }
  if (!data) {
    // 已用／过期／未知 token：不可区分的固定消息，不回显内部原因。
    return <FocusNotice title={t("invite.invalidTitle")} body={t("invite.invalidBody")} />;
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <FocusHeader title={t("invite.title")} description={t("invite.body").replace("{email}", data.email)} />
      {/* 唯读信息：受邀帐号与要加入的这台 server，设置密码前先确认没有找错地方。 */}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg bg-muted/50 px-3 py-2.5 text-[13px]">
        <dt className="text-muted-foreground">{t("field.email")}</dt>
        <dd className="truncate">{data.email}</dd>
        <dt className="text-muted-foreground">{t("invite.server")}</dt>
        <dd className="truncate font-mono">{window.location.host}</dd>
      </dl>
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
          {pending ? t("common.creating") : t("invite.submit")}
        </Button>
      </FocusFooter>
    </form>
  );
}
