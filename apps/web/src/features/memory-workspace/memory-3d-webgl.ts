import type { MemoryProjection } from "./memory-3d.js";

/** Width of the position and state textures; node i lives at texel (i % W, i / W). */
export const MEMORY_GL_TEXTURE_WIDTH = 2048;

export type MemoryGLGraph = { count: number; kinds: Uint8Array; colors: Uint8Array; edgeCount: number; edgeNodes: Uint32Array; edgeKinds: Uint8Array };

const PROJECT = `
uniform highp sampler2D uPositions;
uniform highp usampler2D uState;
uniform vec4 uCamera;   // cos yaw, sin yaw, cos pitch, sin pitch
uniform vec4 uView;     // scale, zoom, width, height (CSS pixels)
uniform float uDepthRange;
ivec2 texel(int i) { return ivec2(i % ${MEMORY_GL_TEXTURE_WIDTH}, i / ${MEMORY_GL_TEXTURE_WIDTH}); }
// Same projection as projectMemoryPoint: returns screen x, y, camera z and perspective.
vec4 project(int i) {
  vec3 p = texelFetch(uPositions, texel(i), 0).xyz;
  float x = p.x * uCamera.x + p.z * uCamera.y;
  float depth = -p.x * uCamera.y + p.z * uCamera.x;
  float y = p.y * uCamera.z - depth * uCamera.w;
  float z = p.y * uCamera.w + depth * uCamera.z;
  float perspective = 650.0 / max(120.0, 650.0 + z * uView.x);
  return vec4(uView.z * 0.5 + x * uView.x * uView.y * perspective, uView.w * 0.5 - y * uView.x * uView.y * perspective, z, perspective);
}
vec4 clip(vec2 screen, float z) { return vec4(screen.x / uView.z * 2.0 - 1.0, 1.0 - screen.y / uView.w * 2.0, clamp(z / uDepthRange, -1.0, 1.0), 1.0); }
`;

const NODE_VERTEX = `#version 300 es
precision highp float; precision highp int;
${PROJECT}
uniform int uHasFocus;
uniform int uPass;      // 0 bright nodes, 1 dimmed nodes, 2 glow halos
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aColor;
layout(location = 2) in float aKind;
out vec2 vOffset;
flat out float vRadius;
flat out float vGlow;
flat out vec4 vColor;
void main() {
  int i = gl_InstanceID;
  uint state = texelFetch(uState, texel(i), 0).r;
  vec4 p = project(i);
  bool focused = state == 2u;
  bool dimmed = uHasFocus == 1 && state == 0u;
  int kind = int(aKind + 0.5);
  bool glows = kind == 2 || focused;
  if ((uPass == 0 && dimmed) || (uPass == 1 && !dimmed) || (uPass == 2 && !glows)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float base = kind == 2 ? 10.0 : kind == 1 ? 4.6 : 2.1;
  float radius = max(1.0, base * p.w * sqrt(uView.y)) * (focused ? 1.5 : 1.0);
  float glow = uPass == 2 ? 13.0 : 0.0;
  float reach = radius + glow + 1.0;
  vOffset = aCorner * reach; vRadius = radius; vGlow = glow;
  vColor = vec4(focused ? vec3(1.0) : aColor.rgb, dimmed ? 0.2 : clamp(p.w, 0.4, 1.0));
  gl_Position = clip(p.xy + vOffset, p.z);
}`;

const NODE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vOffset;
flat in float vRadius;
flat in float vGlow;
flat in vec4 vColor;
out vec4 outColor;
void main() {
  float d = length(vOffset);
  if (vGlow > 0.0) {
    if (d < vRadius || d > vRadius + vGlow) discard;
    float g = 1.0 - (d - vRadius) / vGlow;
    outColor = vec4(vColor.rgb, vColor.a * g * g * 0.6);
    return;
  }
  float coverage = clamp(vRadius - d + 0.5, 0.0, 1.0);
  if (coverage <= 0.0) discard;
  outColor = vec4(vColor.rgb, vColor.a * coverage);
}`;

const EDGE_VERTEX = `#version 300 es
precision highp float; precision highp int;
${PROJECT}
uniform int uHasFocus;
layout(location = 0) in uint aNode;
layout(location = 1) in uint aOther;
layout(location = 2) in uint aEdgeKind;
flat out vec4 vColor;
void main() {
  int i = int(aNode), j = int(aOther);
  bool incident = texelFetch(uState, texel(i), 0).r == 2u || texelFetch(uState, texel(j), 0).r == 2u;
  vec3 color = incident ? vec3(0.596, 0.855, 0.980) : uHasFocus == 1 ? vec3(0.078, 0.125, 0.169) : aEdgeKind == 1u ? vec3(0.220, 0.314, 0.408) : vec3(0.125, 0.200, 0.263);
  vColor = vec4(color, 1.0);
  vec4 p = project(i);
  gl_Position = clip(p.xy, 0.0);
}`;

const EDGE_FRAGMENT = `#version 300 es
precision highp float;
flat in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };

function compile(gl: WebGL2RenderingContext, vertex: string, fragment: string, names: string[]): Program {
  const shader = (type: number, source: string) => {
    const handle = gl.createShader(type)!;
    gl.shaderSource(handle, source); gl.compileShader(handle);
    if (!gl.getShaderParameter(handle, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`Memory graph shader failed: ${gl.getShaderInfoLog(handle) ?? "unknown error"}`);
    return handle;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`Memory graph shader link failed: ${gl.getProgramInfoLog(program) ?? "unknown error"}`);
  return { program, uniforms: Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)])) };
}

const UNIFORMS = ["uPositions", "uState", "uCamera", "uView", "uDepthRange", "uHasFocus", "uPass"];

/**
 * WebGL2 renderer for the 3D memory graph: one instanced draw for the nodes (plus a halo pass for
 * the core file and the focus), one batched LINES draw for the edges, and depth testing on the
 * GPU. Positions and highlight state live in textures, so streaming the layout or moving the focus
 * uploads one texture instead of rebuilding geometry. All resources can be recreated after a
 * context loss with `restore()`.
 */
export class MemoryGraphGL {
  readonly gl: WebGL2RenderingContext;
  private nodes!: Program;
  private edges!: Program;
  private nodeVao: WebGLVertexArrayObject | null = null;
  private edgeVao: WebGLVertexArrayObject | null = null;
  private buffers: WebGLBuffer[] = [];
  private positionTexture: WebGLTexture | null = null;
  private stateTexture: WebGLTexture | null = null;
  private graph: MemoryGLGraph | null = null;
  private positions: Float32Array | null = null;
  private state: Uint8Array | null = null;
  private rows = 1;

  static create(canvas: HTMLCanvasElement): MemoryGraphGL | null {
    let gl: WebGL2RenderingContext | null;
    try { gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false }); } catch { gl = null; }
    if (!gl || typeof gl.texImage2D !== "function") return null;
    try { return new MemoryGraphGL(gl); } catch { return null; }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.init();
  }

  get lost() { return this.gl.isContextLost(); }

  private init() {
    const gl = this.gl;
    this.nodes = compile(gl, NODE_VERTEX, NODE_FRAGMENT, UNIFORMS);
    this.edges = compile(gl, EDGE_VERTEX, EDGE_FRAGMENT, UNIFORMS);
    this.positionTexture = gl.createTexture();
    this.stateTexture = gl.createTexture();
    this.buffers = [];
    this.nodeVao = null; this.edgeVao = null;
  }

  /** Recreates every GL resource after `webglcontextrestored` and re-uploads the last data. */
  restore() {
    this.init();
    const { graph, positions, state } = this;
    if (graph) this.setGraph(graph);
    if (positions) this.setPositions(positions);
    if (state) this.setState(state);
  }

  setGraph(graph: MemoryGLGraph) {
    const gl = this.gl;
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    this.buffers = [];
    this.graph = graph;
    this.rows = Math.max(1, Math.ceil(graph.count / MEMORY_GL_TEXTURE_WIDTH));
    const buffer = (data: ArrayBufferView) => {
      const handle = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, handle); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      this.buffers.push(handle);
      return handle;
    };
    this.nodeVao = gl.createVertexArray();
    gl.bindVertexArray(this.nodeVao);
    buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    buffer(graph.colors);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0); gl.vertexAttribDivisor(1, 1);
    buffer(graph.kinds);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0); gl.vertexAttribDivisor(2, 1);
    // Two vertices per edge; each knows its node and the other end, for incident highlighting.
    const node = new Uint32Array(graph.edgeCount * 2), other = new Uint32Array(graph.edgeCount * 2), kind = new Uint32Array(graph.edgeCount * 2);
    for (let e = 0; e < graph.edgeCount; e++) {
      const a = graph.edgeNodes[e * 2]!, b = graph.edgeNodes[e * 2 + 1]!;
      node[e * 2] = a; other[e * 2] = b; node[e * 2 + 1] = b; other[e * 2 + 1] = a;
      kind[e * 2] = kind[e * 2 + 1] = graph.edgeKinds[e]!;
    }
    this.edgeVao = gl.createVertexArray();
    gl.bindVertexArray(this.edgeVao);
    buffer(node); gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 0, 0);
    buffer(other); gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
    buffer(kind); gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 0, 0);
    gl.bindVertexArray(null);
    const texture = (handle: WebGLTexture | null, internal: number, format: number, type: number, data: ArrayBufferView) => {
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, MEMORY_GL_TEXTURE_WIDTH, this.rows, 0, format, type, data);
    };
    texture(this.positionTexture, gl.RGBA32F, gl.RGBA, gl.FLOAT, new Float32Array(MEMORY_GL_TEXTURE_WIDTH * this.rows * 4));
    texture(this.stateTexture, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(MEMORY_GL_TEXTURE_WIDTH * this.rows));
    this.positions = null; this.state = null;
  }

  /** Uploads x, y, z, w per node (as streamed by the layout worker). */
  setPositions(positions: Float32Array) {
    const gl = this.gl;
    this.positions = positions;
    if (!this.graph) return;
    const padded = new Float32Array(MEMORY_GL_TEXTURE_WIDTH * this.rows * 4);
    padded.set(positions.subarray(0, Math.min(positions.length, padded.length)));
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MEMORY_GL_TEXTURE_WIDTH, this.rows, gl.RGBA, gl.FLOAT, padded);
  }

  /** Uploads the highlight state per node: 0 normal, 1 neighbour, 2 focus. */
  setState(state: Uint8Array) {
    const gl = this.gl;
    this.state = state;
    if (!this.graph) return;
    const padded = new Uint8Array(MEMORY_GL_TEXTURE_WIDTH * this.rows);
    padded.set(state.subarray(0, Math.min(state.length, padded.length)));
    gl.bindTexture(gl.TEXTURE_2D, this.stateTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MEMORY_GL_TEXTURE_WIDTH, this.rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, padded);
  }

  draw(view: MemoryProjection, devicePixelRatio: number, extent: number, hasFocus: boolean) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.viewport(0, 0, Math.round(view.width * devicePixelRatio), Math.round(view.height * devicePixelRatio));
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const graph = this.graph;
    if (!graph || !graph.count || !this.positions) return;
    const bind = (program: Program) => {
      gl.useProgram(program.program);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.positionTexture); gl.uniform1i(program.uniforms.uPositions!, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.stateTexture); gl.uniform1i(program.uniforms.uState!, 1);
      gl.uniform4f(program.uniforms.uCamera!, view.cosYaw, view.sinYaw, view.cosPitch, view.sinPitch);
      gl.uniform4f(program.uniforms.uView!, view.scale, view.zoom, view.width, view.height);
      gl.uniform1f(program.uniforms.uDepthRange!, extent * 1.05);
      gl.uniform1i(program.uniforms.uHasFocus!, hasFocus ? 1 : 0);
    };
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Edges sit under every node, as in the 2D renderer.
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    bind(this.edges);
    gl.bindVertexArray(this.edgeVao);
    gl.drawArrays(gl.LINES, 0, graph.edgeCount * 2);
    bind(this.nodes);
    gl.bindVertexArray(this.nodeVao);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.uniform1i(this.nodes.uniforms.uPass!, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, graph.count);
    // Dimmed nodes blend over what is behind them but never hide it; halos never write depth.
    gl.depthMask(false);
    if (hasFocus) { gl.uniform1i(this.nodes.uniforms.uPass!, 1); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, graph.count); }
    gl.uniform1i(this.nodes.uniforms.uPass!, 2);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, graph.count);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    gl.deleteTexture(this.positionTexture); gl.deleteTexture(this.stateTexture);
    gl.deleteVertexArray(this.nodeVao); gl.deleteVertexArray(this.edgeVao);
    gl.deleteProgram(this.nodes.program); gl.deleteProgram(this.edges.program);
  }
}
