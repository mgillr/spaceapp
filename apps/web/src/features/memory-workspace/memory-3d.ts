import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryLayout3D } from "./memory-3d-layout.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const layout = createMemoryLayout3D(nodes, edges);
  layout.advance(layout.totalSteps);
  return new Map(layout.ids.map((id, i) => [id, { x: layout.positions[i * 3]!, y: layout.positions[i * 3 + 1]!, z: layout.positions[i * 3 + 2]! }]));
}

export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */
export function memory3DVolumeRatio(points: MemoryPoint3D[]): number {
  if (points.length < 4) return 0;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}

/** The same ratio over interleaved coordinates (`stride` numbers per point, x, y, z first). */
export function memory3DVolumeRatioPacked(values: ArrayLike<number>, count: number, stride = 3): number {
  if (count < 4) return 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i++) { cx += values[i * stride]! / count; cy += values[i * stride + 1]! / count; cz += values[i * stride + 2]! / count; }
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < count; i++) {
    const x = values[i * stride]! - cx, y = values[i * stride + 1]! - cy, z = values[i * stride + 2]! - cz;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}

/** Precomputed camera terms, shared by the CPU projection (picking, labels) and the WebGL shader uniforms. */
export type MemoryProjection = { cosYaw: number; sinYaw: number; cosPitch: number; sinPitch: number; scale: number; zoom: number; width: number; height: number };
export const memoryProjection = (camera: MemoryCamera3D, scale: number, width: number, height: number): MemoryProjection => ({
  cosYaw: Math.cos(camera.yaw), sinYaw: Math.sin(camera.yaw), cosPitch: Math.cos(camera.pitch), sinPitch: Math.sin(camera.pitch), scale, zoom: camera.zoom, width, height
});
/** Pixels per layout unit: the graph's extent fills 80% of the shorter side, as before. */
export const memoryGraphScale = (extent: number, width: number, height: number) => Math.min(width, height) * 0.4 / Math.max(60, extent);
/** Largest distance of any point from the origin, from interleaved coordinates. */
export function memoryGraphExtent(values: ArrayLike<number>, count: number, stride = 3): number {
  let max = 0;
  for (let i = 0; i < count; i++) max = Math.max(max, Math.hypot(values[i * stride]!, values[i * stride + 1]!, values[i * stride + 2]!));
  return Math.max(60, max);
}
/** Same result as `projectMemoryPoint`, written into `out` without allocating. */
export function projectMemoryPointInto(view: MemoryProjection, px: number, py: number, pz: number, out: { x: number; y: number; z: number; perspective: number }) {
  const x = px * view.cosYaw + pz * view.sinYaw;
  const depth = -px * view.sinYaw + pz * view.cosYaw;
  const y = py * view.cosPitch - depth * view.sinPitch;
  const z = py * view.sinPitch + depth * view.cosPitch;
  const perspective = 650 / Math.max(120, 650 + z * view.scale);
  out.x = view.width / 2 + x * view.scale * view.zoom * perspective;
  out.y = view.height / 2 - y * view.scale * view.zoom * perspective;
  out.z = z; out.perspective = perspective;
  return out;
}
export const MEMORY_NODE_ROOT = 2, MEMORY_NODE_SOURCE = 1, MEMORY_NODE_OTHER = 0;
/** Node radius in CSS pixels: core file 10, files 4.6, records 2.1, scaled by perspective and zoom; focus is 1.5x. */
export const memoryNodeRadius = (kind: number, perspective: number, zoom: number, focused: boolean) =>
  Math.max(1, (kind === MEMORY_NODE_ROOT ? 10 : kind === MEMORY_NODE_SOURCE ? 4.6 : 2.1) * perspective * Math.sqrt(zoom)) * (focused ? 1.5 : 1);
