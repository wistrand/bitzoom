// bitzoom-gpu.js — WebGPU compute for MinHash + projection.
// Takes pre-hashed token values (uint32) and computes signatures + 2D projections.
// Falls back gracefully: callers should check `await initGPU()` before using.

import { MINHASH_K, LARGE_PRIME, HASH_PARAMS_A, HASH_PARAMS_B, mulberry32, hashToken, buildGaussianProjection, STRENGTH_FLOOR_RATIO, STRENGTH_FLOOR_MIN, normalizeAndQuantize, gaussianQuantize } from './bitzoom-algo.js';
import { tokenizeLabel, tokenizeNumeric, degreeBucket } from './bitzoom-pipeline.js';

let device = null;
let pipeline = null;

// ─── Shader ──────────────────────────────────────────────────────────────────

const WGSL = /* wgsl */ `
// Constants
const K: u32 = 128u;
const P: u32 = 2147483647u; // 2^31 - 1 (Mersenne prime)
const OPH_THRESHOLD: u32 = 12u;

// Bindings
@group(0) @binding(0) var<storage, read> tokens: array<u32>;       // flat: all hashed tokens
@group(0) @binding(1) var<storage, read> taskMeta: array<u32>;     // per-task: [offset, count, groupIdx] packed as 3 × u32
@group(0) @binding(2) var<storage, read> hashParams: array<i32>;   // [A[0..127], B[0..127]] concatenated (256 i32)
@group(0) @binding(3) var<storage, read> projMatrix: array<f32>;   // G groups × 2 × K floats
@group(0) @binding(4) var<storage, read_write> output: array<f32>; // per-task: 2 floats (px, py)

// Mersenne fast-mod: x mod (2^31 - 1). Input x < 2^32.
fn mersMod(x: u32) -> u32 {
  var r = (x & P) + (x >> 31u);
  if (r >= P) { r -= P; }
  return r;
}

// Multiply-mod: (a * b) mod P, where a,b < P (< 2^31).
// Replicates the CPU's hashSlot strategy: split b into 16-bit halves,
// compute a*bHi and a*bLo separately, then combine with mersMod.
// a*bHi: a < 2^31, bHi < 2^16 → product < 2^47. Exceeds u32.
// Split a into halves too: a = aHi*2^16 + aLo.
// a*bHi = (aHi*bHi)*2^16 + aLo*bHi — each partial < 2^32.
// Then mersMod the reassembled value.
// (a * b) mod P where a, b < 2^32. Every addition is reduced individually
// to prevent u32 overflow. mersMod inputs must be < 2^32.
fn mulMod(a: u32, b: u32) -> u32 {
  let bHi = b >> 16u;
  let bLo = b & 0xFFFFu;
  let aHi = a >> 16u;
  let aLo = a & 0xFFFFu;

  // Step 1: hi = (a * bHi) mod P
  // = (aHi*bHi*2^16 + aLo*bHi) mod P
  let p1 = aHi * bHi;                       // < 2^32
  var hi = mersMod(p1 << 16u);              // low 32 bits of p1*2^16
  hi = mersMod(hi + (p1 >> 16u) * 2u);     // carry: p1>>16 * 2^32 ≡ p1>>16 * 2
  let p2 = aLo * bHi;                       // < 2^32
  hi = mersMod(hi + mersMod(p2));           // reduce p2 first since hi+p2 can overflow

  // Step 2: (hi * 2^16 + a * bLo) mod P
  let hiLo = hi & 0xFFFFu;
  let hiHi = hi >> 16u;
  var r = mersMod(hiLo << 16u);             // low part of hi * 2^16
  r = mersMod(r + hiHi * 2u);              // carry of hi * 2^16

  let q1 = aHi * bLo;                       // < 2^32
  r = mersMod(r + mersMod(q1 << 16u));     // low part of aHi*bLo*2^16
  r = mersMod(r + (q1 >> 16u) * 2u);       // carry of aHi*bLo*2^16

  let q2 = aLo * bLo;                       // < 2^32
  r = mersMod(r + mersMod(q2));             // reduce q2 first

  return r;
}

fn hashSlot(a: i32, tv: u32, b: i32) -> u32 {
  let au = u32(a);
  let bu = u32(b);
  let product = mulMod(au, tv);
  var result = product + bu;
  // result can exceed P; need mersMod
  result = mersMod(result);
  return result;
}

fn getParamA(i: u32) -> i32 { return hashParams[i]; }
fn getParamB(i: u32) -> i32 { return hashParams[K + i]; }

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let taskId = gid.x;
  let numTasks = arrayLength(&taskMeta) / 3u;
  if (taskId >= numTasks) { return; }

  let off = taskMeta[taskId * 3u];
  let tc = taskMeta[taskId * 3u + 1u];
  let groupIdx = taskMeta[taskId * 3u + 2u];
  let outOff = taskId * 2u;

  // Empty token set → neutral [0, 0]
  if (tc == 0u) {
    output[outOff] = 0.0;
    output[outOff + 1u] = 0.0;
    return;
  }

  // Compute MinHash signature in local array
  var sig: array<f32, 128>;

  if (tc < OPH_THRESHOLD) {
    // Standard MinHash: k hash evaluations per token
    for (var i = 0u; i < K; i++) { sig[i] = f32(P); }
    for (var t = 0u; t < tc; t++) {
      let tv = tokens[off + t];
      for (var j = 0u; j < K; j++) {
        let hv = hashSlot(getParamA(j), tv, getParamB(j));
        if (f32(hv) < sig[j]) { sig[j] = f32(hv); }
      }
    }
  } else {
    // OPH: single hash per token, densify empty bins
    var occupied: array<u32, 4>; // 128 bits as 4 × u32
    for (var i = 0u; i < 4u; i++) { occupied[i] = 0u; }
    for (var i = 0u; i < K; i++) { sig[i] = f32(P); }

    for (var t = 0u; t < tc; t++) {
      let tv = tokens[off + t];
      let hv = hashSlot(getParamA(0u), tv, getParamB(0u));
      let bin = hv % K;
      let val = hv / K;
      if (f32(val) < sig[bin]) {
        sig[bin] = f32(val);
        occupied[bin >> 5u] |= (1u << (bin & 31u));
      }
    }

    // Densify empty bins (Knuth multiplicative hash for donor search)
    for (var i = 0u; i < K; i++) {
      if ((occupied[i >> 5u] & (1u << (i & 31u))) != 0u) { continue; }
      var donor = (i * 2654435761u) % K;
      var attempts = 0u;
      loop {
        if (attempts >= K) { break; }
        if ((occupied[donor >> 5u] & (1u << (donor & 31u))) != 0u) { break; }
        donor = (donor * 2654435761u + 1u) % K;
        attempts++;
      }
      if ((occupied[donor >> 5u] & (1u << (donor & 31u))) != 0u) {
        sig[i] = sig[donor];
      }
    }
  }

  // Z-score normalize
  var mean: f32 = 0.0;
  for (var i = 0u; i < K; i++) { mean += sig[i]; }
  mean /= f32(K);
  var variance: f32 = 0.0;
  for (var i = 0u; i < K; i++) {
    let d = sig[i] - mean;
    variance += d * d;
  }
  var sd = sqrt(variance / f32(K));
  // When variance is near-zero (uniform signature), output neutral [0,0].
  // Matches CPU behavior: std=0 → fallback std=1 → all (sig-mean)/1 = 0 → projection = 0.
  // Degenerate signature (all/nearly all same value): variance accumulates float32
  // rounding errors. CPU gets exact 0 variance → [0,0]. Match that behavior.
  if (sd < mean * 1e-5 || sd < 1.0) {
    output[outOff] = 0.0;
    output[outOff + 1u] = 0.0;
    return;
  }

  // Project to 2D using the group's projection matrix
  let projOff = groupIdx * 2u * K;
  var px: f32 = 0.0;
  var py: f32 = 0.0;
  for (var i = 0u; i < K; i++) {
    let v = (sig[i] - mean) / sd;
    px += v * projMatrix[projOff + i];
    py += v * projMatrix[projOff + K + i];
  }

  output[outOff] = px;
  output[outOff + 1u] = py;
}
`;

// ─── Initialization ──────────────────────────────────────────────────────────

export async function initGPU() {
  if (device) return true;
  if (!navigator.gpu) { console.log('[GPU] navigator.gpu not available'); return false; }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { console.log('[GPU] No GPU adapter found'); return false; }
  try { const info = adapter.info || {}; console.log('[GPU] Adapter:', info.vendor || 'unknown', info.architecture || '', info.device || ''); } catch {}
  device = await adapter.requestDevice();
  console.log('[GPU] Device acquired, maxStorageBuffersPerShaderStage:', device.limits.maxStorageBuffersPerShaderStage);

  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: WGSL });
  const info = await module.getCompilationInfo();
  for (const msg of info.messages) {
    if (msg.type === 'error') console.error('WGSL error:', msg.message, 'line:', msg.lineNum);
  }
  pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const err = await device.popErrorScope();
  if (err) { console.error('Pipeline creation error:', err.message); return false; }
  return true;
}

// ─── GPU MinHash + Projection ────────────────────────────────────────────────

/**
 * Compute MinHash signatures and 2D projections on the GPU.
 *
 * @param {Uint32Array} allTokens - flat array of pre-hashed token values
 * @param {Uint32Array} taskOffsets - per-task start index into allTokens
 * @param {Uint32Array} taskCounts - per-task token count
 * @param {Uint32Array} taskGroups - per-task group index (selects projection matrix)
 * @param {Float32Array} projMatrices - flat: G groups × 2 × 128 floats
 * @returns {Promise<Float32Array>} - per-task [px, py] pairs (length = tasks × 2)
 */
export async function gpuMinHashProject(allTokens, taskOffsets, taskCounts, taskGroups, projMatrices) {
  if (!device || !pipeline) throw new Error('GPU not initialized. Call initGPU() first.');

  const numTasks = taskCounts.length;

  const createBuf = (data, usage) => {
    const size = Math.max(256, data.byteLength); // minimum 256 bytes (GPU alignment)
    const buf = device.createBuffer({ size, usage, mappedAtCreation: true });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buf.unmap();
    return buf;
  };

  const STORAGE = GPUBufferUsage.STORAGE;

  // Pack task metadata: [offset, count, groupIdx] × numTasks
  const taskMeta = new Uint32Array(numTasks * 3);
  for (let i = 0; i < numTasks; i++) {
    taskMeta[i * 3] = taskOffsets[i];
    taskMeta[i * 3 + 1] = taskCounts[i];
    taskMeta[i * 3 + 2] = taskGroups[i];
  }

  // Pack hash params: [A[0..127], B[0..127]]
  const hashParams = new Int32Array(MINHASH_K * 2);
  hashParams.set(HASH_PARAMS_A, 0);
  hashParams.set(HASH_PARAMS_B, MINHASH_K);

  const tokensBuf = createBuf(allTokens, STORAGE);
  const metaBuf = createBuf(taskMeta, STORAGE);
  const paramsBuf = createBuf(hashParams, STORAGE);
  const projBuf = createBuf(projMatrices, STORAGE);

  const outputSize = Math.max(256, numTasks * 2 * 4);
  const outputBuf = device.createBuffer({ size: outputSize, usage: STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: tokensBuf } },
      { binding: 1, resource: { buffer: metaBuf } },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: projBuf } },
      { binding: 4, resource: { buffer: outputBuf } },
    ],
  });

  // Dispatch
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(numTasks / 64));
  pass.end();
  encoder.copyBufferToBuffer(outputBuf, 0, readBuf, 0, outputSize);
  device.queue.submit([encoder.finish()]);

  // Read back
  await readBuf.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuf.getMappedRange()).slice();
  readBuf.unmap();

  // Cleanup
  tokensBuf.destroy(); metaBuf.destroy(); paramsBuf.destroy();
  projBuf.destroy(); outputBuf.destroy(); readBuf.destroy();

  return result;
}

// ─── High-level: GPU-accelerated computeProjections ──────────────────────────
// Drop-in replacement for pipeline's computeProjections. Tokenizes on CPU,
// hashes to uint32, ships to GPU for MinHash + projection.
// Returns { projBuf, groupNames } — same format as the CPU version.

export async function computeProjectionsGPU(nodeArray, adjGroups, groupNames, hasEdgeTypes, extraPropNames, numericBins) {
  numericBins = numericBins || {};
  const N = nodeArray.length;
  const G = groupNames.length;
  const gIdx = {};
  for (let i = 0; i < G; i++) gIdx[groupNames[i]] = i;

  // Build projection matrices (same seeds as CPU)
  const projMatrices = new Float32Array(G * 2 * MINHASH_K);
  for (let g = 0; g < G; g++) {
    const R = buildGaussianProjection(2001 + g, MINHASH_K);
    for (let i = 0; i < MINHASH_K; i++) {
      projMatrices[g * 2 * MINHASH_K + i] = R[0][i];
      projMatrices[g * 2 * MINHASH_K + MINHASH_K + i] = R[1][i];
    }
  }

  // CPU: tokenize all nodes × all groups, hash to uint32
  const tokenBuf = new Array(200);
  const allHashed = [];   // flat uint32 array of all hashed tokens
  const taskOffsets = [];  // per-task: start index in allHashed
  const taskCounts = [];   // per-task: token count
  const taskGroups = [];   // per-task: group index

  for (let idx = 0; idx < N; idx++) {
    const n = nodeArray[idx];

    // group
    taskOffsets.push(allHashed.length);
    allHashed.push(hashToken('group:' + n.group));
    taskCounts.push(1);
    taskGroups.push(gIdx.group);

    // label
    taskOffsets.push(allHashed.length);
    const labelEnd = tokenizeLabel(n.label, n.id, tokenBuf, 0);
    for (let t = 0; t < labelEnd; t++) allHashed.push(hashToken(tokenBuf[t]));
    taskCounts.push(labelEnd);
    taskGroups.push(gIdx.label);

    // structure
    taskOffsets.push(allHashed.length);
    allHashed.push(hashToken('deg:' + degreeBucket(n.degree)));
    allHashed.push(hashToken('leaf:' + (n.degree === 0)));
    taskCounts.push(2);
    taskGroups.push(gIdx.structure);

    // neighbors
    taskOffsets.push(allHashed.length);
    const adj = adjGroups[idx];
    if (adj.length > 0) {
      for (let ai = 0; ai < adj.length; ai++) allHashed.push(hashToken('ngroup:' + adj[ai]));
      taskCounts.push(adj.length);
    } else {
      allHashed.push(hashToken('ngroup:isolated'));
      taskCounts.push(1);
    }
    taskGroups.push(gIdx.neighbors);

    // edge types
    if (hasEdgeTypes) {
      taskOffsets.push(allHashed.length);
      if (n.edgeTypes && n.edgeTypes.length > 0) {
        for (let ei = 0; ei < n.edgeTypes.length; ei++) allHashed.push(hashToken('etype:' + n.edgeTypes[ei]));
        taskCounts.push(n.edgeTypes.length);
      } else {
        allHashed.push(hashToken('etype:none'));
        taskCounts.push(1);
      }
      taskGroups.push(gIdx.edgetype);
    }

    // extra props
    for (let epi = 0; epi < extraPropNames.length; epi++) {
      const ep = extraPropNames[epi];
      const val = n.extraProps && n.extraProps[ep];
      taskOffsets.push(allHashed.length);
      const epEnd = tokenizeNumeric(ep, val, numericBins[ep], tokenBuf, 0);
      for (let t = 0; t < epEnd; t++) allHashed.push(hashToken(tokenBuf[t]));
      taskCounts.push(epEnd);
      taskGroups.push(gIdx[ep]);
    }
  }

  // GPU: MinHash + projection
  const gpuResult = await gpuMinHashProject(
    new Uint32Array(allHashed),
    new Uint32Array(taskOffsets),
    new Uint32Array(taskCounts),
    new Uint32Array(taskGroups),
    projMatrices
  );

  // Unpack GPU result into projBuf (same layout as CPU: N × G × 2 float64)
  // Tasks are emitted per node in order: group, label, structure, neighbors,
  // [edgetype], extra0, extra1, ... — use taskGroups to map to correct group slot.
  const projBuf = new Float64Array(N * G * 2);
  const tasksPerNode = taskGroups.length / N;
  for (let idx = 0; idx < N; idx++) {
    const baseTask = idx * tasksPerNode;
    for (let t = 0; t < tasksPerNode; t++) {
      const g = taskGroups[baseTask + t];
      projBuf[idx * G * 2 + g * 2] = gpuResult[(baseTask + t) * 2];
      projBuf[idx * G * 2 + g * 2 + 1] = gpuResult[(baseTask + t) * 2 + 1];
    }
  }

  return { projBuf, groupNames };
}

// ─── GPU Blend ───────────────────────────────────────────────────────────────

const BLEND_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> propAnchors: array<f32>; // interleaved [px0,py0,px1,py1,...]
@group(0) @binding(1) var<storage, read> adjOffsets: array<u32>;  // CSR offsets [N+1]
@group(0) @binding(2) var<storage, read> adjTargets: array<u32>;  // CSR neighbor indices
@group(0) @binding(3) var<storage, read> posIn: array<f32>;       // read positions from previous pass
@group(0) @binding(4) var<storage, read_write> posOut: array<f32>; // write new positions

struct Params {
  alpha: f32,
  N: u32,
}
@group(0) @binding(5) var<uniform> params: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.N) { return; }

  let alpha = params.alpha;
  let propX = propAnchors[i * 2u];
  let propY = propAnchors[i * 2u + 1u];

  let adjStart = adjOffsets[i];
  let adjEnd = adjOffsets[i + 1u];
  let degree = adjEnd - adjStart;

  if (degree == 0u) {
    posOut[i * 2u] = propX;
    posOut[i * 2u + 1u] = propY;
    return;
  }

  var nx: f32 = 0.0;
  var ny: f32 = 0.0;
  for (var e = adjStart; e < adjEnd; e++) {
    let j = adjTargets[e];
    nx += posIn[j * 2u];
    ny += posIn[j * 2u + 1u];
  }
  nx /= f32(degree);
  ny /= f32(degree);

  posOut[i * 2u] = (1.0 - alpha) * propX + alpha * nx;
  posOut[i * 2u + 1u] = (1.0 - alpha) * propY + alpha * ny;
}
`;

let blendPipeline = null;

async function ensureBlendPipeline() {
  if (blendPipeline) return;
  if (!device) throw new Error('GPU not initialized');
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: BLEND_WGSL });
  const info = await module.getCompilationInfo();
  for (const msg of info.messages) {
    if (msg.type === 'error') console.error('[GPU] Blend WGSL error:', msg.message, 'line:', msg.lineNum);
  }
  blendPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const err = await device.popErrorScope();
  if (err) console.error('[GPU] Blend pipeline error:', err.message);
  else console.log('[GPU] Blend pipeline ready');
}

/**
 * GPU topology blend. Matches CPU unifiedBlend (property anchor + neighbor avg).
 *
 * @param {object[]} nodes - node array with .projections, .id, .degree
 * @param {string[]} groupNames
 * @param {object} propStrengths - { groupName: strength }
 * @param {number} smoothAlpha - topology weight 0..1
 * @param {object} adjList - { nodeId: [neighborId, ...] }
 * @param {object} nodeIndexFull - { nodeId: node }
 * @param {number} passes
 * @returns {Promise<{px: Float32Array, py: Float32Array}>} blended positions
 */
// Cached GPU buffers — reused across blend calls for the same dataset.
// Invalidated when N or edge count changes (new dataset load).
let _blendCache = null;

function getBlendCache(N, totalEdges) {
  if (_blendCache && _blendCache.N === N && _blendCache.totalEdges === totalEdges) return _blendCache;
  // Destroy old cache
  if (_blendCache) {
    for (const buf of Object.values(_blendCache.bufs)) buf.destroy();
  }
  const S = GPUBufferUsage.STORAGE;
  const posSize = Math.max(256, N * 2 * 4);
  const bufs = {
    propAnchors: device.createBuffer({ size: posSize, usage: S | GPUBufferUsage.COPY_DST }),
    adjOffsets: device.createBuffer({ size: Math.max(256, (N + 1) * 4), usage: S | GPUBufferUsage.COPY_DST }),
    adjTargets: device.createBuffer({ size: Math.max(256, Math.max(1, totalEdges) * 4), usage: S | GPUBufferUsage.COPY_DST }),
    posA: device.createBuffer({ size: posSize, usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }),
    posB: device.createBuffer({ size: posSize, usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }),
    params: device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    read: device.createBuffer({ size: Math.max(256, N * 2 * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
  };
  _blendCache = { N, totalEdges, bufs, adjUploaded: false, bgAtoB: null, bgBtoA: null };
  return _blendCache;
}

export async function gpuBlend(nodes, groupNames, propStrengths, smoothAlpha, adjList, nodeIndexFull, passes, propBearings = null) {
  await ensureBlendPipeline();
  const prof = _gpuBlendProfiling;
  const t_total = prof ? performance.now() : 0;

  const N = nodes.length;
  const alpha = Math.max(0, Math.min(1, smoothAlpha));

  // ── Anchor computation ──────────────────────────────────────────────────
  const t_anchor = prof ? performance.now() : 0;

  let maxW = 0;
  for (const g of groupNames) { const raw = propStrengths[g] || 0; if (raw > maxW) maxW = raw; }
  const floor = Math.max(maxW * STRENGTH_FLOOR_RATIO, STRENGTH_FLOOR_MIN);
  let propTotal = 0;
  const effW = {};
  for (const g of groupNames) { effW[g] = Math.max(propStrengths[g] || 0, floor); propTotal += effW[g]; }

  const G = groupNames.length;
  let cosBearing = null, sinBearing = null, hasAnyBearing = false;
  if (propBearings) {
    for (const g of groupNames) { if (propBearings[g]) { hasAnyBearing = true; break; } }
    if (hasAnyBearing) {
      cosBearing = new Float64Array(G);
      sinBearing = new Float64Array(G);
      for (let gi = 0; gi < G; gi++) {
        const theta = propBearings[groupNames[gi]] || 0;
        cosBearing[gi] = Math.cos(theta);
        sinBearing[gi] = Math.sin(theta);
      }
    }
  }

  const propAnchorsArr = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const nd = nodes[i];
    let px = 0, py = 0;
    if (hasAnyBearing) {
      for (let gi = 0; gi < G; gi++) {
        const g = groupNames[gi];
        const p = nd.projections[g];
        if (p) {
          const gx = p[0], gy = p[1];
          px += (gx * cosBearing[gi] - gy * sinBearing[gi]) * effW[g];
          py += (gx * sinBearing[gi] + gy * cosBearing[gi]) * effW[g];
        }
      }
    } else {
      for (const g of groupNames) {
        const p = nd.projections[g];
        if (p) { px += p[0] * effW[g]; py += p[1] * effW[g]; }
      }
    }
    propAnchorsArr[i * 2] = px / propTotal;
    propAnchorsArr[i * 2 + 1] = py / propTotal;
  }
  const anchorComputeMs = prof ? performance.now() - t_anchor : 0;

  // ── CSR adjacency (cached — only rebuilt when dataset changes) ────────
  const t_csr = prof ? performance.now() : 0;

  let totalEdges, adjOffsetsArr, adjTargetsArr;
  if (_blendCache && _blendCache.N === N && _blendCache.csrOffsets) {
    // Reuse cached CSR from previous blend (same nodes/edges, different strengths)
    totalEdges = _blendCache.totalEdges;
    adjOffsetsArr = _blendCache.csrOffsets;
    adjTargetsArr = _blendCache.csrTargets;
  } else {
    const idToIdx = {};
    for (let i = 0; i < N; i++) idToIdx[nodes[i].id] = i;

    adjOffsetsArr = new Uint32Array(N + 1);
    totalEdges = 0;
    for (let i = 0; i < N; i++) {
      adjOffsetsArr[i] = totalEdges;
      const nbrs = adjList[nodes[i].id];
      if (nbrs) {
        for (const nid of nbrs) { if (idToIdx[nid] !== undefined) totalEdges++; }
      }
    }
    adjOffsetsArr[N] = totalEdges;

    adjTargetsArr = new Uint32Array(totalEdges);
    let ei = 0;
    for (let i = 0; i < N; i++) {
      const nbrs = adjList[nodes[i].id];
      if (nbrs) {
        for (const nid of nbrs) {
          const j = idToIdx[nid];
          if (j !== undefined) adjTargetsArr[ei++] = j;
        }
      }
    }
  }
  const csrBuildMs = prof ? performance.now() - t_csr : 0;

  // ── Buffer upload ─────────────────────────────────────────────────────
  const t_upload = prof ? performance.now() : 0;

  const cache = getBlendCache(N, totalEdges);
  // Store CSR arrays in cache for reuse on subsequent blends
  cache.csrOffsets = adjOffsetsArr;
  cache.csrTargets = adjTargetsArr;
  const b = cache.bufs;

  device.queue.writeBuffer(b.propAnchors, 0, propAnchorsArr);

  if (!cache.adjUploaded) {
    device.queue.writeBuffer(b.adjOffsets, 0, adjOffsetsArr);
    device.queue.writeBuffer(b.adjTargets, 0, adjTargetsArr.length > 0 ? adjTargetsArr : new Uint32Array(1));
    cache.adjUploaded = true;
  }

  if (alpha === 0 || passes === 0) {
    if (prof) {
      _lastBlendProfile = { N, totalEdges, passes, anchorComputeMs, csrBuildMs,
        bufferUploadMs: performance.now() - t_upload, bindGroupCreateMs: 0,
        gpuDispatchMs: 0, gpuFenceMs: 0, mapMs: 0, readbackMs: 0, deinterleaveMs: 0,
        totalMs: performance.now() - t_total };
      console.log(`[GPU profile] N=${N} E=${totalEdges} p=${passes} — early return (α=0)`);
    }
    const outPx = new Float32Array(N);
    const outPy = new Float32Array(N);
    for (let i = 0; i < N; i++) { outPx[i] = propAnchorsArr[i * 2]; outPy[i] = propAnchorsArr[i * 2 + 1]; }
    return { px: outPx, py: outPy };
  }

  // Initial positions = property anchors (same interleaved layout as posA)
  device.queue.writeBuffer(b.posA, 0, propAnchorsArr);

  const paramsData = new ArrayBuffer(16);
  new Float32Array(paramsData, 0, 1)[0] = alpha;
  new Uint32Array(paramsData, 4, 1)[0] = N;
  device.queue.writeBuffer(b.params, 0, new Uint8Array(paramsData));
  const bufferUploadMs = prof ? performance.now() - t_upload : 0;

  // ── Bind groups ───────────────────────────────────────────────────────
  const t_bind = prof ? performance.now() : 0;

  if (!cache.bgAtoB) {
    cache.bgAtoB = device.createBindGroup({
      layout: blendPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: b.propAnchors } },
        { binding: 1, resource: { buffer: b.adjOffsets } },
        { binding: 2, resource: { buffer: b.adjTargets } },
        { binding: 3, resource: { buffer: b.posA } },
        { binding: 4, resource: { buffer: b.posB } },
        { binding: 5, resource: { buffer: b.params } },
      ],
    });
    cache.bgBtoA = device.createBindGroup({
      layout: blendPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: b.propAnchors } },
        { binding: 1, resource: { buffer: b.adjOffsets } },
        { binding: 2, resource: { buffer: b.adjTargets } },
        { binding: 3, resource: { buffer: b.posB } },
        { binding: 4, resource: { buffer: b.posA } },
        { binding: 5, resource: { buffer: b.params } },
      ],
    });
  }
  const bgAtoB = cache.bgAtoB;
  const bgBtoA = cache.bgBtoA;
  const bindGroupCreateMs = prof ? performance.now() - t_bind : 0;

  // ── GPU dispatch ──────────────────────────────────────────────────────
  const t_dispatch = prof ? performance.now() : 0;

  const workgroups = Math.ceil(N / 64);
  const encoder = device.createCommandEncoder();
  for (let pass = 0; pass < passes; pass++) {
    const comp = encoder.beginComputePass();
    comp.setPipeline(blendPipeline);
    comp.setBindGroup(0, (pass % 2 === 0) ? bgAtoB : bgBtoA);
    comp.dispatchWorkgroups(workgroups);
    comp.end();
  }
  const finalBuf = (passes % 2 === 1) ? b.posB : b.posA;
  encoder.copyBufferToBuffer(finalBuf, 0, b.read, 0, N * 2 * 4);
  device.queue.submit([encoder.finish()]);
  const gpuDispatchMs = prof ? performance.now() - t_dispatch : 0;

  // ── GPU fence + readback ──────────────────────────────────────────────
  const t_readback = prof ? performance.now() : 0;

  // onSubmittedWorkDone resolves when GPU finishes compute+copy (before DMA to CPU).
  // Separates GPU kernel time from the mapAsync DMA transfer.
  let gpuFenceMs = 0;
  if (prof) {
    await device.queue.onSubmittedWorkDone();
    gpuFenceMs = performance.now() - t_readback;
  }

  const t_map = prof ? performance.now() : 0;
  await b.read.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(b.read.getMappedRange()).slice(0, N * 2);
  b.read.unmap();
  const mapMs = prof ? performance.now() - t_map : 0;
  const readbackMs = prof ? gpuFenceMs + mapMs : 0;

  // ── Deinterleave ──────────────────────────────────────────────────────
  const t_deinterleave = prof ? performance.now() : 0;

  const outPx = new Float32Array(N);
  const outPy = new Float32Array(N);
  for (let i = 0; i < N; i++) { outPx[i] = result[i * 2]; outPy[i] = result[i * 2 + 1]; }
  const deinterleaveMs = prof ? performance.now() - t_deinterleave : 0;

  if (prof) {
    const totalMs = performance.now() - t_total;
    _lastBlendProfile = { N, totalEdges, passes, anchorComputeMs, csrBuildMs,
      bufferUploadMs, bindGroupCreateMs, gpuDispatchMs, gpuFenceMs, mapMs, readbackMs, deinterleaveMs, totalMs };
    console.log(`[GPU profile] N=${N} E=${totalEdges} p=${passes} — anchor:${anchorComputeMs.toFixed(1)} csr:${csrBuildMs.toFixed(1)} upload:${bufferUploadMs.toFixed(1)} bind:${bindGroupCreateMs.toFixed(1)} dispatch:${gpuDispatchMs.toFixed(1)} fence:${gpuFenceMs.toFixed(1)} map:${mapMs.toFixed(1)} deinterleave:${deinterleaveMs.toFixed(1)} total:${totalMs.toFixed(1)}ms`);
  }

  return { px: outPx, py: outPy };
}

// ─── High-level GPU blend (drop-in for unifiedBlend) ─────────────────────────

/**
 * GPU-accelerated drop-in replacement for unifiedBlend.
 * Same signature: modifies nodes[i].px, .py, .gx, .gy in place.
 */
export async function gpuUnifiedBlend(nodes, groupNames, propStrengths, smoothAlpha, adjList, nodeIndexFull, passes, quantMode, quantStats, propBearings = null) {
  const result = await gpuBlend(nodes, groupNames, propStrengths, smoothAlpha, adjList, nodeIndexFull, passes, propBearings);

  // Apply blended positions to nodes
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].px = result.px[i];
    nodes[i].py = result.py[i];
  }

  // Quantize on CPU
  if (quantMode === 'gaussian') gaussianQuantize(nodes, quantStats || {});
  else normalizeAndQuantize(nodes);
}

export function destroyGPU() {
  if (device) { device.destroy(); device = null; pipeline = null; blendPipeline = null; }
}

// ─── Profiling ──────────────────────────────────────────────────────────────

let _gpuBlendProfiling = false;
let _lastBlendProfile = null;
export function setGpuBlendProfiling(enabled) { _gpuBlendProfiling = !!enabled; }
export function getLastBlendProfile() { return _lastBlendProfile; }
