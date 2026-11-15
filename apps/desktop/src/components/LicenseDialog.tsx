// 授权对话框（desktop-about-page design D2／D3；spec「关于页」）：同一个对话框两种内容——
// 随 app 打包的 LICENSE 全文，或建置时产生的第三方授权清单（npm 与 cargo 两节）。
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  useI18n,
} from "@specseal/ui";

import licenseText from "../../../../LICENSE?raw";

export interface LicenseEntry {
  name: string;
  version: string;
  /** SPDX 授权识别字；套件未标示时为 null。 */
  license: string | null;
}

/** scripts/desktop/third-party-licenses.mjs 的输出形状（两节已依名称排序）。 */
export interface ThirdPartyLicenses {
  npm: LicenseEntry[];
  cargo: LicenseEntry[];
}

// 清单档由 predev／prebuild 产生、不入版本控制；以 glob 导入，缺档时建置不失败、值为 null。
const generated = import.meta.glob<ThirdPartyLicenses>("../generated/third-party-licenses.json", {
  eager: true,
  import: "default",
});
export const BUNDLED_THIRD_PARTY_LICENSES: ThirdPartyLicenses | null = Object.values(generated)[0] ?? null;

export type LicenseDialogContent = "license" | "thirdParty";

export interface LicenseDialogProps {
  /** null＝关闭。 */
  content: LicenseDialogContent | null;
  thirdPartyLicenses: ThirdPartyLicenses | null;
  onClose: () => void;
}

function LicenseSection({ title, entries }: { title: string; entries: LicenseEntry[] }) {
  const { t } = useI18n();
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
      {entries.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">{t("about.notGenerated")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
          {entries.map((entry) => (
            <li key={`${entry.name}@${entry.version}`}>
              <span className="font-mono">
                {entry.name} {entry.version}
              </span>
              <span className="text-muted-foreground"> · {entry.license ?? t("about.licenseUnspecified")}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function LicenseDialog({ content, thirdPartyLicenses, onClose }: LicenseDialogProps) {
  const { t } = useI18n();
  return (
    <AlertDialog open={content !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-w-[96ch] gap-4" aria-describedby={undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(content === "thirdParty" ? "about.thirdParty" : "about.license")}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto pr-1">
          {content === "license" && (
            <pre className="m-0 whitespace-pre-wrap font-mono text-[13px] leading-6">{licenseText}</pre>
          )}
          {content === "thirdParty" &&
            (thirdPartyLicenses ? (
              <>
                <LicenseSection title="npm" entries={thirdPartyLicenses.npm} />
                <LicenseSection title="cargo" entries={thirdPartyLicenses.cargo} />
              </>
            ) : (
              <p className="m-0 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                {t("about.notGenerated")}
              </p>
            ))}
        </div>
        <div className="flex items-center justify-end border-t border-border pt-3">
          <Button type="button" size="sm" onClick={onClose}>
            {t("about.close")}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
