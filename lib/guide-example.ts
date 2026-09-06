import type { GuideCopy, GuideKind } from "./guide-copy";

export type GuideExampleNode = { id: string; kind: GuideKind; title: string; person?: string; date?: string; metric?: [number, number]; children?: GuideExampleNode[] };

export function buildGuideTree(copy: GuideCopy): GuideExampleNode {
  const project = (index: number): GuideExampleNode => ({
    id: `project-${index}`, kind: "project", title: copy.projects[index],
    person: index < 2 ? "Alex" : "Mina", date: ["2026-10-16", "2026-10-23", "2026-10-16", "2026-10-30"][index],
    children: [0, 1].map((offset) => ({
      id: `task-${index * 2 + offset}`, kind: "task", title: copy.tasks[index * 2 + offset],
      person: offset === 0 ? "Jay" : "Robin",
    })),
  });
  return {
    id: "objective", kind: "objective", title: copy.objective,
    children: [0, 1].map((index) => ({
      id: `kr-${index}`, kind: "key_result", title: copy.metrics[index],
      metric: index === 0 ? [0.4, 0.7] : [0.6, 0.8],
      children: [{
        id: `initiative-${index}`, kind: "initiative", title: copy.initiatives[index],
        children: [project(index * 2), project(index * 2 + 1)],
      }],
    })),
  };
}
