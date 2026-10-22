import { describe, expect, it } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { layoutMemoryNetwork3D, memory3DVolumeRatio, memory3DVolumeRatioPacked, type MemoryPoint3D } from "../src/features/memory-workspace/memory-3d.js";
import { createMemoryLayout3D, MEMORY_3D_LAYOUT_STEPS } from "../src/features/memory-workspace/memory-3d-layout.js";
import { isMemoryCoreLabel } from "../src/features/memory-workspace/memory-graph-visuals.js";
import { createSyntheticMemoryGraph } from "../src/features/memory-workspace/memory-graph-synthetic.js";

// The layout as it was before streaming (string-keyed grid rebuilt each step), kept as the reference.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};
function referenceLayout(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const points = ordered.map(node => ({ x: (unit(`${node.id}:x`) - 0.5) * 260, y: (unit(`${node.id}:y`) - 0.5) * 260, z: (unit(`${node.id}:z`) - 0.5) * 260 }));
  if (root >= 0) points[root] = { x: 0, y: 0, z: 0 };
  const links = [...edges].sort((a, b) => a.id.localeCompare(b.id)).flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{ a, b, length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55, strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004 }];
  });
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const parent = points[a]!, id = ordered[b]!.id;
    points[b] = { x: parent.x + (unit(`${id}:dx`) - 0.5) * 70, y: parent.y + (unit(`${id}:dy`) - 0.5) * 70, z: parent.z + (unit(`${id}:dz`) - 0.5) * 70 };
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  for (let step = 0; step < 180; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    const grid = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const p = points[i]!, key = `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(i);
    }
    for (let i = 0; i < count; i++) {
      const p = points[i]!, gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
        for (const j of grid.get(`${x},${y},${z}`) ?? []) {
          if (j <= i) continue;
          const q = points[j]!, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
          const strength = (ordered[i]!.type === "SOURCE" || ordered[j]!.type === "SOURCE" ? 28 : 12) / Math.max(1, dx * dx + dy * dy + dz * dz);
          fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
        }
      }
    }
    for (const link of links) {
      const a = points[link.a]!, b = points[link.b]!;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - link.length) * link.strength / distance;
      fx[link.a]! += dx * spring; fy[link.a]! += dy * spring; fz[link.a]! += dz * spring;
      fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring; fz[link.b]! -= dz * spring;
    }
    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const p = points[i]!;
      const dx = fx[i]! - p.x * 0.0005, dy = fy[i]! - p.y * 0.0005, dz = fz[i]! - p.z * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      p.x += dx * stepScale; p.y += dy * stepScale; p.z += dz * stepScale;
    }
  }
  return new Map(ordered.map((node, i) => [node.id, points[i]!]));
}

describe("streamed 3D layout", () => {
  it("reproduces the previous layout exactly up to 2,000 nodes", () => {
    for (const size of [40, 600, 2000]) {
      const { nodes, edges } = createSyntheticMemoryGraph(size);
      expect([...layoutMemoryNetwork3D(nodes, edges)]).toEqual([...referenceLayout(nodes, edges)]);
    }
  });

  it("streams: advancing in slices ends where a single run ends", () => {
    const { nodes, edges } = createSyntheticMemoryGraph(1200);
    const whole = createMemoryLayout3D(nodes, edges);
    whole.advance(MEMORY_3D_LAYOUT_STEPS);
    const sliced = createMemoryLayout3D(nodes, edges);
    const steps: number[] = [];
    while (!sliced.advance(7)) steps.push(sliced.step);
    expect(steps[0]).toBe(7);
    expect(steps.every((step, i) => i === 0 || step > steps[i - 1]!)).toBe(true);
    expect(sliced.step).toBe(MEMORY_3D_LAYOUT_STEPS);
    expect(sliced.done).toBe(true);
    expect(Array.from(sliced.positions)).toEqual(Array.from(whole.positions));
    expect(sliced.advance(10)).toBe(true);
    expect(sliced.step).toBe(MEMORY_3D_LAYOUT_STEPS);
  });

  it("is deterministic under input reordering at 10,000 nodes and keeps a 3D volume", () => {
    const { nodes, edges } = createSyntheticMemoryGraph(10_000);
    const a = createMemoryLayout3D(nodes, edges), b = createMemoryLayout3D([...nodes].reverse(), [...edges].reverse());
    a.advance(40); b.advance(40);
    expect(b.ids).toEqual(a.ids);
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    expect(memory3DVolumeRatioPacked(a.positions, a.ids.length)).toBeGreaterThan(0.35);
  });

  it("scales the starting volume with the node count so the repulsion grid stays sparse", () => {
    const extent = (size: number) => {
      const { nodes, edges } = createSyntheticMemoryGraph(size);
      const layout = createMemoryLayout3D(nodes, edges);
      let max = 0;
      for (let i = 0; i < layout.ids.length; i++) max = Math.max(max, Math.abs(layout.positions[i * 3]!));
      return max;
    };
    expect(extent(2000)).toBeLessThan(170);
    expect(extent(16_000) / extent(2000)).toBeGreaterThan(1.5);
  });

  it("computes the same volume ratio from packed coordinates", () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: Math.sin(i) * 40, y: Math.cos(i * 1.7) * 30, z: (i % 7) * 9 }));
    const packed = new Float32Array(points.length * 4);
    points.forEach((p, i) => packed.set([p.x, p.y, p.z, 1], i * 4));
    expect(memory3DVolumeRatioPacked(packed, points.length, 4)).toBeCloseTo(memory3DVolumeRatio(points), 4);
    expect(createMemoryLayout3D([], []).advance(5)).toBe(true);
  });
});
