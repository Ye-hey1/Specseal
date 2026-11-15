// spec desktop-roadmap「路线图依波次排列变更」「路线图画出依赖线并亮起路线」：分组、
// 连接与路线的判定是纯函数（design「路线图模型为纯函数」），版面量测不在这里。
import { describe, it, expect } from "vitest";
import { roadmapModel, roadmapRoute } from "../roadmapModel";
import type { ChangeItem } from "../adapter";

/** 带调度字段的清单项；`wave` 为 undefined 表示 plan 没排到（坏 metadata）。 */
function item(
  name: string,
  wave: number | undefined,
  tasks: [done: number, total: number],
  dependsOn: string[] = [],
  blockedBy: string[] = [],
): ChangeItem {
  const [completedTasks, totalTasks] = tasks;
  const base: ChangeItem = { name, status: "x", totalTasks, completedTasks };
  return wave === undefined ? base : { ...base, wave, dependsOn, blockedBy };
}

describe("roadmapModel", () => {
  it("依波次升幂分组、波内维持清单顺序，next 只标在同名站（Scenario「两波与下一个」）", () => {
    // 清单顺序即 plan 的配置序：add-a、add-c 在第 1 波，add-b 在第 2 波。
    const model = roadmapModel(
      [
        item("add-b", 2, [0, 3], ["add-a"], ["add-a"]),
        item("add-a", 1, [0, 4]),
        item("add-c", 1, [2, 5]),
      ],
      "add-a",
    );
    expect(model.waves.map((w) => w.wave)).toEqual([1, 2]);
    expect(model.waves[0].stations.map((s) => s.name)).toEqual(["add-a", "add-c"]);
    expect(model.waves[1].stations.map((s) => s.name)).toEqual(["add-b"]);
    const flagged = model.waves.flatMap((w) => w.stations).filter((s) => s.next);
    expect(flagged.map((s) => s.name)).toEqual(["add-a"]);
    expect(model.unplaced).toEqual([]);
  });

  it("next 为 null 时没有站带下一个标记", () => {
    const model = roadmapModel([item("add-a", 1, [0, 4])], null);
    expect(model.waves[0].stations[0].next).toBe(false);
  });

  // Example「站的阶段文本」：阶段沿用 changeStage、阻挡沿用 planBlockedBy。
  it.each([
    { name: "add-a", tasks: [0, 4] as [number, number], blockedBy: [], stage: "proposed" },
    { name: "add-c", tasks: [2, 5] as [number, number], blockedBy: [], stage: "in-progress" },
    { name: "add-d", tasks: [6, 6] as [number, number], blockedBy: [], stage: "ready" },
    { name: "add-b", tasks: [0, 3] as [number, number], blockedBy: ["add-a"], stage: "proposed" },
  ])("站的阶段：$name → $stage", ({ name, tasks, blockedBy, stage }) => {
    const model = roadmapModel([item(name, 1, tasks, blockedBy, blockedBy)], null);
    const station = model.waves[0].stations[0];
    expect(station).toEqual({
      name,
      stage,
      completedTasks: tasks[0],
      totalTasks: tasks[1],
      blockedBy,
      next: false,
    });
  });

  it("没有 wave 的变更进 unplaced、不成为站（Scenario「无法调度的变更不成为站」）", () => {
    const model = roadmapModel(
      [item("good-a", 1, [0, 1]), item("broken-meta", undefined, [0, 1]), item("good-b", 1, [0, 1])],
      null,
    );
    expect(model.waves.flatMap((w) => w.stations).map((s) => s.name)).toEqual(["good-a", "good-b"]);
    expect(model.unplaced).toEqual(["broken-meta"]);
  });

  it("连接只收两端都在路线图上的 dependsOn：前置连到依赖者", () => {
    const model = roadmapModel(
      [
        item("add-a", 1, [0, 1]),
        item("add-x", 1, [0, 1]),
        item("broken-meta", undefined, [0, 1]),
        item("add-b", 2, [0, 1], ["add-a"], ["add-a"]),
        // 前置一个无法调度、一个已封存（不在清单）——两条都不画。
        item("add-c", 3, [0, 1], ["add-b", "broken-meta", "archived-one"], ["add-b"]),
      ],
      null,
    );
    expect(model.edges).toEqual([
      { from: "add-a", to: "add-b" },
      { from: "add-b", to: "add-c" },
    ]);
  });

  it("前置已封存时没有线（Scenario「前置已封存时不画线」）", () => {
    // 引擎的 blockedBy 只含作用中的前置：add-a 已封存，add-b 不再被挡。
    const model = roadmapModel([item("add-b", 1, [0, 3], ["add-a"], [])], null);
    expect(model.edges).toEqual([]);
    expect(model.waves[0].stations[0].blockedBy).toEqual([]);
  });

  it("空清单没有波次、线与无法调度项", () => {
    expect(roadmapModel([], null)).toEqual({ waves: [], edges: [], unplaced: [] });
  });
});

describe("roadmapRoute", () => {
  // Scenario「停在中间的站亮起整条路线」：add-b depends_on add-a、add-c depends_on add-b，
  // add-x 与三者无依赖。
  const model = roadmapModel(
    [
      item("add-a", 1, [0, 1]),
      item("add-x", 1, [0, 1]),
      item("add-b", 2, [0, 1], ["add-a"], ["add-a"]),
      item("add-c", 3, [0, 1], ["add-b"], ["add-b"]),
    ],
    null,
  );

  // Example「路线的范围」。
  it.each([
    { hover: "add-b", stations: ["add-a", "add-b", "add-c"], edges: ["add-a→add-b", "add-b→add-c"] },
    { hover: "add-a", stations: ["add-a", "add-b", "add-c"], edges: ["add-a→add-b", "add-b→add-c"] },
    { hover: "add-c", stations: ["add-a", "add-b", "add-c"], edges: ["add-a→add-b", "add-b→add-c"] },
    { hover: "add-x", stations: ["add-x"], edges: [] },
  ])("停在 $hover：递移前置、递移依赖者与其间的线", ({ hover, stations, edges }) => {
    const route = roadmapRoute(model, hover);
    expect([...route.stations].sort()).toEqual(stations);
    expect([...route.edges].sort()).toEqual(edges);
  });

  it("两条分支只亮起停留站所在的那条", () => {
    // add-d 与 add-e 都依赖 add-a；停在 add-d 时 add-e 与 add-a→add-e 不在路在线。
    const forked = roadmapModel(
      [
        item("add-a", 1, [0, 1]),
        item("add-d", 2, [0, 1], ["add-a"], ["add-a"]),
        item("add-e", 2, [0, 1], ["add-a"], ["add-a"]),
      ],
      null,
    );
    const route = roadmapRoute(forked, "add-d");
    expect([...route.stations].sort()).toEqual(["add-a", "add-d"]);
    expect([...route.edges]).toEqual(["add-a→add-d"]);
  });
});
