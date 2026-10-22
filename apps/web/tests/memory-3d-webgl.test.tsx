import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";
import { memoryProjection } from "../src/features/memory-workspace/memory-3d.js";
import { MEMORY_GL_TEXTURE_WIDTH, MemoryGraphGL } from "../src/features/memory-workspace/memory-3d-webgl.js";
import { buildMemoryGraph3DData } from "../src/features/memory-workspace/memory-graph-3d-data.js";
import { createSyntheticMemoryGraph } from "../src/features/memory-workspace/memory-graph-synthetic.js";

type Call = { name: string; args: unknown[] };
/** A WebGL2 context that records calls; enough to check what the renderer submits per frame. */
function fakeWebGL2(canvas: HTMLCanvasElement) {
  const calls: Call[] = [];
  let lost = false;
  let id = 0;
  const values: Record<string, unknown> = {
    canvas,
    isContextLost: () => lost,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getExtension: () => null,
    getParameter: () => "Fake WebGL2",
    getUniformLocation: (_program: unknown, name: string) => ({ name })
  };
  const gl = new Proxy({}, {
    get(_target, property: string) {
      if (property in values) return typeof values[property] === "function" ? (...args: unknown[]) => { calls.push({ name: property, args }); return (values[property] as (...a: unknown[]) => unknown)(...args); } : values[property];
      if (/^[A-Z0-9_]+$/.test(property)) return property;
      return (...args: unknown[]) => { calls.push({ name: property, args }); return /^create/.test(property) ? { id: ++id } : undefined; };
    }
  });
  return { gl: gl as unknown as WebGL2RenderingContext, calls, lose: () => { lost = true; }, restore: () => { lost = false; } };
}

describe("WebGL2 memory graph renderer", () => {
  it("draws all nodes in one instanced call and all edges in one batched call per pass", () => {
    const canvas = document.createElement("canvas");
    const fake = fakeWebGL2(canvas);
    vi.spyOn(canvas, "getContext").mockImplementation(((kind: string) => kind === "webgl2" ? fake.gl : null) as typeof canvas.getContext);
    const renderer = MemoryGraphGL.create(canvas)!;
    expect(renderer).not.toBeNull();
    const { nodes, edges } = createSyntheticMemoryGraph(50_000);
    const { data } = buildMemoryGraph3DData(nodes, edges);
    renderer.setGraph(data);
    renderer.setPositions(new Float32Array(data.count * 4));
    fake.calls.length = 0;
    renderer.draw(memoryProjection({ yaw: 0.3, pitch: -0.15, zoom: 1 }, 1, 1280, 800), 2, 400, false);
    const draws = fake.calls.filter(call => call.name.startsWith("draw"));
    expect(draws).toEqual([
      { name: "drawArrays", args: ["LINES", 0, data.edgeCount * 2] },
      { name: "drawArraysInstanced", args: ["TRIANGLE_STRIP", 0, 4, data.count] },
      { name: "drawArraysInstanced", args: ["TRIANGLE_STRIP", 0, 4, data.count] }
    ]);
    expect(data.edgeCount).toBeGreaterThan(140_000);
    // Depth is resolved by the GPU depth test, not by sorting on the CPU.
    expect(fake.calls.some(call => call.name === "enable" && call.args[0] === "DEPTH_TEST")).toBe(true);
    // Focus adds the dimmed pass; the focus itself is a texture upload, not new geometry.
    fake.calls.length = 0;
    renderer.setState(new Uint8Array(data.count).fill(1, 0, 1));
    renderer.draw(memoryProjection({ yaw: 0.3, pitch: -0.15, zoom: 1 }, 1, 1280, 800), 2, 400, true);
    expect(fake.calls.filter(call => call.name === "drawArraysInstanced")).toHaveLength(3);
    expect(fake.calls.filter(call => call.name === "bufferData")).toHaveLength(0);
    expect(fake.calls.find(call => call.name === "texSubImage2D")!.args.slice(4, 6)).toEqual([MEMORY_GL_TEXTURE_WIDTH, Math.ceil(data.count / MEMORY_GL_TEXTURE_WIDTH)]);
  });

  it("returns null when WebGL2 is unavailable", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    expect(MemoryGraphGL.create(canvas)).toBeNull();
  });
});

describe("MemoryGraph3D", () => {
  let fake: ReturnType<typeof fakeWebGL2> | null = null;
  let webgl = true;
  beforeEach(() => {
    webgl = true;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, kind: string) {
      if (kind !== "webgl2" || !webgl) return null;
      fake = fakeWebGL2(this);
      return fake.gl;
    } as typeof HTMLCanvasElement.prototype.getContext);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); fake = null; });

  const surface = () => document.querySelector(".memory-3d-surface") as HTMLElement;
  const canvas = () => document.querySelector("canvas[role=application]") as HTMLCanvasElement;

  it("keeps the accessible canvas, keyboard rotation and zoom, and the data attributes", async () => {
    render(<MemoryGraph3D source={null} showTitles selectedNodeId={null} onSelectNode={() => {}} loading resetToken={0} />);
    const element = canvas();
    expect(element.tabIndex).toBe(0);
    expect(element.getAttribute("aria-label")).toMatch(/3D memory graph/);
    expect(element.getAttribute("aria-busy")).toBe("true");
    expect(element.dataset.titlesVisible).toBe("true");
    expect(element.dataset.layoutVolume).toBe("0.0000");
    expect(surface().dataset.renderer).toBe("webgl2");
    await act(async () => { fireEvent.keyDown(element, { key: "ArrowRight" }); await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(element.dataset.rotation).toBe("0.450,-0.150");
    await act(async () => { fireEvent.keyDown(element, { key: "+" }); await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(element.dataset.zoom).toBe("1.150");
    await act(async () => { fireEvent.keyDown(element, { key: "-" }); await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(element.dataset.zoom).toBe("1.000");
  });

  it("falls back to Canvas 2D without WebGL2 and after a context loss, and returns when restored", async () => {
    webgl = false;
    const { unmount } = render(<MemoryGraph3D source={null} showTitles={false} selectedNodeId={null} onSelectNode={() => {}} loading={false} resetToken={0} />);
    expect(surface().dataset.renderer).toBe("canvas2d");
    expect(canvas().dataset.titlesVisible).toBe("false");
    unmount();
    webgl = true;
    render(<MemoryGraph3D source={null} showTitles selectedNodeId={null} onSelectNode={() => {}} loading={false} resetToken={0} />);
    expect(surface().dataset.renderer).toBe("webgl2");
    const lost = new Event("webglcontextlost", { cancelable: true });
    await act(async () => { fake!.lose(); canvas().dispatchEvent(lost); });
    expect(lost.defaultPrevented).toBe(true);
    expect(surface().dataset.renderer).toBe("canvas2d");
    fake!.calls.length = 0;
    await act(async () => { fake!.restore(); canvas().dispatchEvent(new Event("webglcontextrestored")); });
    expect(surface().dataset.renderer).toBe("webgl2");
    expect(fake!.calls.filter(call => call.name === "createProgram")).toHaveLength(2);
  });
});
