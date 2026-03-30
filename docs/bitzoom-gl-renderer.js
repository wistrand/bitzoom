// bitzoom-gl-renderer.js — WebGL2 renderer for BitZoom.
// WebGL2 instanced rendering: grid, edges, heatmap, circles.

import { RAW_LEVEL, ZOOM_LEVELS } from './bitzoom-algo.js';

/**
 * Check if WebGL2 is available. Creates and destroys a temporary canvas.
 * @returns {boolean}
 */
export function isWebGL2Available() {
  try {
    const c = document.createElement('canvas');
    c.addEventListener('webglcontextlost', e => e.preventDefault());
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

/**
 * Initialize WebGL2 on a canvas element.
 * @param {HTMLCanvasElement} glCanvas
 * @returns {WebGL2RenderingContext|null}
 */
export function initGL(glCanvas) {
  const gl = glCanvas.getContext('webgl2', { alpha: false, antialias: false });
  if (!gl) { console.log('[GL] WebGL2 context creation failed'); return null; }
  console.log('[GL] WebGL2 context created');

  // Enable float/half-float rendering for heatmap FBO
  gl.getExtension('EXT_color_buffer_half_float');
  gl.getExtension('EXT_color_buffer_float');

  // Compile shaders and programs
  gl._circleProgram = _createCircleProgram(gl);
  if (!gl._circleProgram) { console.log('[GL] Circle shader compilation failed'); return null; }

  // Create unit quad VBO for circles (2 triangles, TRIANGLE_STRIP)
  const quadVerts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
  gl._quadVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._quadVBO);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

  // Edge line quad VBO (TRIANGLE_STRIP: 4 corners)
  const edgeLineQuad = new Float32Array([0,-1, 1,-1, 0,1, 1,1]);
  gl._edgeLineQuadVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._edgeLineQuadVBO);
  gl.bufferData(gl.ARRAY_BUFFER, edgeLineQuad, gl.STATIC_DRAW);

  // Edge curve strip VBO (TRIANGLE_STRIP: 16 segments, 2 vertices each = 34 verts)
  const CURVE_SEGS = 16;
  gl._curveSegCount = CURVE_SEGS;
  const curveVerts = new Float32Array((CURVE_SEGS + 1) * 4); // (segs+1) * 2 verts * 2 floats
  for (let i = 0; i <= CURVE_SEGS; i++) {
    const t = i / CURVE_SEGS;
    curveVerts[i * 4]     = t;  curveVerts[i * 4 + 1] = -1;
    curveVerts[i * 4 + 2] = t;  curveVerts[i * 4 + 3] =  1;
  }
  gl._edgeCurveVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._edgeCurveVBO);
  gl.bufferData(gl.ARRAY_BUFFER, curveVerts, gl.STATIC_DRAW);

  // Instance buffer (dynamic, shared between circles and edges)
  gl._instanceVBO = gl.createBuffer();

  // Edge programs (line + curve)
  gl._edgeLineProgram = _createEdgeProgram(gl, EDGE_LINE_VS);
  gl._edgeCurveProgram = _createEdgeProgram(gl, EDGE_CURVE_VS);
  if (!gl._edgeLineProgram || !gl._edgeCurveProgram) { console.log('[GL] Edge shader compilation failed'); return null; }

  // Grid program
  gl._gridProgram = _createGridProgram(gl);
  if (!gl._gridProgram) { console.log('[GL] Grid shader compilation failed'); return null; }

  // Heatmap programs
  gl._heatSplatProg = _createHeatSplatProgram(gl);
  gl._heatResolveProg = _createHeatResolveProgram(gl);
  if (!gl._heatSplatProg || !gl._heatResolveProg) { console.log('[GL] Heatmap shader compilation failed'); return null; }

  // Fullscreen quad VBO for heatmap resolve pass (clip-space [-1,1])
  gl._fsQuadVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._fsQuadVBO);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  // Heatmap FBO (created/resized on demand)
  gl._heatFBO = null;
  gl._heatTex = null;
  gl._heatW = 0;
  gl._heatH = 0;
  gl._heatMaxW = 0;
  gl._heatMaxWTarget = 0;
  gl._heatMaxWKey = '';
  gl._heatMaxWTime = 0;

  // VAOs
  gl._circleVAO = _setupCircleVAO(gl);
  gl._edgeLineVAO = _setupEdgeVAO(gl, gl._edgeLineQuadVBO);
  gl._edgeCurveVAO = _setupEdgeVAO(gl, gl._edgeCurveVBO);
  gl._heatResolveVAO = _setupHeatResolveVAO(gl);

  return gl;
}

// ─── Shaders ──────────────────────────────────────────────────────────────────

const CIRCLE_VS = `#version 300 es
precision highp float;

// Per-vertex: unit quad corner [-1,1]
layout(location = 0) in vec2 a_quad;

// Per-instance: x, y, radius, r, g, b, a, strokeR, strokeG, strokeB, strokeA
layout(location = 1) in vec2 a_center;
layout(location = 2) in float a_radius;
layout(location = 3) in vec4 a_fillColor;
layout(location = 4) in vec4 a_strokeColor;

uniform vec2 u_resolution;

out vec2 v_uv;
out vec4 v_fillColor;
out vec4 v_strokeColor;
out float v_radius;

void main() {
  v_uv = a_quad;
  v_fillColor = a_fillColor;
  v_strokeColor = a_strokeColor;
  v_radius = a_radius;

  // Expand quad: add 1px margin for AA
  vec2 pos = a_center + a_quad * (a_radius + 1.0);

  // Screen pixels to clip space
  gl_Position = vec4(pos / u_resolution * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}
`;

const CIRCLE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec4 v_fillColor;
in vec4 v_strokeColor;
in float v_radius;

out vec4 fragColor;

void main() {
  float dist = length(v_uv) * (v_radius + 1.0);
  float aa = smoothstep(v_radius + 1.0, v_radius - 0.5, dist);
  if (aa < 0.001) discard;

  // Stroke ring: 1px inside the edge
  float strokeMask = smoothstep(v_radius - 2.0, v_radius - 0.5, dist);
  vec4 col = mix(v_fillColor, v_strokeColor, strokeMask * v_strokeColor.a);
  col.a *= aa;
  fragColor = col;
}
`;

// Glow shader for selection/hover highlights
const GLOW_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_quad;
layout(location = 1) in vec2 a_center;
layout(location = 2) in float a_radius;
layout(location = 3) in vec4 a_fillColor;
layout(location = 4) in vec4 a_strokeColor;

uniform vec2 u_resolution;

out vec2 v_uv;
out vec4 v_color;
out float v_radius;

void main() {
  v_uv = a_quad;
  v_color = a_fillColor;
  v_radius = a_radius;

  vec2 pos = a_center + a_quad * (a_radius + 1.0);
  gl_Position = vec4(pos / u_resolution * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}
`;

const GLOW_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec4 v_color;
in float v_radius;

out vec4 fragColor;

void main() {
  float dist = length(v_uv);
  float glow = smoothstep(1.0, 0.0, dist);
  glow *= glow;
  fragColor = vec4(v_color.rgb, v_color.a * glow);
}
`;

// ─── Heatmap density shaders ──────────────────────────────────────────────────

// Pass 1: accumulate Gaussian splats into RGBA FBO
// R,G,B = weighted color sum, A = total weight
const HEAT_SPLAT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_quad;
layout(location = 1) in vec2 a_center;
layout(location = 2) in float a_radius;
layout(location = 3) in vec4 a_fillColor;
layout(location = 4) in vec4 a_strokeColor;

uniform vec2 u_resolution;

out vec2 v_uv;
out vec3 v_color;
out float v_weight;

void main() {
  v_uv = a_quad;
  v_color = a_fillColor.rgb;
  v_weight = a_fillColor.a;

  vec2 pos = a_center + a_quad * (a_radius + 1.0);
  gl_Position = vec4(pos / u_resolution * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}
`;

const HEAT_SPLAT_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec3 v_color;
in float v_weight;

out vec4 fragColor;

void main() {
  float dist = length(v_uv);
  float t = 1.0 - dist * dist;
  if (t <= 0.0) discard;
  float k = t * t * v_weight;
  fragColor = vec4(v_color * k, k);
}
`;

// Pass 2: fullscreen quad reads density FBO, normalizes, maps to output
const HEAT_RESOLVE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const HEAT_RESOLVE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_density;
uniform float u_maxW;

out vec4 fragColor;

void main() {
  vec4 d = texture(u_density, v_uv);
  float w = d.a;
  if (w < 0.001) discard;
  float intensity = min(1.0, w / (u_maxW * 0.3));
  vec3 col = d.rgb / w * intensity;
  fragColor = vec4(col, intensity * 0.7);
}
`;

// ─── Grid shader ──────────────────────────────────────────────────────────────

const GRID_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
out vec2 v_screenPos;
uniform vec2 u_resolution;
void main() {
  v_screenPos = (a_pos * 0.5 + 0.5) * u_resolution;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const GRID_FS = `#version 300 es
precision highp float;

in vec2 v_screenPos;
uniform float u_gridSize;
uniform vec2 u_pan;

out vec4 fragColor;

void main() {
  // Grid line at every u_gridSize pixels, offset by pan
  vec2 p = v_screenPos - u_pan;
  vec2 g = abs(fract(p / u_gridSize + 0.5) - 0.5) * u_gridSize;
  float d = min(g.x, g.y);
  // Match Canvas 2D lineWidth 0.5: very thin line with AA
  float line = 1.0 - smoothstep(0.0, 1.0, d);
  if (line < 0.01) discard;
  fragColor = vec4(60.0/255.0, 60.0/255.0, 100.0/255.0, 0.3 * line);
}
`;

// ─── Edge shaders ─────────────────────────────────────────────────────────────

// Line edge shader: straight segments
const EDGE_LINE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_quad;
layout(location = 1) in vec2 a_start;
layout(location = 2) in vec2 a_end;
layout(location = 3) in vec4 a_color;

uniform vec2 u_resolution;
uniform float u_width;

out vec4 v_color;

void main() {
  v_color = a_color;
  vec2 dir = a_end - a_start;
  float len = length(dir);
  if (len < 0.001) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  vec2 fwd = dir / len;
  vec2 perp = vec2(-fwd.y, fwd.x);
  vec2 pos = mix(a_start, a_end, a_quad.x) + perp * a_quad.y * u_width * 0.5;
  gl_Position = vec4(pos / u_resolution * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}
`;

// Curve edge shader: Bezier evaluated in vertex shader
// a_quad.x = t in [0,1], a_quad.y = -1 or +1 (perpendicular offset)
// Control points match Canvas 2D drawEdge curves mode
const EDGE_CURVE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_quad;
layout(location = 1) in vec2 a_start;
layout(location = 2) in vec2 a_end;
layout(location = 3) in vec4 a_color;

uniform vec2 u_resolution;
uniform float u_width;

out vec4 v_color;

void main() {
  v_color = a_color;
  vec2 dir = a_end - a_start;
  float len = length(dir);
  if (len < 0.001) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  vec2 fwd = dir / len;
  vec2 perp = vec2(-fwd.y, fwd.x);

  // Same Bezier control points as Canvas 2D
  vec2 c1 = a_start + dir * 0.3 + perp * len * 0.15;
  vec2 c2 = a_start + dir * 0.7 + perp * len * 0.05;

  // Evaluate cubic Bezier at t
  float t = a_quad.x;
  float mt = 1.0 - t;
  vec2 p = mt*mt*mt * a_start + 3.0*mt*mt*t * c1 + 3.0*mt*t*t * c2 + t*t*t * a_end;

  // Tangent for perpendicular offset
  vec2 tang = 3.0*mt*mt*(c1 - a_start) + 6.0*mt*t*(c2 - c1) + 3.0*t*t*(a_end - c2);
  float tlen = length(tang);
  vec2 tperp = tlen > 0.001 ? vec2(-tang.y, tang.x) / tlen : perp;

  vec2 pos = p + tperp * a_quad.y * u_width * 0.5;
  gl_Position = vec4(pos / u_resolution * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}
`;

const EDGE_FS = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

function _compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[GL] Shader compile:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function _linkProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('[GL] Program link:', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

function _createCircleProgram(gl) {
  const vs = _compileShader(gl, gl.VERTEX_SHADER, CIRCLE_VS);
  const fs = _compileShader(gl, gl.FRAGMENT_SHADER, CIRCLE_FS);
  if (!vs || !fs) return null;
  const prog = _linkProgram(gl, vs, fs);
  if (!prog) return null;
  prog.u_resolution = gl.getUniformLocation(prog, 'u_resolution');

  // Glow program
  const gvs = _compileShader(gl, gl.VERTEX_SHADER, GLOW_VS);
  const gfs = _compileShader(gl, gl.FRAGMENT_SHADER, GLOW_FS);
  if (!gvs || !gfs) return null;
  const glowProg = _linkProgram(gl, gvs, gfs);
  if (!glowProg) return null;
  glowProg.u_resolution = gl.getUniformLocation(glowProg, 'u_resolution');

  prog._glow = glowProg;
  return prog;
}

function _createGridProgram(gl) {
  const vs = _compileShader(gl, gl.VERTEX_SHADER, GRID_VS);
  const fs = _compileShader(gl, gl.FRAGMENT_SHADER, GRID_FS);
  if (!vs || !fs) return null;
  const prog = _linkProgram(gl, vs, fs);
  if (!prog) return null;
  prog.u_resolution = gl.getUniformLocation(prog, 'u_resolution');
  prog.u_gridSize = gl.getUniformLocation(prog, 'u_gridSize');
  prog.u_pan = gl.getUniformLocation(prog, 'u_pan');
  return prog;
}

function _createHeatSplatProgram(gl) {
  const vs = _compileShader(gl, gl.VERTEX_SHADER, HEAT_SPLAT_VS);
  const fs = _compileShader(gl, gl.FRAGMENT_SHADER, HEAT_SPLAT_FS);
  if (!vs || !fs) return null;
  const prog = _linkProgram(gl, vs, fs);
  if (!prog) return null;
  prog.u_resolution = gl.getUniformLocation(prog, 'u_resolution');
  return prog;
}

function _createHeatResolveProgram(gl) {
  const vs = _compileShader(gl, gl.VERTEX_SHADER, HEAT_RESOLVE_VS);
  const fs = _compileShader(gl, gl.FRAGMENT_SHADER, HEAT_RESOLVE_FS);
  if (!vs || !fs) return null;
  const prog = _linkProgram(gl, vs, fs);
  if (!prog) return null;
  prog.u_density = gl.getUniformLocation(prog, 'u_density');
  prog.u_maxW = gl.getUniformLocation(prog, 'u_maxW');
  return prog;
}

function _setupHeatResolveVAO(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._fsQuadVBO);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

function _ensureHeatFBO(gl, w, h) {
  // Use quarter-resolution to match Canvas 2D density grid (scale=4)
  const fw = Math.ceil(w / 4);
  const fh = Math.ceil(h / 4);
  if (gl._heatW === fw && gl._heatH === fh) return;

  if (gl._heatFBO) gl.deleteFramebuffer(gl._heatFBO);
  if (gl._heatTex) gl.deleteTexture(gl._heatTex);

  gl._heatTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, gl._heatTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, fw, fh, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl._heatFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, gl._heatFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gl._heatTex, 0);

  let fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
    console.warn('[GL] Heatmap FBO incomplete:', fbStatus, '— falling back to RGBA8');
    gl.bindTexture(gl.TEXTURE_2D, gl._heatTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gl._heatTex, 0);
    fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('[GL] Heatmap FBO still incomplete after RGBA8 fallback');
      gl._heatFBOBroken = true;
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  gl._heatW = fw;
  gl._heatH = fh;
}

function _createEdgeProgram(gl, vsSrc) {
  const vs = _compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = _compileShader(gl, gl.FRAGMENT_SHADER, EDGE_FS);
  if (!vs || !fs) return null;
  const prog = _linkProgram(gl, vs, fs);
  if (!prog) return null;
  prog.u_resolution = gl.getUniformLocation(prog, 'u_resolution');
  prog.u_width = gl.getUniformLocation(prog, 'u_width');
  return prog;
}

function _setupEdgeVAO(gl, quadVBO) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // Edge quad/strip verts (location 0) — per-vertex
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Instance data (locations 1-3) — per-instance
  // Layout: [startX, startY, endX, endY, r, g, b, a] = 8 floats = 32 bytes
  const STRIDE = 32;
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._instanceVBO);

  // location 1: start (2 floats)
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 0);
  gl.vertexAttribDivisor(1, 1);

  // location 2: end (2 floats)
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 8);
  gl.vertexAttribDivisor(2, 1);

  // location 3: color (4 floats)
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, 16);
  gl.vertexAttribDivisor(3, 1);

  gl.bindVertexArray(null);
  return vao;
}

function _setupCircleVAO(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // Quad verts (location 0) — per-vertex
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._quadVBO);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Instance data (locations 1-4) — per-instance
  // Layout: [cx, cy, radius, fillR, fillG, fillB, fillA, strokeR, strokeG, strokeB, strokeA]
  // = 11 floats per instance = 44 bytes
  const STRIDE = 44;
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._instanceVBO);

  // location 1: center (2 floats)
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 0);
  gl.vertexAttribDivisor(1, 1);

  // location 2: radius (1 float)
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 8);
  gl.vertexAttribDivisor(2, 1);

  // location 3: fill color (4 floats)
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, 12);
  gl.vertexAttribDivisor(3, 1);

  // location 4: stroke color (4 floats)
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 4, gl.FLOAT, false, STRIDE, 28);
  gl.vertexAttribDivisor(4, 1);

  gl.bindVertexArray(null);
  return vao;
}

// ─── Hex color parse cache ────────────────────────────────────────────────────

const _rgbCache = {};
function hexToRgb01(hex) {
  if (_rgbCache[hex]) return _rgbCache[hex];
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const result = [r, g, b];
  _rgbCache[hex] = result;
  return result;
}

function scaleSize(val, bz) {
  return bz.sizeLog ? Math.log2(val + 1) : val;
}

// ─── Edge hash (deterministic sampling, matches Canvas 2D renderer) ───────────

function edgeHash(i) {
  let h = (i * 2654435761) >>> 0;
  return (h & 0x7fffffff) / 0x80000000;
}

function maxEdgesToDraw(nodeCount) {
  return Math.min(5000, Math.max(200, nodeCount * 3));
}

// ─── Build edge instance data ─────────────────────────────────────────────────

function _buildEdgeInstances(bz) {
  const rz = bz.renderZoom;
  const W = bz.W, H = bz.H;
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const selIds = bz.selectedIds;
  const hasSel = selIds.size > 0;
  const hov = bz.hoveredId;

  const diag = Math.sqrt(W * W + H * H);
  const maxEdgeLen = diag * 1.2;
  const maxEdgeLenSq = maxEdgeLen * maxEdgeLen;
  const fadeStart = diag * 0.25;
  const fadeStartSq = fadeStart * fadeStart;
  const fadeRange = maxEdgeLen - fadeStart;

  let edges, nodeCount, getNode, getEdgeSrc, getEdgeDst, getEdgeWeight, getNodeId;

  if (isRaw) {
    edges = bz.edges;
    nodeCount = bz.nodes.length;
    getNode = id => bz.nodeIndexFull[id];
    getEdgeSrc = e => e.src;
    getEdgeDst = e => e.dst;
    getEdgeWeight = () => 1;
    getNodeId = id => id;
  } else {
    const level = bz.getLevel(bz.currentLevel);
    if (!level._snByBid) {
      level._snByBid = new Map();
      for (const sn of level.supernodes) level._snByBid.set(sn.bid, sn);
    }
    const snMap = level._snByBid;
    edges = level.snEdges;
    nodeCount = level.supernodes.length;
    getNode = id => snMap.get(id);
    getEdgeSrc = e => e.a;
    getEdgeDst = e => e.b;
    getEdgeWeight = e => e.weight;
    getNodeId = id => id;
  }

  const maxEdges = maxEdgesToDraw(nodeCount);
  const sampleRate = edges.length > maxEdges ? maxEdges / edges.length : 1;
  // 8 floats per edge instance: startX, startY, endX, endY, r, g, b, a
  const normalEdges = new Float32Array(Math.min(edges.length, maxEdges) * 8);
  let normalCount = 0;
  let drawn = 0;

  // Edge color: supernodes = accent purple, raw = muted blue-grey
  const eR = isRaw ? 100 / 255 : 124 / 255;
  const eG = isRaw ? 100 / 255 : 106 / 255;
  const eB = isRaw ? 140 / 255 : 247 / 255;
  const maxAlpha = isRaw ? 0.25 : 0.4;

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const a = getNode(getEdgeSrc(e)), b = getNode(getEdgeDst(e));
    if (!a || !b) continue;
    const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
    const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
    const dx = pax - pbx, dy = pay - pby;
    const distSq = dx * dx + dy * dy;
    if (distSq > maxEdgeLenSq) continue;
    if (sampleRate < 1) {
      if (edgeHash(i) > sampleRate * (2 - distSq / maxEdgeLenSq)) continue;
    }
    if (++drawn > maxEdges) break;
    const distFade = distSq <= fadeStartSq ? 1 : Math.max(0, 1 - (Math.sqrt(distSq) - fadeStart) / fadeRange);
    const w = getEdgeWeight(e);
    const alpha = isRaw ? maxAlpha * distFade : Math.min(maxAlpha, 0.05 + w * 0.05) * distFade;
    if (alpha < 0.01) continue;

    const off = normalCount * 8;
    normalEdges[off]     = pax;
    normalEdges[off + 1] = pay;
    normalEdges[off + 2] = pbx;
    normalEdges[off + 3] = pby;
    normalEdges[off + 4] = eR;
    normalEdges[off + 5] = eG;
    normalEdges[off + 6] = eB;
    normalEdges[off + 7] = alpha;
    normalCount++;
  }

  // Highlighted edges for selected/hovered
  if (hasSel || hov !== null) {
    const hBuf = new Float32Array(edges.length * 8);
    let hCount = 0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const srcId = getEdgeSrc(e), dstId = getEdgeDst(e);
      const aHit = selIds.has(srcId) || srcId === hov;
      const bHit = selIds.has(dstId) || dstId === hov;
      if (!aHit && !bHit) continue;
      const a = getNode(srcId), b = getNode(dstId);
      if (!a || !b) continue;
      const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
      const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
      const hiliteA = (selIds.has(srcId) || selIds.has(dstId)) ? 0.3 : 0.15;
      const off = hCount * 8;
      hBuf[off] = pax; hBuf[off+1] = pay; hBuf[off+2] = pbx; hBuf[off+3] = pby;
      hBuf[off+4] = 180/255; hBuf[off+5] = 180/255; hBuf[off+6] = 220/255; hBuf[off+7] = hiliteA;
      hCount++;
    }
    return {
      normalEdges: normalEdges.subarray(0, normalCount * 8),
      normalCount,
      hiliteEdges: hBuf.subarray(0, hCount * 8),
      hiliteCount: hCount,
    };
  }

  return {
    normalEdges: normalEdges.subarray(0, normalCount * 8),
    normalCount,
    hiliteEdges: new Float32Array(0),
    hiliteCount: 0,
  };
}

// ─── Build circle instance data ──────────────────────────────────────────────

function _buildCircleInstances(bz) {
  const rz = bz.renderZoom;
  const W = bz.W, H = bz.H;
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const selIds = bz.selectedIds;
  const hov = bz.hoveredId;

  let allNodes, cellPx, getColor, getId, getSizeVal;

  if (isRaw) {
    allNodes = bz.nodes;
    cellPx = (Math.min(W, H) * rz) / 256;
    getColor = n => bz._nodeColor(n);
    getId = n => n.id;
    getSizeVal = n => bz.sizeBy === 'edges' ? n.degree : 1;
  } else {
    const level = bz.getLevel(bz.currentLevel);
    allNodes = level.supernodes;
    const k = 1 << ZOOM_LEVELS[bz.currentLevel];
    cellPx = (Math.min(W, H) * rz) / k;
    getColor = n => n.cachedColor;
    getId = n => n.bid;
    getSizeVal = n => bz.sizeBy === 'edges' ? n.totalDegree : n.members.length;
  }

  const rMaxBase = isRaw
    ? Math.max(1, Math.min(cellPx * 0.40, 20))
    : Math.max(1.5, Math.min(cellPx * 0.42, 40));
  const rMin = isRaw ? 1 : 1.5;
  const rScale = isRaw ? 1.0 : 1.2;

  // Count visible nodes + compute maxSizeVal for importance
  let visibleCount = 0, maxSizeVal = 1;
  const margin = cellPx * 0.5;
  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const sx = n.x * rz + bz.pan.x, sy = n.y * rz + bz.pan.y;
    if (sx >= -margin && sx <= W + margin && sy >= -margin && sy <= H + margin) {
      visibleCount++;
      const sv = scaleSize(getSizeVal(n), bz);
      if (sv > maxSizeVal) maxSizeVal = sv;
    }
  }

  // Build circle + glow instances
  // 11 floats per instance
  const circles = new Float32Array(allNodes.length * 11);
  const glows = [];
  let circleCount = 0;

  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const px = n.x * rz + bz.pan.x;
    const py = n.y * rz + bz.pan.y;
    if (px < -rMaxBase || px > W + rMaxBase || py < -rMaxBase || py > H + rMaxBase) continue;

    const rawSizeVal = getSizeVal(n);
    const sizeVal = scaleSize(rawSizeVal, bz);
    const r = Math.max(rMin, Math.min(rMaxBase, rMin + Math.sqrt(sizeVal) * rScale));
    const col = getColor(n);
    const rgb = hexToRgb01(col);
    const nid = getId(n);
    const isSelected = selIds.has(nid);
    const isHovered = hov === nid;
    const importance = visibleCount > 50 ? 0.3 + 0.7 * Math.sqrt(sizeVal / maxSizeVal) : 1;

    // Supernodes: fill alpha = importance * 0x99/0xff, stroke globalAlpha = importance
    // Raw nodes: fill alpha = 0xbb/0xff = 0.73, stroke only on selected
    let fillA, strokeA;
    if (isRaw) {
      fillA = isSelected ? 1.0 : isHovered ? 0.8 : 0xbb / 0xff;
      strokeA = isSelected ? 1.0 : 0;
    } else {
      fillA = isSelected ? 1.0 : isHovered ? 0.8 : (importance * 0x99 / 0xff);
      strokeA = isSelected ? 1.0 : isHovered ? 1.0 : importance;
    }

    const off = circleCount * 11;
    circles[off]     = px;
    circles[off + 1] = py;
    circles[off + 2] = r;
    circles[off + 3] = rgb[0];
    circles[off + 4] = rgb[1];
    circles[off + 5] = rgb[2];
    circles[off + 6] = fillA;
    circles[off + 7] = isSelected ? 1.0 : rgb[0];
    circles[off + 8] = isSelected ? 1.0 : rgb[1];
    circles[off + 9] = isSelected ? 1.0 : rgb[2];
    circles[off + 10] = strokeA;
    circleCount++;

    // Glow for selected/hovered
    if (isSelected || isHovered) {
      const glowR = r * (isRaw ? 3 : 2.5);
      glows.push(px, py, glowR, rgb[0], rgb[1], rgb[2], isSelected ? 0.27 : 0.2, 0, 0, 0, 0);
    }
  }

  return { circles: circles.subarray(0, circleCount * 11), circleCount, glows: new Float32Array(glows), glowCount: glows.length / 11 };
}

// ─── Build heatmap splat instances ────────────────────────────────────────────

function _buildHeatInstances(bz) {
  const rz = bz.renderZoom;
  const W = bz.W, H = bz.H;
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;

  // Match Canvas 2D density kernel: operates on a 4x-downscaled grid
  const scale = 4;
  const gw = Math.ceil(W / scale);
  const gh = Math.ceil(H / scale);
  const kernelR = Math.max(8, Math.min(40, Math.min(gw, gh) / 8));

  // 11 floats per instance (same layout as circle VAO)
  // Positions and radius in FBO grid coordinates (screen / scale)
  const data = new Float32Array(allNodes.length * 11);
  let count = 0;

  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const sx = n.x * rz + bz.pan.x;
    const sy = n.y * rz + bz.pan.y;
    const gx = sx / scale;
    const gy = sy / scale;
    if (gx < -kernelR || gx > gw + kernelR || gy < -kernelR || gy > gh + kernelR) continue;

    let weight;
    if (isRaw) {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.degree + 1) : 1, bz);
    } else {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.totalDegree + 1) : n.members.length, bz);
    }

    const hexCol = isRaw ? bz._nodeColor(n) : n.cachedColor;
    const rgb = hexToRgb01(hexCol);

    const off = count * 11;
    data[off]     = gx;  // FBO-space x
    data[off + 1] = gy;  // FBO-space y
    data[off + 2] = kernelR; // FBO-space radius
    data[off + 3] = rgb[0];
    data[off + 4] = rgb[1];
    data[off + 5] = rgb[2];
    data[off + 6] = weight;
    data[off + 7] = 0;
    data[off + 8] = 0;
    data[off + 9] = 0;
    data[off + 10] = 0;
    count++;
  }

  return { data: data.subarray(0, count * 11), count, gw, gh };
}

// Compute maxW from FBO by reading back a small portion (expensive, so cached)
function _heatmapCacheKey(bz) {
  return bz.currentLevel + '|' + bz.renderZoom.toFixed(1) + '|' + bz.sizeBy + '|' + bz.sizeLog + '|' + bz.W + '|' + bz.H;
}

function _renderHeatmapDensity(gl, bz) {
  const W = bz.W, H = bz.H;
  _ensureHeatFBO(gl, W, H);
  if (gl._heatFBOBroken) return;
  const fw = gl._heatW, fh = gl._heatH;

  const { data, count, gw, gh } = _buildHeatInstances(bz);
  if (count === 0) return;

  // Pass 1: splat to FBO with additive blending
  // Positions are in FBO grid coordinates (screen / 4)
  gl.bindFramebuffer(gl.FRAMEBUFFER, gl._heatFBO);
  gl.viewport(0, 0, fw, fh);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE); // additive

  gl.useProgram(gl._heatSplatProg);
  gl.uniform2f(gl._heatSplatProg.u_resolution, gw, gh);

  gl.bindVertexArray(gl._circleVAO); // reuse circle VAO (same instance layout)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._instanceVBO);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Compute maxW on CPU using same kernel as Canvas 2D (quarter-res grid, weight-only)
  const cacheKey = _heatmapCacheKey(bz);
  if (cacheKey !== gl._heatMaxWKey) {
    const scale = 4;
    const gw = Math.ceil(W / scale);
    const gh = Math.ceil(H / scale);
    const kernelR = Math.max(8, Math.min(40, Math.min(gw, gh) / 8));
    const kernelRSq = kernelR * kernelR;
    const totalCells = gw * gh;

    // Allocate/reuse weight buffer
    if (!gl._heatWBuf || gl._heatWBuf.length < totalCells) {
      gl._heatWBuf = new Float32Array(totalCells);
    }
    gl._heatWBuf.fill(0);

    const rz = bz.renderZoom;
    const isRaw = bz.currentLevel === RAW_LEVEL;
    const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;

    for (let i = 0; i < allNodes.length; i++) {
      const n = allNodes[i];
      const gx = (n.x * rz + bz.pan.x) / scale;
      const gy = (n.y * rz + bz.pan.y) / scale;
      if (gx < -kernelR || gx > gw + kernelR || gy < -kernelR || gy > gh + kernelR) continue;

      let weight;
      if (isRaw) {
        weight = scaleSize(bz.sizeBy === 'edges' ? (n.degree + 1) : 1, bz);
      } else {
        weight = scaleSize(bz.sizeBy === 'edges' ? (n.totalDegree + 1) : n.members.length, bz);
      }

      const x0 = Math.max(0, gx - kernelR | 0);
      const x1 = Math.min(gw - 1, gx + kernelR + 1 | 0);
      const y0 = Math.max(0, gy - kernelR | 0);
      const y1 = Math.min(gh - 1, gy + kernelR + 1 | 0);

      for (let cy = y0; cy <= y1; cy++) {
        const dy = cy - gy;
        const dySq = dy * dy;
        const rowOff = cy * gw;
        for (let cx = x0; cx <= x1; cx++) {
          const dx = cx - gx;
          const distSq = dx * dx + dySq;
          if (distSq > kernelRSq) continue;
          const t = 1 - distSq / kernelRSq;
          gl._heatWBuf[rowOff + cx] += t * t * weight;
        }
      }
    }

    let maxW = 0;
    for (let i = 0; i < totalCells; i++) if (gl._heatWBuf[i] > maxW) maxW = gl._heatWBuf[i];

    gl._heatMaxWTarget = maxW || 1;
    gl._heatMaxWKey = cacheKey;
    gl._heatMaxWTime = performance.now();
    if (gl._heatMaxW === 0) gl._heatMaxW = gl._heatMaxWTarget;
  }

  // Lerp maxW
  const dt = performance.now() - gl._heatMaxWTime;
  const lerpA = 1 - Math.exp(-dt / 200);
  gl._heatMaxW += (gl._heatMaxWTarget - gl._heatMaxW) * lerpA;
  gl._heatMaxWTime = performance.now();

  if (gl._heatMaxW < 0.001) { gl.viewport(0, 0, W, H); return; }

  // Pass 2: resolve to screen
  gl.viewport(0, 0, W, H);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  gl.useProgram(gl._heatResolveProg);
  gl.uniform1i(gl._heatResolveProg.u_density, 0);
  gl.uniform1f(gl._heatResolveProg.u_maxW, gl._heatMaxW);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gl._heatTex);

  gl.bindVertexArray(gl._heatResolveVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.disable(gl.BLEND);

  // Keep rendering while maxW lerp hasn't converged (>1% difference)
  if (Math.abs(gl._heatMaxW - gl._heatMaxWTarget) > gl._heatMaxWTarget * 0.01) {
    bz.render();
  }
}

function _buildSplatInstances(bz) {
  const rz = bz.renderZoom;
  const W = bz.W, H = bz.H;
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;

  const data = new Float32Array(allNodes.length * 11);
  let count = 0;

  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const px = n.x * rz + bz.pan.x;
    const py = n.y * rz + bz.pan.y;
    const maxR = isRaw ? 200 : 400;
    if (px < -maxR || px > W + maxR || py < -maxR || py > H + maxR) continue;

    let weight;
    if (isRaw) {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.degree + 1) : 1, bz);
    } else {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.totalDegree + 1) : n.members.length, bz);
    }
    const r = Math.max(50, Math.min(maxR, 50 + Math.sqrt(weight) * 25));
    const hexCol = isRaw ? bz._nodeColor(n) : n.cachedColor;
    const rgb = hexToRgb01(hexCol);

    const off = count * 11;
    data[off]     = px;
    data[off + 1] = py;
    data[off + 2] = r;
    data[off + 3] = rgb[0];
    data[off + 4] = rgb[1];
    data[off + 5] = rgb[2];
    data[off + 6] = 0.15;
    data[off + 7] = 0;
    data[off + 8] = 0;
    data[off + 9] = 0;
    data[off + 10] = 0;
    count++;
  }

  return { data: data.subarray(0, count * 11), count };
}

function _renderHeatmapSplat(gl, bz) {
  const W = bz.W, H = bz.H;
  const { data, count } = _buildSplatInstances(bz);
  if (count === 0) return;

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive

  const glowProg = gl._circleProgram._glow;
  gl.useProgram(glowProg);
  gl.uniform2f(glowProg.u_resolution, W, H);

  gl.bindVertexArray(gl._circleVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl._instanceVBO);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);

  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.BLEND);
}

// ─── Main render ──────────────────────────────────────────────────────────────

/**
 * Render geometry to GL canvas.
 * @param {WebGL2RenderingContext} gl
 * @param {object} bz — BitZoomCanvas instance
 */
export function renderGL(gl, bz) {
  const W = bz.W, H = bz.H;
  if (W <= 0 || H <= 0) return;
  gl.viewport(0, 0, W, H);
  if (gl._clearR !== undefined) gl.clearColor(gl._clearR, gl._clearG, gl._clearB, 1);
  else gl.clearColor(10 / 255, 10 / 255, 15 / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // Layer order: grid → edges → heatmap → highlighted edges → glow halos → circles

  // Background grid
  const gridSize = 40 * bz.renderZoom;
  if (gridSize >= 4) {
    gl.useProgram(gl._gridProgram);
    gl.uniform2f(gl._gridProgram.u_resolution, W, H);
    gl.uniform1f(gl._gridProgram.u_gridSize, gridSize);
    gl.uniform2f(gl._gridProgram.u_pan, bz.pan.x % gridSize, bz.pan.y % gridSize);
    gl.bindVertexArray(gl._heatResolveVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  if (!bz.nodes || bz.nodes.length === 0) { gl.disable(gl.BLEND); return; }
  const edgeData = (bz.edgeMode !== 'none') ? _buildEdgeInstances(bz) : null;
  const useCurves = bz.edgeMode === 'curves';
  const edgeProg = useCurves ? gl._edgeCurveProgram : gl._edgeLineProgram;
  const edgeVAO = useCurves ? gl._edgeCurveVAO : gl._edgeLineVAO;
  const edgeVertCount = useCurves ? (gl._curveSegCount + 1) * 2 : 4;

  // Normal edges
  if (edgeData && edgeData.normalCount > 0) {
    gl.useProgram(edgeProg);
    gl.uniform2f(edgeProg.u_resolution, W, H);
    gl.uniform1f(edgeProg.u_width, 1.0);
    gl.bindVertexArray(edgeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl._instanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, edgeData.normalEdges, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, edgeVertCount, edgeData.normalCount);
  }

  // Heatmap
  if (bz.heatmapMode === 'density') {
    _renderHeatmapDensity(gl, bz);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  } else if (bz.heatmapMode === 'splat') {
    _renderHeatmapSplat(gl, bz);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // Highlighted edges (after heatmap, before circles)
  if (edgeData && edgeData.hiliteCount > 0) {
    gl.useProgram(edgeProg);
    gl.uniform2f(edgeProg.u_resolution, W, H);
    gl.uniform1f(edgeProg.u_width, 2.0);
    gl.bindVertexArray(edgeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl._instanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, edgeData.hiliteEdges, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, edgeVertCount, edgeData.hiliteCount);
  }

  // Circles
  const { circles, circleCount, glows, glowCount } = _buildCircleInstances(bz);
  if (circleCount > 0) {
    // Glow halos (behind circles)
    if (glowCount > 0) {
      const glowProg = gl._circleProgram._glow;
      gl.useProgram(glowProg);
      gl.uniform2f(glowProg.u_resolution, W, H);
      gl.bindVertexArray(gl._circleVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl._instanceVBO);
      gl.bufferData(gl.ARRAY_BUFFER, glows, gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glowCount);
    }

    // Circle fills
    gl.useProgram(gl._circleProgram);
    gl.uniform2f(gl._circleProgram.u_resolution, W, H);
    gl.bindVertexArray(gl._circleVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl._instanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, circles, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, circleCount);
  }

  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
}
