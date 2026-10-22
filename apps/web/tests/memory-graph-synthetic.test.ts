import { describe, expect, it } from "vitest";
import { MEMORY_GRAPH_OVERVIEW_MAX_LIMIT, memoryGraphEdgeSchema, memoryGraphNodeSchema } from "@space/contracts";
import { DemoStore } from "../src/demo/DemoStore.js";
import { createSyntheticMemoryGraph, syntheticMemoryGraphSize } from "../src/features/memory-workspace/memory-graph-synthetic.js";

describe("synthetic demo memory graph", () => {
  it("generates the requested size with about three edges per node", () => {
    for (const size of [2000, 10_000, 50_000]) {
      const graph = createSyntheticMemoryGraph(size);
      expect(graph.nodes).toHaveLength(size);
      expect(graph.edges.length).toBeLessThanOrEqual(size * 3);
      expect(graph.edges.length).toBeGreaterThan(size * 2.9);
      expect(new Set(graph.nodes.map(node => node.id)).size).toBe(size);
    }
    expect(createSyntheticMemoryGraph(50_000).edges).toHaveLength(150_000);
  });

  it("is deterministic, valid against the contracts and its samples are prefixes", () => {
    const full = createSyntheticMemoryGraph(6000), again = createSyntheticMemoryGraph(6000), sample = createSyntheticMemoryGraph(6000, 2000);
    expect(again).toEqual(full);
    expect(sample.nodes).toEqual(full.nodes.slice(0, 2000));
    expect(sample.totalNodes).toBe(6000);
    expect(sample.totalEdges).toBe(full.edges.length);
    const ids = new Set(sample.nodes.map(node => node.id));
    expect(sample.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    for (const node of full.nodes.slice(0, 300)) memoryGraphNodeSchema.parse(node);
    for (const edge of full.edges) memoryGraphEdgeSchema.parse(edge);
  });

  it("reads the size from the demo URL and caps it at the server maximum", () => {
    expect(syntheticMemoryGraphSize("?memoryGraphNodes=10000")).toBe(10_000);
    expect(syntheticMemoryGraphSize("?memoryGraphNodes=999999")).toBe(MEMORY_GRAPH_OVERVIEW_MAX_LIMIT);
    expect(syntheticMemoryGraphSize("?memoryGraphNodes=abc")).toBeNull();
    expect(syntheticMemoryGraphSize("")).toBeNull();
  });

  it("serves the synthetic graph from the demo store with the same limit rules as the server", async () => {
    const store = new DemoStore(undefined, { memoryGraphNodes: 10_000 });
    const byDefault = await store.api.memoryGraphOverview({ month: "all", relationMode: "RELATIONS" });
    expect(byDefault.data.nodes).toHaveLength(2000);
    expect(byDefault.data).toMatchObject({ totalMatchingNodes: 10_000, truncated: true });
    const everything = await store.api.memoryGraphOverview({ limit: 50_000 });
    expect(everything.data.nodes).toHaveLength(10_000);
    expect(everything.data.truncated).toBe(false);
    const node = everything.data.nodes[5000]!;
    expect((await store.api.memoryGraphNode(node.id)).node).toEqual(node);
    const plain = new DemoStore();
    expect((await plain.api.memoryGraphOverview({})).data.nodes.length).toBeLessThan(2000);
  });
});
