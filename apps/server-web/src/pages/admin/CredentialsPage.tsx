import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Inbox, KeyRound, MonitorSmartphone } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ListCard,
  ListPager,
  ListRow,
  SearchField,
  SelectItem,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useI18n,
  usePaging,
  PageHeader,
} from "@specseal/ui";
import { useClient } from "../../app/context";
import { useAsync } from "../../lib/useAsync";
import { useListScroll } from "../../lib/useListScroll";
import { useNarrow } from "../../lib/useMediaQuery";
import { fmtDate } from "../../lib/fmtDate";
import { FilterSelect } from "../../components/FilterSelect";
import { NoMatchState } from "../../components/NoMatchState";
import { RevocationPill } from "../../components/RevocationPill";
import { RevokeButton } from "../../components/RevokeButton";
import { AdminError, AdminLoading } from "./states";

// 管理凭证页（server-admin, server-web-console「管理列表提供搜索、筛选、分页与具引导的
// 空状态」；server-web-list-pages design D2、D3、D6、D8）：全站访问密钥与设备凭证的 metadata
// （绝不呈现秘密——payload 亦无秘密），以列表卡顶端两个分页区分。列不可点，列尾是状态签与
// 滑过才出现的撤销钮；撤销先以确认框确认后立即生效。

type Confirm = { title: string; run: () => Promise<void> };

/** 关键字比对：以用户看得到的字段为准，不含不透明 id。 */
function matches(haystack: string[], keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  return haystack.some((field) => field.toLowerCase().includes(needle));
}

/** 列说明以「 · 」串接各段；窄屏幕只留第一段（前缀或用户）。 */
function joinMeta(parts: ReactNode[], narrow: boolean): ReactNode {
  const shown = narrow ? parts.slice(0, 1) : parts;
  return shown.map((part, i) => (
    <span key={i}>
      {i > 0 && " · "}
      {part}
    </span>
  ));
}

export function CredentialsPage() {
  const { t } = useI18n();
  const client = useClient();
  const narrow = useNarrow();
  const { loading, data, error, reload } = useAsync(() => client.getAdminCredentials(), []);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("keys");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const { scrollRef, scrollToTop } = useListScroll();

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

  const keep = (revokedAt: string | null) =>
    status === "" || (status === "active" ? revokedAt === null : revokedAt !== null);
  const pats = (data?.pats ?? []).filter(
    (p) => keep(p.revokedAt) && matches([p.prefix, p.name], q),
  );
  const devices = (data?.deviceFamilies ?? []).filter(
    (f) => keep(f.revokedAt) && matches([f.source], q),
  );
  const patPaging = usePaging(pats, { onMove: scrollToTop });
  const devicePaging = usePaging(devices, { onMove: scrollToTop });
  const nothingAtAll =
    data != null && data.pats.length === 0 && data.deviceFamilies.length === 0;

  // 搜索、筛选与切分页都回到第 1 页。
  function firstPage() {
    patPaging.setPage(1);
    devicePaging.setPage(1);
  }

  const userPart = (userId: string) => (
    <>
      {t("field.user")} <span className="font-mono">{userId}</span>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* 创建入口常驻而不只出现在空状态：建完第一把之后就再也找不到添加的地方了。
          访问密钥只能建给自己，所以指向帐号页——这里没有代建的 API。 */}
      <PageHeader
        level={1}
        title={t("credentials.title")}
        description={t("credentials.description")}
        actions={
          <>
            {!nothingAtAll && (
              <>
                <SearchField
                  label={t("common.search")}
                  placeholder={t("credentials.searchPlaceholder")}
                  value={q}
                  onChange={(value) => {
                    setQ(value);
                    firstPage();
                  }}
                />
                <FilterSelect
                  label={t("field.status")}
                  allLabel={t("field.allStatuses")}
                  value={status}
                  onChange={(value) => {
                    setStatus(value);
                    firstPage();
                  }}
                >
                  <SelectItem value="active">{t("common.active")}</SelectItem>
                  <SelectItem value="revoked">{t("common.revoked")}</SelectItem>
                </FilterSelect>
              </>
            )}
            <Button asChild className="gap-1.5">
              <Link to="/account">
                <KeyRound aria-hidden="true" className="h-4 w-4" />
                {t("credentials.createKey")}
              </Link>
            </Button>
          </>
        }
      />
      {loading && <AdminLoading />}
      {error != null && <AdminError onRetry={reload} />}

      {data &&
        (nothingAtAll ? (
          <EmptyState
            icon={Inbox}
            title={t("credentials.emptyTitle")}
            description={t("credentials.emptyBody")}
          />
        ) : (
          <Tabs
            value={tab}
            onValueChange={(next) => {
              setTab(next);
              firstPage();
              scrollToTop();
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <ListCard
              scrollRef={scrollRef}
              header={
                <TabsList variant="card">
                  <TabsTrigger value="keys" count={data.pats.length}>
                    {t("credentials.tabKeys")}
                  </TabsTrigger>
                  <TabsTrigger value="devices" count={data.deviceFamilies.length}>
                    {t("credentials.tabDevices")}
                  </TabsTrigger>
                </TabsList>
              }
              footer={
                tab === "keys" ? (
                  <ListPager key="keys" compact={narrow} {...patPaging.pager} />
                ) : (
                  <ListPager key="devices" compact={narrow} {...devicePaging.pager} />
                )
              }
            >
              {/* 该类完全没有时说明用途（不放创建钮，创建入口常驻页眉）；有数据但筛不出来才是无符合。 */}
              <TabsContent value="keys">
                {data.pats.length === 0 ? (
                  <EmptyState icon={KeyRound} title={t("credentials.noKeysTitle")} description={t("credentials.noKeysBody")} />
                ) : pats.length === 0 ? (
                  <NoMatchState />
                ) : (
                  patPaging.pageItems.map((p) => (
                    <ListRow
                      key={p.id}
                      data-pat={p.id}
                      mono={false}
                      title={p.name}
                      description={joinMeta(
                        [
                          <span className="font-mono">{p.prefix}</span>,
                          userPart(p.userId),
                          t("credentials.keyMeta")
                            .replace("{created}", fmtDate(p.createdAt, t("common.dash")))
                            .replace("{expires}", fmtDate(p.expiresAt, t("common.forever"))),
                        ],
                        narrow,
                      )}
                      meta={<RevocationPill revokedAt={p.revokedAt} />}
                      actions={
                        p.revokedAt ? undefined : (
                          <RevokeButton
                            label={t("credentials.revokeKey").replace("{name}", p.name)}
                            disabled={busy}
                            onClick={() =>
                              setConfirm({
                                title: t("credentials.revokeKeyTitle").replace("{name}", p.name),
                                run: () => client.adminRevokeToken(p.id),
                              })
                            }
                          />
                        )
                      }
                    />
                  ))
                )}
              </TabsContent>

              <TabsContent value="devices">
                {data.deviceFamilies.length === 0 ? (
                  <EmptyState
                    icon={MonitorSmartphone}
                    title={t("credentials.noDevicesTitle")}
                    description={t("credentials.noDevicesBody")}
                  />
                ) : devices.length === 0 ? (
                  <NoMatchState />
                ) : (
                  devicePaging.pageItems.map((f) => (
                    <ListRow
                      key={f.id}
                      data-device={f.id}
                      mono={false}
                      title={f.source}
                      description={joinMeta(
                        [
                          userPart(f.userId),
                          t("credentials.deviceMeta")
                            .replace("{created}", fmtDate(f.createdAt, t("common.dash")))
                            .replace("{refreshed}", fmtDate(f.lastRefreshAt, t("common.dash"))),
                        ],
                        narrow,
                      )}
                      meta={<RevocationPill revokedAt={f.revokedAt} />}
                      actions={
                        f.revokedAt ? undefined : (
                          <RevokeButton
                            label={t("credentials.revokeDevice").replace("{name}", f.source)}
                            disabled={busy}
                            onClick={() =>
                              setConfirm({
                                title: t("credentials.revokeDeviceTitle").replace("{name}", f.source),
                                run: () => client.adminRevokeFamily(f.id),
                              })
                            }
                          />
                        )
                      }
                    />
                  ))
                )}
              </TabsContent>
            </ListCard>
          </Tabs>
        ))}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`${confirm?.title ?? ""}？`}
        description={t("credentials.revokeBody")}
        confirmLabel={t("common.revoke")}
        destructive
        busy={busy}
        onConfirm={runConfirmed}
      />
    </div>
  );
}
