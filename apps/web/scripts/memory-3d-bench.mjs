#!/usr/bin/env node
// Frame-time harness for the 3D memory graph. Opens the demo workspace with a synthetic graph in
// headless Chrome, switches the Atlas to 3D, waits for the in-page bench (`?memory3dBench=1`) and
// prints one JSON line per graph size.
//
//   node apps/web/scripts/memory-3d-bench.mjs --url http://127.0.0.1:4173 --nodes 2000,10000,50000
//
// Options: --chrome <path> (default $CHROME or google-chrome), --no-webgl (forces the Canvas 2D
// fallback), --headed, --no-sandbox (containers), --timeout <seconds per size> (default 240),
// --profile <dir> (saves a main-thread CPU profile from opening 3D until the layout is done, and
// prints the functions with the most self time).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const baseUrl = option("--url", "http://127.0.0.1:4173").replace(/\/$/, "");
const sizes = option("--nodes", "2000,10000,50000").split(",").map(Number).filter(Boolean);
const chrome = option("--chrome", process.env.CHROME || "google-chrome");
const timeoutMs = Number(option("--timeout", "240")) * 1000;
const webgl = !args.includes("--no-webgl");
const headed = args.includes("--headed");
const profileDir = option("--profile", null);
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "memory-3d-bench-"));

const flags = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"];
if (!headed) flags.push("--headless=new");
if (webgl) flags.push("--enable-unsafe-swiftshader", "--ignore-gpu-blocklist");
else flags.push("--disable-webgl", "--disable-3d-apis");
if (args.includes("--no-sandbox") || process.getuid?.() === 0) flags.push("--no-sandbox");
const browser = spawn(chrome, [...flags, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function cdpTarget() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find(target => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* Chrome is still starting */ }
    await sleep(100);
  }
  throw new Error("Chrome did not expose a debugging target");
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    const waiter = message.id && pending.get(message.id);
    if (waiter) { pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); });
  return new Promise((resolve, reject) => { socket.addEventListener("open", () => resolve({ send, close: () => socket.close() })); socket.addEventListener("error", reject); });
}

const evaluate = async (cdp, expression) => {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};

// Runs in the page: opens the memory workspace from the Workspace action finder, then Atlas, then 3D.
const openThreeD = `(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const button = name => [...document.querySelectorAll("button")].find(element => element.getAttribute("aria-label") === name || element.textContent.trim() === name);
  const waitFor = async (find, label) => { for (let i = 0; i < 300; i++) { const found = find(); if (found) return found; await sleep(100); } throw new Error("missing " + label); };
  (await waitFor(() => button("Workspace"), "Workspace")).click();
  const input = await waitFor(() => document.querySelector('input[aria-label="Find an action"]'), "action finder");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "memory");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  (await waitFor(() => button("Open memory workspace"), "Open memory workspace")).click();
  (await waitFor(() => button("Atlas"), "Atlas")).click();
  (await waitFor(() => button("Toggle 3D memory view"), "3D toggle")).click();
  return performance.now();
})()`;

const watch = `(() => {
  const surface = document.querySelector("[data-layout-done]");
  return { now: performance.now(), renderer: surface?.getAttribute("data-renderer") ?? null, nodes: Number(surface?.getAttribute("data-node-count") ?? 0), step: Number(surface?.getAttribute("data-layout-step") ?? 0), done: surface?.getAttribute("data-layout-done") === "true", bench: window.__spaceMemory3DBench ?? null };
})()`;

// Self time per function, from the sampled CPU profile.
function saveProfile(nodes, profile) {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, `memory-3d-load-${nodes}.cpuprofile`), JSON.stringify(profile));
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const self = new Map();
  profile.samples.forEach((id, index) => {
    const frame = byId.get(id).callFrame;
    const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000);
  });
  const top = [...self].filter(([key]) => !key.startsWith("(idle)") && !key.startsWith("(program)")).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, ms]) => ({ name, ms: Math.round(ms) }));
  console.log(JSON.stringify({ profile: nodes, topSelfTimeMs: top }));
}

let failed = false;
try {
  const cdp = await connect(await cdpTarget());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  for (const nodes of sizes) {
    await cdp.send("Page.navigate", { url: `${baseUrl}/demo-workspace?memoryGraphNodes=${nodes}&memory3dBench=1` });
    await sleep(500);
    if (profileDir) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }
    const clickedAt = await evaluate(cdp, openThreeD);
    let profiled = !profileDir;
    let firstPositionsMs = null, layoutDoneMs = null, state;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      state = await evaluate(cdp, watch);
      if (firstPositionsMs === null && state.step > 0) firstPositionsMs = Math.round(state.now - clickedAt);
      if (layoutDoneMs === null && state.done && state.nodes > 0) layoutDoneMs = Math.round(state.now - clickedAt);
      if (!profiled && layoutDoneMs !== null) { profiled = true; saveProfile(nodes, (await cdp.send("Profiler.stop")).profile); }
      if (state.bench || Date.now() > deadline) break;
      await sleep(50);
    }
    if (!state.bench) { failed = true; console.log(JSON.stringify({ requestedNodes: nodes, error: "bench did not finish", state })); continue; }
    console.log(JSON.stringify({ requestedNodes: nodes, webgl, firstPositionsMs, layoutDoneMs, ...state.bench }));
  }
  cdp.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  browser.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
