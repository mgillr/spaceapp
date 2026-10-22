import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphOverviewPayload } from "@space/contracts";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import { runMemoryGraph3DJob, type MemoryGraph3DRequest, type MemoryGraph3DMessage } from "./memory-graph-3d-job.js";

type LayoutRequest = { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] };

const post = (message: MemoryGraph3DMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
const fetchOverview = async (url: string): Promise<MemoryGraphOverviewPayload> => {
  const response = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Memory graph request failed: ${response.status}`);
  return (await response.json() as { data: MemoryGraphOverviewPayload }).data;
};

self.onmessage = (event: MessageEvent<LayoutRequest | MemoryGraph3DRequest>) => {
  const message = event.data;
  if ("type" in message && message.type === "graph3d") {
    void runMemoryGraph3DJob(message, { post, fetchOverview, now: () => performance.now(), yieldToEvents: () => new Promise(resolve => setTimeout(resolve, 0)) });
    return;
  }
  const { nodes, edges } = message as LayoutRequest;
  self.postMessage({ positions: [...layoutMemoryNetwork(nodes, edges)] });
};
