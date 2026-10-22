import { describe, expect, it, vi } from "vitest";
import type { MemoryGraphOverviewPayload } from "@space/contracts";
import { layoutMemoryNetwork3D } from "../src/features/memory-workspace/memory-3d.js";
import { runMemoryGraph3DJob, type MemoryGraph3DMessage } from "../src/features/memory-workspace/memory-graph-3d-job.js";
import { buildMemoryGraph3DData, MEMORY_3D_FALLBACK_EDGES, MEMORY_3D_FALLBACK_NODES, memoryFocusState } from "../src/features/memory-workspace/memory-graph-3d-data.js";
import { createSyntheticMemoryGraph } from "../src/features/memory-workspace/memory-graph-synthetic.js";

// A clock that advances 1 ms per reading, so slices are deterministic in tests.
const fakeIo = (fetchOverview: (url: string) => Promise<MemoryGraphOverviewPayload> = () => Promise.reject(new Error("no server"))) => {
  const messages: MemoryGraph3DMessage[] = [];
  let clock = 0;
  return { messages, io: { post: (message: MemoryGraph3DMessage) => { messages.push(message); }, fetchOverview, now: () => clock++, yieldToEvents: () => Promise.resolve() } };
};

describe("3D layout streaming in the worker", () => {
  it("posts the flat graph first, then streams positions until the layout converges", async () => {
    const { nodes, edges } = createSyntheticMemoryGraph(800);
    const { messages, io } = fakeIo();
    await runMemoryGraph3DJob({ type: "graph3d", id: 4, source: { kind: "inline", nodes, edges }, sliceMs: 20 }, io);
    expect(messages[0]!.type).toBe("graph3d:graph");
    const updates = messages.filter(message => message.type === "graph3d:positions");
    expect(updates.length).toBeGreaterThan(5);
    expect(updates[0]).toMatchObject({ step: 0, done: false });
    for (let k = 1; k < updates.length; k++) expect(updates[k]!.step).toBeGreaterThan(updates[k - 1]!.step);
    const last = updates.at(-1)!;
    expect(last).toMatchObject({ done: true, step: 180, totalSteps: 180, id: 4 });
    expect(last.volume).toBeGreaterThan(0.35);
    // The final stream equals the one-shot layout used by the tests above, in the graph's node order.
    const graph = messages[0] as Extract<MemoryGraph3DMessage, { type: "graph3d:graph" }>;
    const built = buildMemoryGraph3DData(nodes, edges);
    const expected = layoutMemoryNetwork3D(built.nodes, built.edges);
    expect(built.nodes.length).toBe(nodes.length);
    graph.data.ids.forEach((id, i) => {
      const p = expected.get(id)!;
      expect(Array.from(last.positions.subarray(i * 4, i * 4 + 4))).toEqual([Math.fround(p.x), Math.fround(p.y), Math.fround(p.z), 1]);
    });
  });

  it("produces the same stream for the same input", async () => {
    const { nodes, edges } = createSyntheticMemoryGraph(500);
    const run = async (reverse: boolean) => {
      const { messages, io } = fakeIo();
      await runMemoryGraph3DJob({ type: "graph3d", id: 1, source: { kind: "inline", nodes: reverse ? [...nodes].reverse() : nodes, edges: reverse ? [...edges].reverse() : edges } }, io);
      return messages.filter(message => message.type === "graph3d:positions").at(-1)!;
    };
    expect(Array.from((await run(false)).positions)).toEqual(Array.from((await run(true)).positions));
  });

  it("fetches and parses the server overview in the worker, and reports failures", async () => {
    const { nodes, edges } = createSyntheticMemoryGraph(300);
    const fetchOverview = vi.fn(async () => ({ nodes, edges, totalMatchingNodes: 9000, totalMatchingEdges: 27000, truncated: true }) as unknown as MemoryGraphOverviewPayload);
    const ok = fakeIo(fetchOverview);
    await runMemoryGraph3DJob({ type: "graph3d", id: 2, source: { kind: "http", url: "/api/admin/memory/graph/overview?limit=50000" } }, ok.io);
    expect(fetchOverview).toHaveBeenCalledWith("/api/admin/memory/graph/overview?limit=50000");
    expect(ok.messages[0]).toMatchObject({ type: "graph3d:graph", totals: { totalNodes: 9000, truncated: true } });
    const failed = fakeIo();
    await runMemoryGraph3DJob({ type: "graph3d", id: 3, source: { kind: "http", url: "/x" } }, failed.io);
    expect(failed.messages).toEqual([{ type: "graph3d:error", id: 3, message: "no server" }]);
  });

  it("generates the demo graph in the worker", async () => {
    const { messages, io } = fakeIo();
    await runMemoryGraph3DJob({ type: "graph3d", id: 5, source: { kind: "demo", nodes: 3000 }, sliceMs: 1e9 }, io);
    const graph = messages[0] as Extract<MemoryGraph3DMessage, { type: "graph3d:graph" }>;
    expect(graph.totals.totalNodes).toBe(3000);
    expect(graph.data.count).toBeGreaterThan(2900);
    expect(messages.filter(message => message.type === "graph3d:positions").at(-1)).toMatchObject({ done: true });
  });
});

describe("flat 3D graph data", () => {
  it("keeps atlas colours, adjacency and the Canvas 2D fallback caps", () => {
    const { nodes, edges } = createSyntheticMemoryGraph(10_000);
    const { data } = buildMemoryGraph3DData(nodes, edges);
    expect(data.count).toBe(data.ids.length);
    expect([...data.ids]).toEqual([...data.ids].sort(new Intl.Collator().compare));
    const root = data.ids.indexOf("source:synthetic-core");
    expect(data.kinds[root]).toBe(2);
    expect(Array.from(data.colors.subarray(root * 4, root * 4 + 4))).toEqual([0xff, 0xf0, 0xb0, 255]);
    expect(data.labelPriority[0]).toBe(root);
    expect(data.fallbackNodes.length).toBe(MEMORY_3D_FALLBACK_NODES);
    expect(data.fallbackEdges.length).toBeLessThanOrEqual(MEMORY_3D_FALLBACK_EDGES);
    const fallback = new Set(data.fallbackNodes);
    for (const e of data.fallbackEdges) { expect(fallback.has(data.edgeNodes[e * 2]!)).toBe(true); expect(fallback.has(data.edgeNodes[e * 2 + 1]!)).toBe(true); }
    const state = memoryFocusState(data, root);
    expect(state[root]).toBe(2);
    const neighbours = Array.from(state).filter(value => value === 1).length;
    expect(neighbours).toBe(data.adjacencyStart[root + 1]! - data.adjacencyStart[root]!);
    expect(neighbours).toBe(23);
    expect(Array.from(memoryFocusState(data, -1, state)).every(value => value === 0)).toBe(true);
  });
});
