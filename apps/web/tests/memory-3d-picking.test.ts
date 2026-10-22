import { describe, expect, it } from "vitest";
import { MEMORY_NODE_OTHER, MEMORY_NODE_ROOT, MEMORY_NODE_SOURCE, memoryNodeRadius, memoryProjection, projectMemoryPointInto, type MemoryProjection } from "../src/features/memory-workspace/memory-3d.js";
import { MemoryPickIndex, MemoryRayPickIndex } from "../src/features/memory-workspace/memory-3d-picking.js";

function randomGraph(count: number, seed = 7) {
  let state = seed;
  const random = () => { state = Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9 | 0; return ((state >>> 0) % 1_000_000) / 1_000_000; };
  const positions = new Float32Array(count * 4), kinds = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    positions.set([(random() - 0.5) * 1400, (random() - 0.5) * 1400, (random() - 0.5) * 1400, 1], i * 4);
    kinds[i] = i === 0 ? MEMORY_NODE_ROOT : i % 40 === 0 ? MEMORY_NODE_SOURCE : MEMORY_NODE_OTHER;
  }
  return { positions, kinds, random };
}

// The linear hit test of the Canvas 2D renderer: the frontmost node within max(7, radius + 3).
function linearPick(positions: Float32Array, kinds: Uint8Array, count: number, view: MemoryProjection, x: number, y: number, focus = -1, subset?: number[]) {
  const point = { x: 0, y: 0, z: 0, perspective: 1 };
  let best = -1, bestZ = Infinity;
  for (const i of subset ?? Array.from({ length: count }, (_, k) => k)) {
    projectMemoryPointInto(view, positions[i * 4]!, positions[i * 4 + 1]!, positions[i * 4 + 2]!, point);
    const radius = Math.max(7, memoryNodeRadius(kinds[i]!, point.perspective, view.zoom, i === focus) + 3);
    if (Math.hypot(point.x - x, point.y - y) < radius && (point.z < bestZ || (point.z === bestZ && i > best))) { best = i; bestZ = point.z; }
  }
  return best;
}

describe("3D picking index", () => {
  it("returns the same node as a linear scan at 50,000 nodes for many cameras and pointers", () => {
    const count = 50_000;
    const { positions, kinds, random } = randomGraph(count);
    const index = new MemoryPickIndex();
    let hits = 0, maxCandidates = 0, totalCandidates = 0, picks = 0;
    for (const camera of [{ yaw: 0.3, pitch: -0.15, zoom: 1 }, { yaw: 2.4, pitch: 0.9, zoom: 3.5 }, { yaw: -1, pitch: 0.2, zoom: 0.4 }]) {
      const view = memoryProjection(camera, 0.35, 1280, 800);
      index.rebuild(positions, 4, kinds, count, view, 17);
      for (let k = 0; k < 100; k++) {
        const x = random() * 1280, y = random() * 800;
        const expected = linearPick(positions, kinds, count, view, x, y, 17);
        expect(index.pick(x, y)).toBe(expected);
        if (expected >= 0) hits++;
        maxCandidates = Math.max(maxCandidates, index.lastCandidates);
        totalCandidates += index.lastCandidates; picks++;
      }
    }
    expect(hits).toBeGreaterThan(50);
    // A pick visits the cells under the pointer, not every node.
    // Even with the whole graph zoomed out into the middle of the screen, a pick visits under a tenth.
    expect(maxCandidates).toBeLessThan(count / 10);
    expect(totalCandidates / picks).toBeLessThan(count / 50);
  });

  it("picks the frontmost of overlapping nodes and nothing on empty space", () => {
    const positions = new Float32Array([0, 0, 50, 1, 0, 0, -50, 1, 400, 400, 0, 1]);
    const kinds = new Uint8Array([MEMORY_NODE_OTHER, MEMORY_NODE_OTHER, MEMORY_NODE_SOURCE]);
    const index = new MemoryPickIndex();
    index.rebuild(positions, 4, kinds, 3, memoryProjection({ yaw: 0, pitch: 0, zoom: 1 }, 1, 800, 600));
    expect(index.pick(400, 300)).toBe(1);
    expect(index.pick(10, 10)).toBe(-1);
    expect(index.visibleCount).toBe(2);
    expect(Array.from(index.frontToBack(10))).toEqual([1, 0]);
  });

  it("only considers the given subset (the Canvas 2D fallback's capped nodes)", () => {
    const { positions, kinds, random } = randomGraph(5000, 3);
    const subset = Array.from({ length: 2000 }, (_, i) => i * 2);
    const view = memoryProjection({ yaw: 0.8, pitch: -0.3, zoom: 1.5 }, 0.35, 1000, 700);
    const index = new MemoryPickIndex();
    index.rebuild(positions, 4, kinds, 5000, view, -1, subset);
    for (let k = 0; k < 200; k++) {
      const x = random() * 1000, y = random() * 700;
      const picked = index.pick(x, y);
      expect(picked).toBe(linearPick(positions, kinds, 5000, view, x, y, -1, subset));
      if (picked >= 0) expect(picked % 2).toBe(0);
    }
  });

  it("the world-space ray index returns the same node as a linear scan, without re-indexing when the camera moves", () => {
    const count = 50_000;
    const { positions, kinds, random } = randomGraph(count, 11);
    const index = new MemoryRayPickIndex();
    index.rebuild(positions, 4, count);
    let hits = 0, maxCandidates = 0, totalCandidates = 0, picks = 0;
    // Includes the zoom limits (0.35x and 5x) and a scale where the nearest nodes reach the perspective clamp.
    const cameras = [
      { camera: { yaw: 0.3, pitch: -0.15, zoom: 1 }, scale: 0.35 }, { camera: { yaw: 2.4, pitch: 0.9, zoom: 3.5 }, scale: 0.35 },
      { camera: { yaw: -1, pitch: 0.2, zoom: 0.35 }, scale: 0.35 }, { camera: { yaw: 4, pitch: -1.2, zoom: 5 }, scale: 0.35 },
      { camera: { yaw: 1.1, pitch: 0.4, zoom: 0.6 }, scale: 1.5 }
    ];
    for (const { camera, scale } of cameras) {
      const view = memoryProjection(camera, scale, 1280, 800);
      for (let k = 0; k < 120; k++) {
        const x = random() * 1280, y = random() * 800, focus = k % 3 === 0 ? 17 : -1;
        const expected = linearPick(positions, kinds, count, view, x, y, focus);
        expect(index.pick(view, kinds, x, y, focus)).toBe(expected);
        if (expected >= 0) hits++;
        maxCandidates = Math.max(maxCandidates, index.lastCandidates);
        totalCandidates += index.lastCandidates; picks++;
      }
    }
    expect(hits).toBeGreaterThan(100);
    expect(maxCandidates).toBeLessThan(count / 5);
    expect(totalCandidates / picks).toBeLessThan(count / 20);
  });

  it("the world-space ray index picks the frontmost node, nothing on empty space, and respects a subset", () => {
    const positions = new Float32Array([0, 0, 50, 1, 0, 0, -50, 1, 400, 400, 0, 1]);
    const kinds = new Uint8Array([MEMORY_NODE_OTHER, MEMORY_NODE_OTHER, MEMORY_NODE_SOURCE]);
    const index = new MemoryRayPickIndex();
    const view = memoryProjection({ yaw: 0, pitch: 0, zoom: 1 }, 1, 800, 600);
    index.rebuild(positions, 4, 3);
    expect(index.pick(view, kinds, 400, 300)).toBe(1);
    expect(index.pick(view, kinds, 10, 10)).toBe(-1);
    index.rebuild(positions, 4, 3, [0, 2]);
    expect(index.pick(view, kinds, 400, 300)).toBe(0);
    index.rebuild(positions, 4, 3, []);
    expect(index.pick(view, kinds, 400, 300)).toBe(-1);
  });
});
