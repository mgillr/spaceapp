import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

/** Largest synthetic graph the demo generates; matches the server's overview maximum. */
export const SYNTHETIC_MEMORY_GRAPH_MAX_NODES = 50_000;
/** `/demo-workspace?memoryGraphNodes=50000` asks the demo for a synthetic graph of that size. */
export const SYNTHETIC_MEMORY_GRAPH_PARAM = "memoryGraphNodes";

export function syntheticMemoryGraphSize(search: string): number | null {
  const raw = new URLSearchParams(search).get(SYNTHETIC_MEMORY_GRAPH_PARAM);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const size = Number(raw);
  return size >= 1 ? Math.min(size, SYNTHETIC_MEMORY_GRAPH_MAX_NODES) : null;
}

/** Source files besides the core file; with it, the 24 the memory summary allows. */
const SYNTHETIC_MEMORY_SOURCE_FILES = 23;
const pad = (value: number) => String(value).padStart(6, "0");
const MONTHS = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
const SUBJECTS = ["deploy", "billing", "onboarding", "release", "incident", "roadmap", "research", "design", "support", "security", "metrics", "hiring"];

/**
 * A deterministic graph shaped like a long-running workspace: one core file, up to 23 dated files
 * holding the records, tagged topics and similarity links, about three edges per node. Node order is
 * core file, files, topics, records, so the first `limit` nodes are a valid smaller sample and
 * only those are generated.
 */
export function createSyntheticMemoryGraph(nodeCount: number, limit = nodeCount): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; totalNodes: number; totalEdges: number } {
  const total = Math.max(1, Math.min(Math.floor(nodeCount), SYNTHETIC_MEMORY_GRAPH_MAX_NODES));
  const take = Math.max(0, Math.min(total, Math.floor(limit)));
  // Canonical memory has at most 24 source files (the summary schema caps it), so records cluster under few files.
  const sourceCount = Math.max(0, Math.min(total - 1, SYNTHETIC_MEMORY_SOURCE_FILES, Math.round(total / 40)));
  const topicCount = Math.max(0, Math.min(total - 1 - sourceCount, Math.round(total / 120)));
  const memoryCount = total - 1 - sourceCount - topicCount;
  const sourceIndex = (s: number) => 1 + s, topicIndex = (t: number) => 1 + sourceCount + t, memoryIndex = (m: number) => 1 + sourceCount + topicCount + m;
  const sourceId = (s: number) => `source:synthetic-${pad(s)}`, topicId = (t: number) => `topic:synthetic-${pad(t)}`, memoryId = (m: number) => `memory:synthetic-${pad(m)}`;
  const sourcePath = (s: number) => `/opt/spaceapp/docs/space_memory_${MONTHS[s % MONTHS.length]}_${pad(s)}.md`;
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  if (take > 0) nodes.push({ id: "source:synthetic-core", type: "SOURCE", label: "space.md", sourcePath: "/opt/spaceapp/docs/space.md", recordId: null });
  for (let s = 0; s < sourceCount && sourceIndex(s) < take; s++) {
    nodes.push({ id: sourceId(s), type: "SOURCE", label: `${SUBJECTS[s % SUBJECTS.length]}-notes-${pad(s)}.md`, sourcePath: sourcePath(s), recordId: null });
  }
  for (let t = 0; t < topicCount && topicIndex(t) < take; t++) {
    nodes.push({ id: topicId(t), type: "TOPIC", label: `${SUBJECTS[t % SUBJECTS.length]} ${Math.floor(t / SUBJECTS.length) + 1}`, sourcePath: null, recordId: null });
  }
  const memoryTaken = Math.max(0, Math.min(memoryCount, take - memoryIndex(0)));
  for (let m = 0; m < memoryTaken; m++) {
    const s = m % Math.max(1, sourceCount);
    nodes.push({ id: memoryId(m), type: "MEMORY", label: `${SUBJECTS[(m * 7) % SUBJECTS.length]} memory ${m}`, sourcePath: sourceCount ? sourcePath(s) : null, recordId: memoryId(m) });
  }
  const related = (m: number, salt: number) => memoryCount > 1 ? (m * salt + 5) % memoryCount : m;
  // Edges among the first `upTo` nodes, at most three per node; `emit` is skipped when only counting.
  const walkEdges = (upTo: number, emit: ((edge: MemoryGraphEdge) => void) | null) => {
    const has = (nodeIndex: number) => nodeIndex < upTo;
    const budget = upTo * 3, records = Math.max(0, Math.min(memoryCount, upTo - memoryIndex(0)));
    let emitted = 0;
    const add = (edge: () => MemoryGraphEdge) => { emitted++; emit?.(edge()); };
    for (let s = 0; s < sourceCount && has(sourceIndex(s)); s++) add(() => ({ id: `edge:synthetic-file-${pad(s)}`, type: "DERIVED_FROM", source: "source:synthetic-core", target: sourceId(s) }));
    for (let m = 0; m < records && emitted < budget; m++) {
      const s = m % Math.max(1, sourceCount), t = m % Math.max(1, topicCount), r = related(m, 13);
      if (sourceCount && has(sourceIndex(s))) add(() => ({ id: `edge:synthetic-contains-${pad(m)}`, type: "CONTAINS", source: sourceId(s), target: memoryId(m) }));
      if (topicCount && has(topicIndex(t)) && emitted < budget) add(() => ({ id: `edge:synthetic-tag-${pad(m)}`, type: "TAGGED_WITH", source: memoryId(m), target: topicId(t), origin: "EXPLICIT_TAG", confidence: 1, evidence: "Synthetic demo tag." }));
      if (r !== m && has(memoryIndex(r)) && emitted < budget) add(() => ({ id: `edge:synthetic-related-${pad(m)}`, type: "SEMANTICALLY_RELATED", source: memoryId(m), target: memoryId(r), origin: "EMBEDDING", confidence: 0.8, evidence: "Synthetic demo similarity." }));
    }
    for (let m = 0; m < records && emitted < budget; m++) {
      const r = related(m, 29);
      if (r !== m && has(memoryIndex(r))) add(() => ({ id: `edge:synthetic-related2-${pad(m)}`, type: "SEMANTICALLY_RELATED", source: memoryId(m), target: memoryId(r), origin: "EMBEDDING", confidence: 0.7, evidence: "Synthetic demo similarity." }));
    }
    return emitted;
  };
  walkEdges(take, edge => edges.push(edge));
  const totalEdges = take === total ? edges.length : walkEdges(total, null);
  return { nodes, edges, totalNodes: total, totalEdges };
}
