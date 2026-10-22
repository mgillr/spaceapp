import type { MemoryEntry, MemoryGraphNodeType, MemoryLifecycleStatus } from "@space/contracts";

export type MemoryGraphOverviewQuery = {
  q?: string;
  nodeType?: MemoryGraphNodeType;
  scope?: MemoryEntry["scope"];
  roomId?: string;
  sourcePath?: string;
  lifecycleStatus?: MemoryLifecycleStatus;
  month?: string;
  relationMode?: "CLUSTERED" | "RELATIONS";
  /** Nodes to return; the server default (2,000) applies when omitted. */
  limit?: number;
};

/** Path of the admin overview endpoint; shared by the API client and the layout worker. */
export function memoryGraphOverviewUrl(query: MemoryGraphOverviewQuery = {}): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.nodeType) params.set("nodeType", query.nodeType);
  if (query.scope) params.set("scope", query.scope);
  if (query.roomId) params.set("roomId", query.roomId);
  if (query.sourcePath) params.set("sourcePath", query.sourcePath);
  if (query.lifecycleStatus) params.set("lifecycleStatus", query.lifecycleStatus);
  if (query.month) params.set("month", query.month);
  if (query.relationMode) params.set("relationMode", query.relationMode);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.toString();
  return `/api/admin/memory/graph/overview${suffix ? `?${suffix}` : ""}`;
}
