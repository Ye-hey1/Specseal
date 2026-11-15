import { useState } from "react";
import { Inbox } from "lucide-react";
import {
  EmptyState,
  Input,
  ListCard,
  ListPager,
  ListRow,
  PAGE_SIZE,
  SearchField,
  SelectItem,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useI18n,
  PageHeader,
} from "@specseal/ui";
import { useClient } from "../../app/context";
import { useAsync, useLastData } from "../../lib/useAsync";
import { auditLabel } from "../../lib/auditLabel";
import { useListScroll } from "../../lib/useListScroll";
import { useNarrow } from "../../lib/useMediaQuery";
import { FilterSelect } from "../../components/FilterSelect";
import { AdminError, AdminLoading } from "./states";

// 管理稽核纪录页（server-admin「管理 browser API 提供最小且完整的页面 view model」；
// server-web-list-pages design D7）：唯读清单。关键字、动作、来源与时间区间筛选加分页一律由
// 服务器计算——稽核事件随营运单调增长，前端全量加载再筛选会随数据量线性劣化。此页只把参数
// （含每页笔数）送出，呈现回传的当页事件，换页列的「共 N 笔」取自回应的 total。换页或改筛选
// 期间照旧显示上一份回应，列表卡与换页列不卸载——刚按的页码钮留着，焦点不会掉回页眉。

// 动作筛选的选项＝服务器的封闭集合（crates/host/specseal-server/src/admin/audit.rs 的 AuditAction）。
const ACTIONS = [
  "user-invited",
  "invitation-revoked",
  "user-suspended",
  "user-reactivated",
  "membership-changed",
  "admin-flag-changed",
  "project-created",
  "project-renamed",
  "repo-created",
  "repo-renamed",
  "token-revoked",
  "setup-completed",
  "scope-exported",
  "store-migrated",
  "backup-recorded",
];

const SOURCES = ["web", "api", "cli"];

const DATE_CLS = "h-8 w-36 text-[13px]";

export function AuditPage() {
  const { t } = useI18n();
  const client = useClient();
  const narrow = useNarrow();
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const { scrollRef, scrollToTop } = useListScroll();
  // 回应带着自己是用哪一页抓的：页码拉回之后、旧回应清掉之前，仍认得出它是越界页的回应。
  const { loading, data, error, reload } = useAsync(
    async () => ({ page, audit: await client.getAdminAudit({ q, action, source, from, to, page, limit: pageSize }) }),
    [q, action, source, from, to, page, pageSize],
  );
  // 重抓期间换页列仍可按，可能点到新结果已不存在的页（服务器对越界页码回空页）：这份空回应不显示、
  // 也不留作「上一份」，页码拉回最后一页重抓。
  const outOfRange = data != null && data.page > Math.max(data.audit.totalPages, 1);
  if (data && outOfRange && page === data.page) setPage(Math.max(data.audit.totalPages, 1));
  const fresh = data && !outOfRange ? data.audit : null;
  // 最近一次成功且页码有效的回应：重新抓取时 useAsync 会先清空 data，这里留着上一份继续显示。
  const shown = useLastData(fresh, error);

  // 任何筛选或每页笔数变动都回到第 1 页：留在第 3 页看新筛选的结果只会得到空白画面。
  function refilter(apply: () => void) {
    apply();
    setPage(1);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        level={1}
        title={t("audit.title")}
        description={t("audit.description")}
        actions={
          <>
            <SearchField
              label={t("common.search")}
              placeholder={t("audit.searchPlaceholder")}
              value={q}
              onChange={(v) => refilter(() => setQ(v))}
            />
            <FilterSelect
              label={t("audit.filterAction")}
              allLabel={t("audit.filterAllActions")}
              value={action}
              onChange={(v) => refilter(() => setAction(v))}
            >
              {ACTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`audit.action.${value}`)}
                </SelectItem>
              ))}
            </FilterSelect>
            <FilterSelect
              label={t("audit.filterSource")}
              allLabel={t("audit.filterAllSources")}
              value={source}
              onChange={(v) => refilter(() => setSource(v))}
            >
              {SOURCES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`audit.source.${value}`)}
                </SelectItem>
              ))}
            </FilterSelect>
            <span className="flex items-center gap-1.5">
              <Input
                type="date"
                aria-label={t("audit.filterFrom")}
                value={from}
                onChange={(e) => refilter(() => setFrom(e.target.value))}
                className={DATE_CLS}
              />
              <span aria-hidden="true" className="text-muted-foreground">
                –
              </span>
              <Input
                type="date"
                aria-label={t("audit.filterTo")}
                value={to}
                onChange={(e) => refilter(() => setTo(e.target.value))}
                className={DATE_CLS}
              />
            </span>
          </>
        }
      />

      {loading && !shown && <AdminLoading />}
      {error != null && <AdminError onRetry={reload} />}
      {shown && (
        <ListCard
          scrollRef={scrollRef}
          footer={
            <ListPager
              compact={narrow}
              page={page}
              pageCount={Math.max(shown.totalPages, 1)}
              total={shown.total}
              pageSize={pageSize}
              onPage={(next) => {
                setPage(next);
                scrollToTop();
              }}
              onPageSize={(size) => {
                refilter(() => setPageSize(size));
                scrollToTop();
              }}
            />
          }
        >
          {shown.entries.length === 0 ? (
            <EmptyState icon={Inbox} title={t("audit.emptyTitle")} description={t("audit.emptyBody")} />
          ) : narrow ? (
            shown.entries.map((e) => (
              <ListRow
                key={e.id}
                data-audit={e.id}
                mono={false}
                leading={e.createdAt.slice(0, 10)}
                title={auditLabel(t, "action", e.action)}
                description={`${e.subject} · ${e.actorId}`}
                meta={<StatusPill tone="neutral">{auditLabel(t, "source", e.source)}</StatusPill>}
              />
            ))
          ) : (
            // 不包外层卷动容器：由列表卡的卷动区负责两个方向的卷动，sticky 表头才固定得住。
            <Table wrapped={false}>
              <TableHeader sticky>
                <TableRow>
                  <TableHead>{t("audit.colTime")}</TableHead>
                  <TableHead>{t("audit.colAction")}</TableHead>
                  <TableHead>{t("audit.colSubject")}</TableHead>
                  <TableHead>{t("audit.colActor")}</TableHead>
                  <TableHead>{t("audit.colSource")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="tabular-nums">{e.createdAt.slice(0, 19)}</TableCell>
                    <TableCell>{auditLabel(t, "action", e.action)}</TableCell>
                    <TableCell className="font-mono">{e.subject}</TableCell>
                    <TableCell className="font-mono">{e.actorId}</TableCell>
                    <TableCell>
                      <StatusPill tone="neutral">{auditLabel(t, "source", e.source)}</StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ListCard>
      )}
    </div>
  );
}
