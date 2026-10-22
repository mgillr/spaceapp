import { describe, expect, it, vi } from "vitest";
import { memoryProjection } from "../src/features/memory-workspace/memory-3d.js";
import { runMemory3DBench } from "../src/features/memory-workspace/memory-3d-bench.js";
import { createMemoryRenderHost, type MemoryRenderEvent, type MemoryRenderRequest } from "../src/features/memory-workspace/memory-3d-render-host.js";
import { MemoryGraphGLWorker } from "../src/features/memory-workspace/memory-3d-render-client.js";
import type { MemoryGraphRenderer } from "../src/features/memory-workspace/memory-3d-webgl.js";

const view = memoryProjection({ yaw: 0.3, pitch: -0.15, zoom: 1 }, 1, 640, 400);
const graph = { count: 2, kinds: new Uint8Array(2), colors: new Uint8Array(8), edgeCount: 1, edgeNodes: new Uint32Array([0, 1]), edgeKinds: new Uint8Array(1) };

function fakeRenderer() {
  const calls: string[] = [];
  const renderer: MemoryGraphRenderer = {
    lost: false,
    setGraph: () => calls.push("graph"), setPositions: () => calls.push("positions"), setState: () => calls.push("state"),
    draw: () => calls.push("draw"), resize: (w, h) => calls.push(`resize ${w}x${h}`), restore: () => calls.push("restore"),
    dispose: () => calls.push("dispose"), gpu: () => "Fake GPU"
  };
  return { renderer, calls };
}

function fakeOffscreen() {
  const target = new EventTarget();
  return Object.assign(target, { width: 0, height: 0 }) as unknown as OffscreenCanvas;
}

describe("memory graph render worker host", () => {
  it("reports the GPU, draws only the newest request once per animation frame and acknowledges it", () => {
    const events: MemoryRenderEvent[] = [], frames: Array<() => void> = [];
    const { renderer, calls } = fakeRenderer();
    const handle = createMemoryRenderHost({ post: event => events.push(event), requestFrame: callback => frames.push(callback), create: () => renderer });
    handle({ type: "init", canvas: fakeOffscreen() });
    expect(events).toEqual([{ type: "ready", ok: true, gpu: "Fake GPU" }]);
    handle({ type: "resize", width: 640, height: 400 });
    handle({ type: "graph", graph });
    handle({ type: "positions", positions: new Float32Array(8) });
    for (const seq of [1, 2, 3]) handle({ type: "draw", seq, view, dpr: 1, extent: 10, hasFocus: false });
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(calls).toEqual(["resize 640x400", "graph", "positions", "draw"]);
    expect(events.at(-1)).toEqual({ type: "drawn", seq: 3 });
  });

  it("says when there is no WebGL2 so the page can fall back", () => {
    const events: MemoryRenderEvent[] = [];
    const handle = createMemoryRenderHost({ post: event => events.push(event), requestFrame: callback => callback(), create: () => null });
    handle({ type: "init", canvas: fakeOffscreen() });
    expect(events).toEqual([{ type: "ready", ok: false, gpu: null }]);
  });

  it("handles a context loss and restore on the worker's canvas and redraws the last frame", () => {
    const events: MemoryRenderEvent[] = [], frames: Array<() => void> = [];
    const { renderer, calls } = fakeRenderer();
    const canvas = fakeOffscreen();
    const handle = createMemoryRenderHost({ post: event => events.push(event), requestFrame: callback => frames.push(callback), create: () => renderer });
    handle({ type: "init", canvas });
    handle({ type: "draw", seq: 1, view, dpr: 1, extent: 10, hasFocus: false });
    frames.shift()!();
    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(events.at(-1)).toEqual({ type: "lost" });
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(events.at(-1)).toEqual({ type: "restored", ok: true });
    frames.shift()!();
    expect(calls.filter(call => call === "restore" || call === "draw")).toEqual(["draw", "restore", "draw"]);
    handle({ type: "dispose" });
    expect(calls.at(-1)).toBe("dispose");
  });
});

describe("memory graph render worker client", () => {
  function setup() {
    const posted: Array<{ message: MemoryRenderRequest; transfer: Transferable[] }> = [];
    const worker = { postMessage: (message: MemoryRenderRequest, transfer: Transferable[]) => posted.push({ message, transfer }), terminate: vi.fn(), onmessage: null, onerror: null } as unknown as Worker & { onmessage: (event: MessageEvent<MemoryRenderEvent>) => void };
    const offscreen = fakeOffscreen();
    const canvas = document.createElement("canvas");
    Object.assign(canvas, { transferControlToOffscreen: () => offscreen });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => kind === "webgl2" ? { getExtension: () => null } : null) as HTMLCanvasElement["getContext"]);
    const events = { ready: vi.fn(), lost: vi.fn(), restored: vi.fn() };
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("Worker", class {});
    const client = MemoryGraphGLWorker.create(canvas, events, () => worker)!;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const reply = (data: MemoryRenderEvent) => worker.onmessage({ data } as MessageEvent<MemoryRenderEvent>);
    return { client, posted, offscreen, events, reply, worker };
  }

  it("transfers the canvas, sends only the arrays the renderer needs and waits for the worker's draw", async () => {
    const { client, posted, offscreen, events, reply } = setup();
    expect(posted[0]).toEqual({ message: { type: "init", canvas: offscreen }, transfer: [offscreen] });
    expect(client.lost).toBe(true);
    reply({ type: "ready", ok: true, gpu: "Fake GPU" });
    expect(events.ready).toHaveBeenCalledWith(true);
    expect(client.gpu()).toBe("Fake GPU");
    client.setGraph({ ...graph, labels: ["a", "b"] } as typeof graph);
    expect(Object.keys((posted[1]!.message as { graph: object }).graph).sort()).toEqual(["colors", "count", "edgeCount", "edgeKinds", "edgeNodes", "kinds"]);
    client.draw(view, 1, 10, false);
    let done = false;
    const drawn = client.drawn().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    reply({ type: "drawn", seq: 1 });
    await drawn;
    expect(done).toBe(true);
  });

  it("does not leave the page waiting when the worker loses its context", async () => {
    const { client, events, reply } = setup();
    reply({ type: "ready", ok: true, gpu: null });
    client.draw(view, 1, 10, false);
    const drawn = client.drawn();
    reply({ type: "lost" });
    await drawn;
    expect(client.lost).toBe(true);
    expect(events.lost).toHaveBeenCalled();
    reply({ type: "restored", ok: true });
    expect(client.lost).toBe(false);
    expect(events.restored).toHaveBeenCalledWith(true);
  });

  it("is not used where a canvas cannot be transferred", () => {
    expect(MemoryGraphGLWorker.create(document.createElement("canvas"), { ready: vi.fn(), lost: vi.fn(), restored: vi.fn() })).toBeNull();
  });

  it("is not used when the page has no WebGL2, even if a worker might", () => {
    const canvas = document.createElement("canvas");
    Object.assign(canvas, { transferControlToOffscreen: () => fakeOffscreen() });
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("Worker", class {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as HTMLCanvasElement["getContext"]);
    const createWorker = vi.fn();
    expect(MemoryGraphGLWorker.create(canvas, { ready: vi.fn(), lost: vi.fn(), restored: vi.fn() }, createWorker)).toBeNull();
    expect(createWorker).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

describe("frame-time harness with a render worker", () => {
  it("times each frame until the worker has drawn it", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { setTimeout(() => callback(now), 0); return 0; });
    const result = await runMemory3DBench({
      frame: () => new Promise<void>(resolve => setTimeout(() => { now += 40; resolve(); }, 0)),
      pick: () => 0.5, size: () => ({ width: 100, height: 100 }), info: () => ({ nodes: 2, edges: 1, renderer: "webgl2", renderThread: "worker" })
    }, { entries: [] }, { frames: 5 });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(result.frames).toBe(5);
    expect(result.frameMs.p95).toBe(40);
    expect(result.renderThread).toBe("worker");
  });
});
