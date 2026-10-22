import { MemoryGraphGL } from "./memory-3d-webgl.js";
import { createMemoryRenderHost, type MemoryRenderEvent, type MemoryRenderRequest } from "./memory-3d-render-host.js";

// Draws the 3D memory graph on the canvas the page transferred here, so waiting for the GPU
// (or a software rasteriser) never holds up the page's main thread.
const handle = createMemoryRenderHost({
  post: (event: MemoryRenderEvent) => self.postMessage(event),
  requestFrame: callback => { if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback()); else setTimeout(callback, 16); },
  create: canvas => MemoryGraphGL.create(canvas)
});

self.onmessage = (event: MessageEvent<MemoryRenderRequest>) => handle(event.data);
