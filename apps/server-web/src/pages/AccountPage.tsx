import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  SettingsCard,
  SettingsRow,
  StatusPill,
  useI18n,
  PageHeader,
} from "@specseal/ui";
import { useClient } from "../app/context";
import { fillUser } from "../lib/userLabel";
import { useAsync, useLastData } from "../lib/useAsync";
import { fmtDate } from "../lib/fmtDate";
import { Field } from "../components/Field";
import { FormDialog, FormDialogActions, FormMessage, SecretDone, useDialogSubmit } from "../components/FormDialog";
import { CardNote } from "../components/CardNote";
import { RevocationPill } from "../components/RevocationPill";
import { RevokeButton } from "../components/RevokeButton";
import type { AccountSummary, DeviceFamilyMeta, PatMeta } from "../api/client";

// 帐号自助页（server-identity「帐号 browser API 保持凭证秘密边界」, D4／D6；server-web-list-pages
// design D8、D10）：768px 置中栏，由上而下为我的项目、访问密钥、设备登录、登录工作阶段四张设置型卡。
// 密钥明文只在创建对话框内显示一次（server-web-detail-pages design D7）；访问密钥与设备登录的撤销钮
// 滑过才出现，撤销等破坏性操作先以确认框确认且立即生效。所有 server 数据留在本 route 的 component
// state（D1）。

type Confirm = { title: string; run: () => Promise<void> };

export function AccountPage() {
  const { t } = useI18n();
  const client = useClient();
  const { loading, data: fresh, error, reload } = useAsync(() => client.getAccount(), []);
  // 创建密钥或撤销后重读期间留着上一份：页面若退回加载中，开着的创建对话框（连同只显示一次的
  // 明文）会一起被卸掉。
  const data = useLastData(fresh, error);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  if (!data) {
    if (loading) {
      return (
        <p role="status" aria-live="polite" className="text-muted-foreground">
          {t("common.loading")}
        </p>
      );
    }
    return (
      <div role="alert">
        <p className="text-destructive">{t("account.loadFailed")}</p>
        <Button type="button" variant="outline" className="mt-3" onClick={reload}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  async function runConfirmed() {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      await confirm.run();
    } finally {
      setBusy(false);
      setConfirm(null);
      reload();
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6">
      {/* 与管理列表页一致：页面唯一 primary action 开对话框，创建字段不常驻页面。 */}
      <PageHeader
        level={1}
        title={t("account.title")}
        description={fillUser(t("account.description"), data.user)}
        actions={
          <Button type="button" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <KeyRound aria-hidden="true" className="h-4 w-4" />
            {t("account.createKey")}
          </Button>
        }
      />

      <AccountCards
        account={data}
        busy={busy}
        onRevokeKey={(pat) =>
          setConfirm({
            title: t("account.revokeKeyTitle").replace("{name}", pat.name),
            run: () => client.revokePat(pat.id),
          })
        }
        onRevokeDevice={(family) =>
          setConfirm({
            title: t("account.revokeDeviceTitle").replace("{name}", family.source),
            run: () => client.revokeDevice(family.id),
          })
        }
      />

      {/* 只在开着时挂载：每次打开都是空白表单。 */}
      {createOpen && <CreateKeyDialog onClose={() => setCreateOpen(false)} onCreated={reload} />}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.title ?? ""}
        description={t("account.revokeBody")}
        confirmLabel={t("common.revoke")}
        destructive
        busy={busy}
        onConfirm={runConfirmed}
      />
    </div>
  );
}

// 四张卡（design D10）。我的项目（server-web-console「帐号页呈现我的项目」）是唯读的个人视角，
// 数据只来自 account summary——admin 与一般成员看到同一张卡、同一形状，全部项目的治理视角在
// /admin/registry；显示名缺席时以等宽代号为名、不再重复一次代号。访问密钥的创建走页面的 primary
// action 开对话框；登录工作阶段唯读（注销由壳层的注销动作处理）；设备登录撤销后立即使 access
// token 与 refresh credential 失效。
function AccountCards({
  account,
  busy,
  onRevokeKey,
  onRevokeDevice,
}: {
  account: AccountSummary;
  busy: boolean;
  onRevokeKey: (pat: PatMeta) => void;
  onRevokeDevice: (family: DeviceFamilyMeta) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <SettingsCard title={t("account.projects")} aside={t("account.projectsAside")}>
        {account.memberships.length === 0 ? (
          <CardNote>{t("account.noProjects")}</CardNote>
        ) : (
          account.memberships.map((m) => (
            <SettingsRow
              key={m.projectKey}
              label={m.projectName || <span className="font-mono">{m.projectKey}</span>}
              description={m.projectName ? <span className="font-mono">{m.projectKey}</span> : undefined}
              control={
                <StatusPill tone="neutral" className="font-mono">
                  {m.role}
                </StatusPill>
              }
            />
          ))
        )}
      </SettingsCard>

      <SettingsCard title={t("account.keys")} aside={t("account.keysAside")}>
        {account.pats.length === 0 ? (
          <CardNote>{t("account.noKeys")}</CardNote>
        ) : (
          account.pats.map((pat) => (
            <SettingsRow
              key={pat.id}
              label={pat.name}
              description={
                pat.revokedAt
                  ? t("account.keyRevokedMeta")
                      .replace("{prefix}", pat.prefix)
                      .replace("{date}", fmtDate(pat.revokedAt, t("common.dash")))
                  : t("account.keyMeta")
                      .replace("{prefix}", pat.prefix)
                      .replace("{expires}", fmtDate(pat.expiresAt, t("common.forever")))
                      .replace("{lastUsed}", fmtDate(pat.lastUsedAt, t("common.never")))
              }
              control={
                <>
                  {!pat.revokedAt && (
                    <RevokeButton
                      label={t("account.revokeKey").replace("{name}", pat.name)}
                      disabled={busy}
                      onClick={() => onRevokeKey(pat)}
                    />
                  )}
                  <RevocationPill revokedAt={pat.revokedAt} />
                </>
              }
            />
          ))
        )}
      </SettingsCard>

      <SettingsCard title={t("account.devices")} aside={t("account.devicesAside")}>
        {account.deviceFamilies.length === 0 ? (
          <CardNote>{t("account.noDevices")}</CardNote>
        ) : (
          account.deviceFamilies.map((family) => (
            <SettingsRow
              key={family.id}
              label={family.source}
              description={t("account.deviceMeta").replace(
                "{date}",
                fmtDate(family.lastRefreshAt, t("common.dash")),
              )}
              control={
                <>
                  {!family.revokedAt && (
                    <RevokeButton
                      label={t("account.revokeDevice").replace("{name}", family.source)}
                      disabled={busy}
                      onClick={() => onRevokeDevice(family)}
                    />
                  )}
                  <RevocationPill revokedAt={family.revokedAt} />
                </>
              }
            />
          ))
        )}
      </SettingsCard>

      <SettingsCard title={t("account.sessions")}>
        {account.sessions.length === 0 ? (
          <CardNote>{t("account.noSessions")}</CardNote>
        ) : (
          account.sessions.map((session) => (
            <SettingsRow
              key={session.id}
              label={t("account.sessionCreated").replace("{date}", fmtDate(session.createdAt, t("common.dash")))}
              description={t("account.sessionExpires").replace(
                "{date}",
                fmtDate(session.expiresAt, t("common.dash")),
              )}
              control={<RevocationPill revokedAt={session.revokedAt} />}
            />
          ))
        )}
      </SettingsCard>
    </>
  );
}

// 创建访问密钥的对话框（design D7）：送出成功后同一个对话框换成已创建状态，一次性明文只在这里出现、
// 关掉就看不到；成功当下即重载，访问密钥卡随之多出一列。
function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const client = useClient();
  const [name, setName] = useState("");
  const [expires, setExpires] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const { pending, message, fieldErrors, submit } = useDialogSubmit(t("account.createKeyError"));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(async () => {
      const created = await client.createPat({ name, expires: expires || undefined });
      setPlaintext(created.plaintext);
      onCreated();
    });
  }

  if (plaintext) {
    return (
      <FormDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t("account.keyDoneTitle")}
        description={t("account.keyDoneBody")}
        done
      >
        <SecretDone value={plaintext} copyLabel={t("common.copy")} onDone={onClose} />
      </FormDialog>
    );
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("account.createKey")}
      description={t("account.createKeyHint")}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          id="pat-name"
          label={t("account.keyNameLabel")}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <Field
          id="pat-expires"
          label={t("account.keyExpiresLabel")}
          value={expires}
          onChange={setExpires}
          error={fieldErrors.expires}
        />
        <FormMessage message={message} fieldErrors={fieldErrors} />
        <FormDialogActions
          submitLabel={pending ? t("common.creating") : t("common.create")}
          pending={pending}
          onCancel={onClose}
        />
      </form>
    </FormDialog>
  );
}
