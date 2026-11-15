// design D2：文档节点＝tabs 原语的直向 tree 变体——保留 tab／tabpanel 语意，作用中以主色淡底标示。
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

function renderTree() {
  return render(
    <Tabs defaultValue="a" orientation="vertical">
      <TabsList variant="tree">
        <TabsTrigger value="a">提案</TabsTrigger>
        <TabsTrigger value="b">设计</TabsTrigger>
      </TabsList>
      <TabsContent value="a">内文 A</TabsContent>
      <TabsContent value="b">内文 B</TabsContent>
    </Tabs>,
  );
}

describe("Tabs tree 变体", () => {
  it("触发钮保留 tab 语意，作用中带主色淡底、非作用中不带", () => {
    renderTree();
    const a = screen.getByRole("tab", { name: "提案" });
    const b = screen.getByRole("tab", { name: "设计" });
    // jsdom 不算 CSS：底色挂在 data-state 变体上，作用中与否由 data-state 决定；非作用中不得有常驻底色。
    expect(a.getAttribute("data-state")).toBe("active");
    expect(a.className).toContain("data-[state=active]:bg-primary/12");
    expect(b.getAttribute("data-state")).toBe("inactive");
    expect(b.className).not.toMatch(/(^|\s)bg-primary\/12/);
    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe("vertical");
  });

  it("点节点切换作用中与 tabpanel 内容", () => {
    renderTree();
    const b = screen.getByRole("tab", { name: "设计" });
    fireEvent.mouseDown(b, { button: 0, ctrlKey: false });
    expect(b.getAttribute("data-state")).toBe("active");
    expect(screen.getByRole("tabpanel").textContent).toBe("内文 B");
  });

  it("清单直向排列", () => {
    renderTree();
    expect(screen.getByRole("tablist").className).toContain("flex-col");
  });
});

// server-web-list-pages design D1：标签后的计数签（已封存页与 server 用户页、凭证页共用）。
describe("TabsTrigger count", () => {
  it("count 渲染在标签之后的计数签；未给时没有计数签", () => {
    render(
      <Tabs defaultValue="users">
        <TabsList variant="card">
          <TabsTrigger value="users" count={12}>
            用户
          </TabsTrigger>
          <TabsTrigger value="pending">邀请中</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const users = screen.getByRole("tab", { name: /用户/ });
    const pill = users.querySelector("[data-tab-count]") as HTMLElement;
    expect(pill.textContent).toBe("12");
    expect(pill.className).toContain("rounded-full");
    expect(users.textContent).toBe("用户12");
    expect(screen.getByRole("tab", { name: "邀请中" }).querySelector("[data-tab-count]")).toBeNull();
  });

  it("未给 count 时子节点原样交给 Radix：asChild 搭单一子元素照常渲染", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList variant="card">
          <TabsTrigger value="a" asChild>
            <a href="#a">链接分页</a>
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const tab = screen.getByRole("tab", { name: "链接分页" });
    expect(tab.tagName).toBe("A");
  });

  it("count 为 0 时仍渲染计数签", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList variant="card">
          <TabsTrigger value="a" count={0}>
            邀请中
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole("tab").querySelector("[data-tab-count]")!.textContent).toBe("0");
  });
});
