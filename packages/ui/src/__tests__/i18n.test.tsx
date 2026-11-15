// design D7 自制轻量 i18n：I18nProvider（locale＋可选 app 层 messages 合并）与
// useI18n() 的 t(key)。缺 key 回传 key 本身（开发期可见的失败，而非静默错语言）。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { I18nProvider, useI18n, MESSAGES, dictionaryProblems, translatorFor } from "../i18n";

function Probe({ id }: { id: string }) {
  const { t } = useI18n();
  return <span data-testid="probe">{t(id)}</span>;
}

function CountProbe({ id, n }: { id: string; n: number }) {
  const { tn } = useI18n();
  return <span data-testid="probe">{tn(id, n)}</span>;
}

function probeText(): string {
  return screen.getByTestId("probe").textContent ?? "";
}

describe("I18nProvider / useI18n", () => {
  it("resolves built-in keys per locale", () => {
    const { unmount } = render(
      <I18nProvider locale="zh-CN">
        <Probe id="stage.proposed" />
      </I18nProvider>,
    );
    expect(probeText()).toBe("提案中");
    unmount();
    render(
      <I18nProvider locale="en">
        <Probe id="stage.proposed" />
      </I18nProvider>,
    );
    expect(probeText()).toBe("Proposed");
  });

  it("merges app-layer messages over the built-in dictionary", () => {
    const messages = {
      "zh-CN": { "app.hello": "你好" },
      en: { "app.hello": "Hello" },
    };
    const { unmount } = render(
      <I18nProvider locale="en" messages={messages}>
        <Probe id="app.hello" />
      </I18nProvider>,
    );
    expect(probeText()).toBe("Hello");
    unmount();
    // 合并后内置 key 仍查得到。
    render(
      <I18nProvider locale="en" messages={messages}>
        <Probe id="stage.proposed" />
      </I18nProvider>,
    );
    expect(probeText()).toBe("Proposed");
  });

  it("returns the key itself when the key is missing", () => {
    render(
      <I18nProvider locale="en">
        <Probe id="no.such.key" />
      </I18nProvider>,
    );
    expect(probeText()).toBe("no.such.key");
  });

  it("defaults to zh-CN outside any provider", () => {
    render(<Probe id="stage.proposed" />);
    expect(probeText()).toBe("提案中");
  });

  // fix-english-status-labels-and-plurals D4：两语言键集合（.one 除外）、.one 只在英文且有基础键、
  // 计数文案（数字占位符之后接复数名词）一律用 {n} 并有 .one——三份字典共用同一个检查。
  it("passes the shared dictionary check", () => {
    expect(dictionaryProblems(MESSAGES)).toEqual([]);
    expect(Object.keys(MESSAGES.en).length).toBeGreaterThan(0);
  });

  it("dictionaryProblems names each kind of problem", () => {
    const problems = dictionaryProblems({
      "zh-CN": {
        "a.count": "{n} 个",
        "b.only": "只有中文",
        "c.rules": "{count} 条规则",
        "d.x.one": "x",
        "f.ok": "第 {n} 轮",
        "g.items": "{count} 个项目",
      },
      en: {
        "a.count": "{n} widgets",
        "c.rules": "{count} rules",
        "e.orphan.one": "{n} thing",
        "f.ok": "Round {n}",
        "g.items": "{n} items",
        "g.items.one": "{n} item",
        "h.new": "New",
      },
    });
    expect(problems).toEqual([
      "key only in zh-CN: b.only",
      ".one outside en: zh-CN d.x.one",
      "key only in en: h.new",
      ".one without a base key: e.orphan.one",
      "count message without .one: a.count",
      "count message must use {n}: c.rules",
      "zh-CN count message must use {n} too: g.items",
    ]);
  });

  it("exposes the active locale", () => {
    function LocaleProbe() {
      const { locale } = useI18n();
      return <span data-testid="probe">{locale}</span>;
    }
    render(
      <I18nProvider locale="en">
        <LocaleProbe />
      </I18nProvider>,
    );
    expect(probeText()).toBe("en");
  });
});

// fix-english-status-labels-and-plurals D2：tn(key, n) 依数量菜单复数。只有英文本典写 `.one`。
describe("tn(key, n)", () => {
  const messages = {
    "zh-CN": { "app.count": "{n} 个组件", "app.plain": "{n} 个东西" },
    en: { "app.count": "{n} widgets", "app.count.one": "{n} widget", "app.plain": "{n} things" },
  };

  function countText(locale: "zh-CN" | "en", id: string, n: number): string {
    const { unmount } = render(
      <I18nProvider locale={locale} messages={messages}>
        <CountProbe id={id} n={n} />
      </I18nProvider>,
    );
    const text = probeText();
    unmount();
    return text;
  }

  it("uses the .one form in English when n is 1", () => {
    expect(countText("en", "app.count", 1)).toBe("1 widget");
  });

  it("uses the plural form in English when n is 0 or 2", () => {
    expect(countText("en", "app.count", 0)).toBe("0 widgets");
    expect(countText("en", "app.count", 2)).toBe("2 widgets");
  });

  it("falls back to the base key when no .one form exists", () => {
    expect(countText("en", "app.plain", 1)).toBe("1 things");
  });

  it("always uses the base key in zh-CN", () => {
    expect(countText("zh-CN", "app.count", 1)).toBe("1 个组件");
    expect(countText("zh-CN", "app.count", 3)).toBe("3 个组件");
  });

  it("returns the key itself when the key is missing", () => {
    expect(countText("en", "no.such.key", 1)).toBe("no.such.key");
  });

  it("works outside any provider with the zh-CN dictionary", () => {
    render(<CountProbe id="doc.scenarioCount" n={1} />);
    expect(probeText()).toBe("1 个 scenario");
  });
});

// 真实字典的计数文案（desktop-config「英文计数文案依数量使用单数或复数」的情境值）。
describe("英文计数文案（真实键）", () => {
  const en = translatorFor("en");

  it.each([
    ["common.tasksCount", 0, "0 tasks"],
    ["common.rounds", 1, "1 round"],
    ["doc.scenarioCount", 1, "1 scenario"],
    ["analyze.issues", 1, "1 issue"],
    ["analyze.issues", 2, "2 issues"],
    ["analyze.validateFail", 1, "Structural validation: 1 error"],
    ["revert.blockedChecked", 1, "1 checked task"],
    ["ticket.rules.projectCount", 1, "1 project rule"],
    ["doc.capabilityRemovedScenarios", 1, ", 1 scenario removed with REMOVED-SCENARIO"],
  ] as const)("%s n=%i → %s", (key, n, expected) => {
    expect(en.tn(key, n)).toBe(expected);
  });

  it("繁中与英文不带数字的同一句都用 {n}", () => {
    expect(translatorFor("zh-CN").tn("ticket.rules.replaceWithRules", 12)).toBe("只用项目规则（没有套用缺省 12 条）");
  });
});
