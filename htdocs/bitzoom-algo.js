// bitzoom-algo.js — Pure algorithm functions and constants.
// No DOM, no canvas, no state. Shared by main thread and conceptually by worker.

// Find key with highest count in an object {key: count} — O(k) instead of sort O(k log k)
// Tie-break: first key in insertion order (stable across runs for same input)
export function maxCountKey(counts) {
  let bestKey = '', bestCount = -1;
  for (const k in counts) {
    if (counts[k] > bestCount) { bestCount = counts[k]; bestKey = k; }
  }
  return bestKey;
}

export const MINHASH_K = 128;
export const LARGE_PRIME = 2147483647;
export const GRID_BITS = 16;
export const GRID_SIZE = 1 << GRID_BITS; // 65536
export const ZOOM_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const RAW_LEVEL = 14; // index into LEVEL_LABELS for the raw (individual node) level
export const LEVEL_LABELS = ['L1','L2','L3','L4','L5','L6','L7','L8','L9','L10','L11','L12','L13','L14','RAW'];

// ─── PRNG ────────────────────────────────────────────────────────────────────

export function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);
export const HASH_PARAMS_A = new Int32Array(MINHASH_K);
export const HASH_PARAMS_B = new Int32Array(MINHASH_K);
for (let i = 0; i < MINHASH_K; i++) {
  HASH_PARAMS_A[i] = Math.floor(rng() * (LARGE_PRIME - 1)) + 1;
  HASH_PARAMS_B[i] = Math.floor(rng() * (LARGE_PRIME - 1));
}

// ─── MinHash (GC-optimized, 32-bit safe) ─────────────────────────────────────

// #5a: Use unsigned right shift to ensure non-negative result without Math.abs edge case
export function hashToken(token) {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (Math.imul(31, h) + token.charCodeAt(i)) | 0;
  }
  return h >>> 0; // unsigned 32-bit, always non-negative
}

// Reusable signature buffer — avoids allocating per call.
// Callers must read/copy _sig before the next call to computeMinHashInto.
export const _sig = new Float64Array(MINHASH_K);

// #5b: True universal hash: (a * tv + b) mod p, computed without overflow.
// a < 2^31, tv < 2^32. Split tv into 16-bit halves so each partial product
// stays under 2^47, well within the 2^53 safe integer range.
// Mersenne fast-mod: p = 2^31 - 1 admits x mod p = (x & p) + (x >>> 31),
// followed by a conditional subtract if result >= p.
function mersMod(x) {
  x = (x & LARGE_PRIME) + ((x / 0x80000000) | 0); // x >>> 31 via float division for values > 2^32
  return x >= LARGE_PRIME ? x - LARGE_PRIME : x;
}
function hashSlot(a, tv, b) {
  const tvHi = (tv >>> 16), tvLo = tv & 0xFFFF;
  const hi = mersMod(a * tvHi);
  return mersMod(hi * 0x10000 + a * tvLo + b);
}

// #6: Compute MinHash into the reusable _sig buffer.
// If tokenCount is 0, fills with NaN (sentinel). NaN cannot appear as a valid
// hash output, so a single sig[0] !== sig[0] check detects empty with zero
// false positives.
export function computeMinHashInto(tokens, tokenCount) {
  if (tokenCount === 0) {
    for (let i = 0; i < MINHASH_K; i++) _sig[i] = NaN;
    return;
  }
  for (let i = 0; i < MINHASH_K; i++) _sig[i] = LARGE_PRIME; // max valid value, not Infinity
  for (let t = 0; t < tokenCount; t++) {
    const tv = hashToken(tokens[t]);
    for (let j = 0; j < MINHASH_K; j++) {
      const hv = hashSlot(HASH_PARAMS_A[j], tv, HASH_PARAMS_B[j]);
      if (hv < _sig[j]) _sig[j] = hv;
    }
  }
}

// Allocating version — returns a new Float64Array copy of the signature.
export function computeMinHash(tokens, tokenCount) {
  if (tokenCount === undefined) tokenCount = tokens.length;
  computeMinHashInto(tokens, tokenCount);
  const result = new Float64Array(MINHASH_K);
  result.set(_sig);
  return result;
}

export function jaccardEstimate(sigA, sigB) {
  // NaN sentinel: two empty sigs are identical; empty vs non-empty are disjoint
  const aEmpty = sigA[0] !== sigA[0], bEmpty = sigB[0] !== sigB[0];
  if (aEmpty || bEmpty) return (aEmpty && bEmpty) ? 1 : 0;
  let matches = 0;
  for (let i = 0; i < MINHASH_K; i++) if (sigA[i] === sigB[i]) matches++;
  return matches / MINHASH_K;
}

// ─── Gaussian projection ─────────────────────────────────────────────────────

// Always produces a 2×cols matrix (128D → 2D projection).
export function buildGaussianProjection(seed, cols) {
  const u = mulberry32(seed);
  const R = [new Float64Array(cols), new Float64Array(cols)];
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < cols; j += 2) {
      const u1 = Math.max(1e-10, u());
      const u2 = u();
      const mag = Math.sqrt(-2 * Math.log(u1));
      R[i][j]     = mag * Math.cos(2 * Math.PI * u2);
      if (j+1 < cols) R[i][j+1] = mag * Math.sin(2 * Math.PI * u2);
    }
  }
  return R;
}

// #6: Write projection directly into output buffer at offset.
// If signature is NaN (empty token sentinel), writes [0,0] (neutral).
export function projectInto(sig, ROT, buf, offset) {
  // NaN !== NaN — single-slot check, zero false positives
  if (sig[0] !== sig[0]) {
    buf[offset] = 0;
    buf[offset + 1] = 0;
    return;
  }
  let mean = 0;
  for (let i = 0; i < MINHASH_K; i++) mean += sig[i];
  mean /= MINHASH_K;
  let variance = 0;
  for (let i = 0; i < MINHASH_K; i++) { const d = sig[i] - mean; variance += d * d; }
  const std = Math.sqrt(variance / MINHASH_K) || 1;
  const R0 = ROT[0], R1 = ROT[1];
  let px = 0, py = 0;
  for (let i = 0; i < MINHASH_K; i++) {
    const v = (sig[i] - mean) / std;
    px += v * R0[i];
    py += v * R1[i];
  }
  buf[offset] = px;
  buf[offset + 1] = py;
}

// Convenience: allocating version that returns [px, py].
export function projectWith(sig, ROT) {
  const buf = [0, 0];
  projectInto(sig, ROT, buf, 0);
  return buf;
}

// ─── Grid & zoom ─────────────────────────────────────────────────────────────

export function cellIdAtLevel(gx, gy, level) {
  const shift = GRID_BITS - level;
  const cx = gx >> shift;
  const cy = gy >> shift;
  return (cx << level) | cy;
}

// ─── Color generation ────────────────────────────────────────────────────────

export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function generateGroupColors(values) {
  const colors = {};
  const golden = 137.508;
  for (let i = 0; i < values.length; i++) {
    const h = (i * golden) % 360;
    colors[values[i]] = hslToHex(h, 65, 62);
  }
  return colors;
}

// ─── Unified blend ───────────────────────────────────────────────────────────

// #2: Deterministic tie-break by node ID in rank quantization
export function normalizeAndQuantize(nodes) {
  const n = nodes.length;
  const orderX = nodes.map((nd, i) => ({i, v: nd.px, id: nd.id}))
    .sort((a,b) => a.v - b.v || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let r = 0; r < n; r++) {
    nodes[orderX[r].i].gx = Math.min(GRID_SIZE - 1, Math.floor(r / n * GRID_SIZE));
    nodes[orderX[r].i].px = (r / n) * 2 - 1;
  }
  const orderY = nodes.map((nd, i) => ({i, v: nd.py, id: nd.id}))
    .sort((a,b) => a.v - b.v || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let r = 0; r < n; r++) {
    nodes[orderY[r].i].gy = Math.min(GRID_SIZE - 1, Math.floor(r / n * GRID_SIZE));
    nodes[orderY[r].i].py = (r / n) * 2 - 1;
  }
}

// Gaussian quantization — precomputed Φ(z) lookup table.
// Maps z ∈ [-4, 4] → grid coord via table index. No erf at runtime.
const PHI_TABLE_SIZE = 8192;
const PHI_TABLE = new Float64Array(PHI_TABLE_SIZE + 1);
{
  // Abramowitz & Stegun 7.1.28 erf approximation — max error 5e-4
  const erfApprox = (x) => {
    const a = 0.278393, b = 0.230389, c = 0.000972, d = 0.078108;
    const ax = Math.abs(x);
    const t = 1 / (1 + a*ax + b*ax*ax + c*ax*ax*ax + d*ax*ax*ax*ax);
    const y = 1 - t*t*t*t;
    return x >= 0 ? y : -y;
  };
  for (let i = 0; i <= PHI_TABLE_SIZE; i++) {
    const z = (i / PHI_TABLE_SIZE) * 8 - 4; // [-4, 4]
    PHI_TABLE[i] = 0.5 * (1 + erfApprox(z * Math.SQRT1_2));
  }
}

function phiLookup(z) {
  // z clamped to [-4,4] → table index with linear interpolation
  const t = (z + 4) * (PHI_TABLE_SIZE / 8); // [0, PHI_TABLE_SIZE]
  const i = t | 0; // floor
  if (i >= PHI_TABLE_SIZE) return PHI_TABLE[PHI_TABLE_SIZE];
  if (i < 0) return PHI_TABLE[0];
  const f = t - i;
  return PHI_TABLE[i] + f * (PHI_TABLE[i + 1] - PHI_TABLE[i]);
}

// stats: mutable object for fixed Gaussian boundaries per the spec.
// First call computes μ,σ from data and stores them in stats.
// Subsequent calls reuse stored values — boundaries don't shift on
// weight/alpha changes. Reset stats to {} on new data load.
export function gaussianQuantize(nodes, stats) {
  const n = nodes.length;
  if (n === 0) return;

  let mx, my, sx, sy;
  if (stats && stats._initialized) {
    mx = stats.mx; my = stats.my; sx = stats.sx; sy = stats.sy;
  } else {
    let mxS = 0, myS = 0;
    for (let i = 0; i < n; i++) { mxS += nodes[i].px; myS += nodes[i].py; }
    mx = mxS / n; my = myS / n;
    let vxS = 0, vyS = 0;
    for (let i = 0; i < n; i++) {
      const dx = nodes[i].px - mx, dy = nodes[i].py - my;
      vxS += dx * dx; vyS += dy * dy;
    }
    sx = Math.sqrt(vxS / n) || 1; sy = Math.sqrt(vyS / n) || 1;
    if (stats) { stats.mx = mx; stats.my = my; stats.sx = sx; stats.sy = sy; stats._initialized = true; }
  }

  for (let i = 0; i < n; i++) {
    const ux = phiLookup((nodes[i].px - mx) / sx);
    const uy = phiLookup((nodes[i].py - my) / sy);
    nodes[i].gx = Math.min(GRID_SIZE - 1, Math.floor(ux * GRID_SIZE));
    nodes[i].gy = Math.min(GRID_SIZE - 1, Math.floor(uy * GRID_SIZE));
    nodes[i].px = ux * 2 - 1;
    nodes[i].py = uy * 2 - 1;
  }
}

// #3: Fixed α semantics — α is now the true convex topology weight.
// At α=0: pure property. At α=1: pure topology (for nodes with neighbors).
export function unifiedBlend(nodes, groupNames, propWeights, smoothAlpha, adjList, nodeIndexFull, passes, quantMode, quantStats) {
  const w = propWeights;
  let propTotal = 0;
  for (const g of groupNames) propTotal += (w[g] || 0);
  if (propTotal === 0) propTotal = 1;

  // Precompute per-node property anchors (#13: cache across passes)
  const propPx = new Float64Array(nodes.length);
  const propPy = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    let px = 0, py = 0;
    for (const g of groupNames) {
      const p = nd.projections[g];
      if (p) { px += p[0] * (w[g] || 0); py += p[1] * (w[g] || 0); }
    }
    propPx[i] = px / propTotal;
    propPy[i] = py / propTotal;
    nd.px = propPx[i];
    nd.py = propPy[i];
  }

  const doQuant = () => quantMode === 'gaussian' ? gaussianQuantize(nodes, quantStats) : normalizeAndQuantize(nodes);
  if (smoothAlpha === 0 || passes === 0) { doQuant(); return; }

  const alpha = Math.max(0, Math.min(1, smoothAlpha)); // clamp to [0,1]

  for (let pass = 0; pass < passes; pass++) {
    const newPx = new Float64Array(nodes.length);
    const newPy = new Float64Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const neighbors = adjList[nd.id];
      // #4: Guard missing neighbor IDs
      if (neighbors && neighbors.length > 0) {
        let nx = 0, ny = 0, validCount = 0;
        for (const nid of neighbors) {
          const nb = nodeIndexFull[nid];
          if (nb) { nx += nb.px; ny += nb.py; validCount++; }
        }
        if (validCount > 0) {
          nx /= validCount;
          ny /= validCount;
          // #3: True convex combination: (1-α)*property + α*neighbor
          newPx[i] = (1 - alpha) * propPx[i] + alpha * nx;
          newPy[i] = (1 - alpha) * propPy[i] + alpha * ny;
        } else {
          newPx[i] = propPx[i];
          newPy[i] = propPy[i];
        }
      } else {
        newPx[i] = propPx[i];
        newPy[i] = propPy[i];
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      nodes[i].px = newPx[i];
      nodes[i].py = newPy[i];
    }
  }

  doQuant();
}

// ─── Level building (two-phase for large datasets) ──────────────────────────

// Phase 1: bucket nodes into supernodes. O(n). No edge processing.
// Returns a level object with snEdges:[] that can render circles/heatmap/labels immediately.
export function buildLevelNodes(level, nodes, colorValFn, labelValFn, colorLookup) {
  const bucketMap = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const bid = cellIdAtLevel(n.gx, n.gy, level);
    let bucket = bucketMap.get(bid);
    if (!bucket) { bucket = []; bucketMap.set(bid, bucket); }
    bucket.push(n);
  }

  const supernodes = [];
  for (const [bid, members] of bucketMap) {
    const cx = bid >> level;
    const cy = bid & ((1 << level) - 1);

    const groupCounts = {};
    const colorCounts = {};
    const labelCounts = {};
    let sumDegree = 0;
    let sumPx = 0, sumPy = 0;
    let bestDegree = -1, bestNode = members[0];
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      sumPx += m.px; sumPy += m.py;
      groupCounts[m.group] = (groupCounts[m.group] || 0) + 1;
      if (colorValFn) {
        const cv = colorValFn(m);
        colorCounts[cv] = (colorCounts[cv] || 0) + 1;
      }
      if (labelValFn) {
        const lv = labelValFn(m);
        labelCounts[lv] = (labelCounts[lv] || 0) + 1;
      }
      sumDegree += m.degree;
      if (m.degree > bestDegree) { bestDegree = m.degree; bestNode = m; }
    }
    const ax = sumPx / members.length;
    const ay = sumPy / members.length;
    const domGroup = maxCountKey(groupCounts);
    const avgDegree = sumDegree / members.length;
    const totalDegree = sumDegree;
    const repName = bestNode.label || bestNode.id;

    const cachedColorVal = colorValFn ? maxCountKey(colorCounts) : domGroup;
    const cachedColor = colorLookup ? (colorLookup(cachedColorVal) || '#888888') : '#888888';
    const cachedLabel = labelValFn ? maxCountKey(labelCounts) : repName;

    supernodes.push({ bid, members, ax, ay, domGroup, avgDegree, totalDegree, repName,
             cachedColorVal, cachedColor, cachedLabel, x:0, y:0, cx, cy });
  }

  return { supernodes, snEdges: [], level, _edgesReady: false };
}

// Phase 2: aggregate edges into super-edges. O(|E|). Mutates levelObj.snEdges in place.
// For levels 1-13, packs two cell IDs into one number (26 bits each, 52 < 53 safe bits).
// Level 14 uses string keys (28 bits each = 56 > 53).
export function buildLevelEdges(levelObj, edges, nodeIndexFull, level) {
  const canPack = level <= 13;
  const PACK_MUL = 0x4000000; // 2^26
  const snEdgeMap = new Map();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const srcNode = nodeIndexFull[e.src];
    const dstNode = nodeIndexFull[e.dst];
    if (!srcNode || !dstNode) continue;
    const sbid = cellIdAtLevel(srcNode.gx, srcNode.gy, level);
    const dbid = cellIdAtLevel(dstNode.gx, dstNode.gy, level);
    if (sbid !== dbid) {
      const lo = sbid < dbid ? sbid : dbid;
      const hi = sbid < dbid ? dbid : sbid;
      const key = canPack ? lo * PACK_MUL + hi : lo + ',' + hi;
      snEdgeMap.set(key, (snEdgeMap.get(key) || 0) + 1);
    }
  }

  const snEdges = new Array(snEdgeMap.size);
  let idx = 0;
  if (canPack) {
    for (const [key, weight] of snEdgeMap) {
      snEdges[idx++] = { a: key / PACK_MUL | 0, b: key % PACK_MUL, weight };
    }
  } else {
    for (const [key, weight] of snEdgeMap) {
      const comma = key.indexOf(',');
      snEdges[idx++] = { a: parseInt(key.slice(0, comma), 10), b: parseInt(key.slice(comma + 1), 10), weight };
    }
  }
  levelObj.snEdges = snEdges;
  levelObj._edgesReady = true;
}

// Combined wrapper for backward compatibility (tests, standalone BitZoomCanvas).
export function buildLevel(level, nodes, edges, nodeIndexFull, colorValFn, labelValFn, colorLookup) {
  const lvl = buildLevelNodes(level, nodes, colorValFn, labelValFn, colorLookup);
  buildLevelEdges(lvl, edges, nodeIndexFull, level);
  return lvl;
}

// ─── Node property helpers ───────────────────────────────────────────────────

// #16: Use hasOwnProperty for falsy-but-valid values (0, false, empty string)
export function getNodePropValue(n, prop, adjList) {
  if (prop === 'label') return n.label || n.id;
  if (prop === 'group') return n.group || 'unknown';
  if (prop === 'structure') return `deg:${n.degree}`;
  if (prop === 'neighbors') return `${(adjList[n.id] || []).length} nbrs`;
  if (prop === 'edgetype' && n.edgeTypes) {
    const types = Array.isArray(n.edgeTypes) ? n.edgeTypes : [...n.edgeTypes];
    return types.length > 0 ? types[0] : n.id;
  }
  if (n.extraProps && Object.prototype.hasOwnProperty.call(n.extraProps, prop)) {
    const v = n.extraProps[prop];
    return v !== null && v !== undefined ? String(v) : n.label || n.id;
  }
  return n.label || n.id;
}

export function getSupernodeDominantValue(sn, prop, adjList) {
  if (prop === 'label') return sn.repName;
  const counts = {};
  for (const m of sn.members) {
    const val = getNodePropValue(m, prop, adjList);
    counts[val] = (counts[val] || 0) + 1;
  }
  return maxCountKey(counts);
}
