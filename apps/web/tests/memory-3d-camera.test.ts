import { describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_CAMERA, MEMORY_NODE_OTHER, MEMORY_NODE_ROOT, MEMORY_NODE_SOURCE, memoryGraphExtent, memoryGraphScale, memoryNodeRadius, memoryProjection, projectMemoryPoint, projectMemoryPointInto } from "../src/features/memory-workspace/memory-3d.js";

describe("3D camera and projection", () => {
  it("projects exactly like projectMemoryPoint for any camera", () => {
    const out = { x: 0, y: 0, z: 0, perspective: 0 };
    for (const camera of [DEFAULT_MEMORY_CAMERA, { yaw: 2.1, pitch: 0.7, zoom: 3.2 }, { yaw: -5, pitch: -1.4, zoom: 0.35 }]) {
      for (const point of [{ x: 0, y: 0, z: 0 }, { x: 120, y: -40, z: 75 }, { x: -300, y: 260, z: -90 }]) {
        const expected = projectMemoryPoint(point, camera, 1.7, 1280, 720);
        projectMemoryPointInto(memoryProjection(camera, 1.7, 1280, 720), point.x, point.y, point.z, out);
        expect(out.x).toBeCloseTo(expected.x, 9); expect(out.y).toBeCloseTo(expected.y, 9);
        expect(out.z).toBeCloseTo(expected.z, 9); expect(out.perspective).toBeCloseTo(expected.perspective, 9);
      }
    }
  });

  it("keeps the origin at the centre and zoom scaling about it", () => {
    const view = memoryProjection({ yaw: 1, pitch: 0.4, zoom: 2 }, 2, 1000, 600);
    const out = projectMemoryPointInto(view, 0, 0, 0, { x: 0, y: 0, z: 0, perspective: 0 });
    expect(out).toMatchObject({ x: 500, y: 300, z: 0, perspective: 1 });
    const near = projectMemoryPointInto(memoryProjection({ yaw: 0, pitch: 0, zoom: 1 }, 1, 1000, 600), 10, 0, 0, { x: 0, y: 0, z: 0, perspective: 0 }).x - 500;
    const far = projectMemoryPointInto(memoryProjection({ yaw: 0, pitch: 0, zoom: 2 }, 1, 1000, 600), 10, 0, 0, { x: 0, y: 0, z: 0, perspective: 0 }).x - 500;
    expect(far).toBeCloseTo(near * 2, 9);
  });

  it("sizes the graph to the viewport and nodes as before", () => {
    expect(memoryGraphScale(200, 1000, 600)).toBeCloseTo(1.2);
    expect(memoryGraphScale(10, 1000, 600)).toBeCloseTo(4);
    expect(memoryGraphExtent(new Float32Array([3, 4, 0, 1, 0, 0, 120, 1]), 2, 4)).toBe(120);
    expect(memoryGraphExtent(new Float32Array(0), 0)).toBe(60);
    expect(memoryNodeRadius(MEMORY_NODE_ROOT, 1, 1, false)).toBe(10);
    expect(memoryNodeRadius(MEMORY_NODE_SOURCE, 1, 4, false)).toBeCloseTo(9.2);
    expect(memoryNodeRadius(MEMORY_NODE_OTHER, 1, 1, true)).toBeCloseTo(3.15);
    expect(memoryNodeRadius(MEMORY_NODE_OTHER, 0.1, 0.35, false)).toBe(1);
  });
});
