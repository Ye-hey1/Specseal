import type { ChangeItem } from "./adapter";
import { changeStage, planBlockedBy, planWave, type Stage } from "./stage";

/** 路线图上的一站（spec desktop-roadmap「路线图依波次排列变更」）。 */
export interface RoadmapStation {
  name: string;
  stage: Stage;
  completedTasks: number;
  totalTasks: number;
  blockedBy: string[];
  /** 站名等于 plan 的 next。 */
  next: boolean;
}

export interface RoadmapWave {
  wave: number;
  stations: RoadmapStation[];
}

/** 一条依赖线：前置（from）连到依赖它的站（to）。 */
export interface RoadmapEdge {
  from: string;
  to: string;
}

export interface RoadmapModel {
  waves: RoadmapWave[];
  edges: RoadmapEdge[];
  /** 没有波次（metadata 无法解析）的变更名，只在看板显示。 */
  unplaced: string[];
}

/** 线的键（`from→to`）：路线高亮与 SVG 叠层共用。 */
export function roadmapEdgeKey(edge: RoadmapEdge): string {
  return `${edge.from}→${edge.to}`;
}

/** 清单项（plan 的配置序）→ 波次栏、站、线与无法调度项；波内维持清单顺序。 */
export function roadmapModel(changes: readonly ChangeItem[], next: string | null): RoadmapModel {
  const byWave = new Map<number, RoadmapStation[]>();
  const placed = new Set<string>();
  const unplaced: string[] = [];
  for (const change of changes) {
    const wave = planWave(change);
    if (wave === null) {
      unplaced.push(change.name);
      continue;
    }
    placed.add(change.name);
    const stations = byWave.get(wave) ?? [];
    stations.push({
      name: change.name,
      stage: changeStage(change),
      completedTasks: change.completedTasks,
      totalTasks: change.totalTasks,
      blockedBy: planBlockedBy(change),
      next: change.name === next,
    });
    byWave.set(wave, stations);
  }
  const edges = changes.flatMap((change) =>
    placed.has(change.name)
      ? (change.dependsOn ?? []).filter((dep) => placed.has(dep)).map((dep) => ({ from: dep, to: change.name }))
      : [],
  );
  const waves = [...byWave.entries()].sort(([a], [b]) => a - b).map(([wave, stations]) => ({ wave, stations }));
  return { waves, edges, unplaced };
}

/** 自 `start` 沿线的 `along` 端走到 `toward` 端，收集走得到的全部站（含 `start`）。 */
function reach(edges: readonly RoadmapEdge[], start: string, along: "from" | "to", toward: "from" | "to"): Set<string> {
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const edge of edges) {
      if (edge[along] === current && !seen.has(edge[toward])) {
        seen.add(edge[toward]);
        pending.push(edge[toward]);
      }
    }
  }
  return seen;
}

/** 停在 `name` 时亮起的路线：该站、递移前置、递移依赖者，以及两端都在这组站内的线。 */
export function roadmapRoute(
  model: RoadmapModel,
  name: string,
): { stations: Set<string>; edges: Set<string> } {
  const before = reach(model.edges, name, "to", "from");
  const after = reach(model.edges, name, "from", "to");
  const stations = new Set([...before, ...after]);
  const edges = new Set(
    model.edges.filter((e) => stations.has(e.from) && stations.has(e.to)).map(roadmapEdgeKey),
  );
  return { stations, edges };
}
