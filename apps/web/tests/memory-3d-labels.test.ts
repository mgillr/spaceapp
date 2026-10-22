import { describe, expect, it } from "vitest";
import { MEMORY_NODE_OTHER, MEMORY_NODE_ROOT, MEMORY_NODE_SOURCE } from "../src/features/memory-workspace/memory-3d.js";
import { MEMORY_3D_LABEL_BUDGET, MEMORY_3D_LABEL_CANDIDATES, memoryLabelText, selectMemoryLabels } from "../src/features/memory-workspace/memory-3d-labels.js";

function graph(count: number) {
  const kinds = new Uint8Array(count), core = new Uint8Array(count), labels: string[] = [];
  for (let i = 0; i < count; i++) {
    kinds[i] = i === 0 ? MEMORY_NODE_ROOT : i % 50 === 0 ? MEMORY_NODE_SOURCE : MEMORY_NODE_OTHER;
    core[i] = i === 0 ? 1 : 0;
    labels.push(i === 0 ? "gemini.md" : `node ${i}`);
  }
  const priority = Uint32Array.from([0, ...Array.from({ length: count }, (_, i) => i).filter(i => kinds[i] === MEMORY_NODE_SOURCE)]);
  // A grid of distinct screen positions, 40 px apart, so labels do not collide unless placed together.
  const position = (i: number) => ({ x: 20 + (i % 40) * 40 * 5, y: 30 + Math.floor(i / 40) % 200 * 20 });
  return { kinds, core, labels, priority, position };
}

describe("3D label level of detail", () => {
  it("measures at most the label budget per frame, whatever the graph size", () => {
    for (const count of [2000, 50_000, 150_000]) {
      const g = graph(count);
      let measured = 0;
      const result = selectMemoryLabels({ ...g, focus: -1, nearby: Uint32Array.from({ length: count }, (_, i) => i), zoom: 3, width: 1e6, height: 1e6, measure: () => { measured++; return 30; } });
      expect(measured).toBeLessThanOrEqual(MEMORY_3D_LABEL_BUDGET);
      expect(result.measured).toBe(measured);
      expect(result.examined).toBeLessThanOrEqual(MEMORY_3D_LABEL_CANDIDATES);
      expect(result.labels.length).toBeLessThanOrEqual(MEMORY_3D_LABEL_BUDGET);
    }
  });

  it("keeps the order: focus, core files, other files, then records", () => {
    const g = graph(2000);
    const order: number[] = [];
    selectMemoryLabels({ ...g, focus: 777, nearby: Uint32Array.from([5, 6, 7]), zoom: 2, width: 1e6, height: 1e6, measure: () => 10, position: i => { order.push(i); return g.position(i); } });
    expect(order[0]).toBe(777);
    expect(order[1]).toBe(0);
    expect(order[2]).toBe(50);
    expect(order.slice(-3)).toEqual([5, 6, 7]);
  });

  it("shows record titles only from zoom 1.6, files and the focus always", () => {
    const g = graph(500);
    const at = (zoom: number) => selectMemoryLabels({ ...g, focus: 3, nearby: Uint32Array.from([1, 2]), zoom, width: 1e6, height: 1e6, measure: () => 10 }).labels.map(label => label.index);
    expect(at(1)).toContain(3);
    expect(at(1)).toContain(0);
    expect(at(1)).toContain(50);
    expect(at(1)).not.toContain(1);
    expect(at(1.6)).toContain(1);
  });

  it("avoids collisions and labels that would leave the canvas", () => {
    const kinds = new Uint8Array([MEMORY_NODE_SOURCE, MEMORY_NODE_SOURCE, MEMORY_NODE_SOURCE, MEMORY_NODE_SOURCE]);
    const spots = [{ x: 100, y: 100 }, { x: 110, y: 105 }, { x: 100, y: 140 }, { x: 790, y: 300 }];
    const result = selectMemoryLabels({ focus: -1, priority: [0, 1, 2, 3], nearby: null, kinds, core: new Uint8Array(4), labels: ["a.md", "b.md", "c.md", "d.md"], zoom: 1, width: 800, height: 600, position: i => spots[i]!, measure: () => 40 });
    expect(result.labels.map(label => label.index)).toEqual([0, 2]);
    expect(result.labels[0]).toMatchObject({ x: 109, y: 100, w: 40 });
  });

  it("truncates long titles as before and marks core labels", () => {
    expect(memoryLabelText("x".repeat(48))).toBe("x".repeat(48));
    expect(memoryLabelText("y".repeat(60))).toBe(`${"y".repeat(45)}…`);
    const g = graph(100);
    expect(selectMemoryLabels({ ...g, focus: -1, nearby: null, zoom: 1, width: 1e6, height: 1e6, measure: () => 10 }).labels[0]).toMatchObject({ index: 0, core: true, text: "gemini.md" });
  });
});
