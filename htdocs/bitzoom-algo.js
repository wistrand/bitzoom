// bitzoom-algo.js — Pure algorithm functions and constants.
// No DOM, no canvas, no state. Shared by main thread and conceptually by worker.

// Find key with highest count in an object {key: count} — O(k) instead of sort O(k log k)
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
export const RAW_LEVEL = 15;
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

// ─── MinHash (GC-optimized) ──────────────────────────────────────────────────

export function hashToken(token) {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (Math.imul(31, h) + token.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Reusable signature buffer — avoids allocating per call.
// Callers must read/copy _sig before the next call to computeMinHashInto.
export const _sig = new Float64Array(MINHASH_K);

// Compute MinHash into the reusable _sig buffer.
// tokens: array-like, tokenCount: number of tokens to process.
export function computeMinHashInto(tokens, tokenCount) {
  for (let i = 0; i < MINHASH_K; i++) _sig[i] = Infinity;
  for (let t = 0; t < tokenCount; t++) {
    const tv = hashToken(tokens[t]);
    for (let j = 0; j < MINHASH_K; j++) {
      const hv = (HASH_PARAMS_A[j] * tv + HASH_PARAMS_B[j]) % LARGE_PRIME;
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
  let matches = 0;
  for (let i = 0; i < MINHASH_K; i++) if (sigA[i] === sigB[i]) matches++;
  return matches / MINHASH_K;
}

// ─── Gaussian projection ─────────────────────────────────────────────────────

export function buildGaussianRotation(seed, rows, cols) {
  const u = mulberry32(seed);
  const R = [new Float64Array(cols), new Float64Array(cols)];
  for (let i = 0; i < rows; i++) {
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

// Write projection directly into output buffer at offset — no allocation.
export function projectInto(sig, ROT, buf, offset) {
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

export function normalizeAndQuantize(nodes) {
  const n = nodes.length;
  const orderX = nodes.map((nd, i) => ({i, v: nd.px})).sort((a,b) => a.v - b.v);
  for (let r = 0; r < n; r++) {
    nodes[orderX[r].i].gx = Math.min(GRID_SIZE - 1, Math.floor(r / n * GRID_SIZE));
    nodes[orderX[r].i].px = (r / n) * 2 - 1;
  }
  const orderY = nodes.map((nd, i) => ({i, v: nd.py})).sort((a,b) => a.v - b.v);
  for (let r = 0; r < n; r++) {
    nodes[orderY[r].i].gy = Math.min(GRID_SIZE - 1, Math.floor(r / n * GRID_SIZE));
    nodes[orderY[r].i].py = (r / n) * 2 - 1;
  }
}

export function unifiedBlend(nodes, groupNames, propWeights, smoothAlpha, adjList, nodeIndexFull, passes) {
  const w = propWeights;
  let propTotal = 0;
  for (const g of groupNames) propTotal += (w[g] || 0);
  if (propTotal === 0) propTotal = 1;

  for (const n of nodes) {
    let px = 0, py = 0;
    for (const g of groupNames) {
      const p = n.projections[g];
      if (p) { px += p[0] * (w[g] || 0); py += p[1] * (w[g] || 0); }
    }
    n.px = px / propTotal;
    n.py = py / propTotal;
  }

  if (smoothAlpha === 0 || passes === 0) { normalizeAndQuantize(nodes); return; }

  const w_topo = smoothAlpha * propTotal;
  const totalW = propTotal + w_topo;

  for (let pass = 0; pass < passes; pass++) {
    const newPx = new Float64Array(nodes.length);
    const newPy = new Float64Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      let px = 0, py = 0;
      for (const g of groupNames) {
        const p = nd.projections[g];
        if (p) { px += p[0] * (w[g] || 0); py += p[1] * (w[g] || 0); }
      }
      const neighbors = adjList[nd.id];
      if (neighbors && neighbors.length > 0) {
        let nx = 0, ny = 0;
        for (const nid of neighbors) {
          nx += nodeIndexFull[nid].px;
          ny += nodeIndexFull[nid].py;
        }
        nx /= neighbors.length;
        ny /= neighbors.length;
        px += nx * w_topo;
        py += ny * w_topo;
        newPx[i] = px / totalW;
        newPy[i] = py / totalW;
      } else {
        newPx[i] = px / propTotal;
        newPy[i] = py / propTotal;
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      nodes[i].px = newPx[i];
      nodes[i].py = newPy[i];
    }
  }

  normalizeAndQuantize(nodes);
}

// ─── Level building ──────────────────────────────────────────────────────────

// colorValFn(node) → string, labelValFn(node) → string
// These are called once per member at build time, cached on the supernode.
export function buildLevel(level, nodes, edges, nodeIndexFull, colorValFn, labelValFn, colorLookup) {
  const bucketMap = {};
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const bid = cellIdAtLevel(n.gx, n.gy, level);
    if (!bucketMap[bid]) bucketMap[bid] = [];
    bucketMap[bid].push(n);
  }

  const supernodes = Object.entries(bucketMap).map(([bidStr, members]) => {
    const bid = parseInt(bidStr);
    const cx = bid >> level;
    const cy = bid & ((1 << level) - 1);
    const k = 1 << level;
    const ax = (cx + 0.5) / k * 2 - 1;
    const ay = (cy + 0.5) / k * 2 - 1;

    const groupCounts = {};
    const colorCounts = {};
    const labelCounts = {};
    let sumDegree = 0;
    let bestDegree = -1, bestNode = members[0];
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
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
    const domGroup = maxCountKey(groupCounts);
    const avgDegree = sumDegree / members.length;
    const totalDegree = sumDegree;
    const repName = bestNode.label || bestNode.id;

    // Cached color and label — computed once at build, not per frame
    const cachedColorVal = colorValFn ? maxCountKey(colorCounts) : domGroup;
    const cachedColor = colorLookup ? (colorLookup(cachedColorVal) || '#888888') : '#888888';
    const cachedLabel = labelValFn ? maxCountKey(labelCounts) : repName;

    return { bid, members, ax, ay, domGroup, avgDegree, totalDegree, repName,
             cachedColor, cachedLabel, x:0, y:0, cx, cy };
  });

  // Build supernode edges using numeric key (avoid string allocation per edge)
  // Pack two bid values into a single number: bid values fit in 30 bits at level<=14
  const snEdgeMap = new Map();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const srcNode = nodeIndexFull[e.src];
    const dstNode = nodeIndexFull[e.dst];
    if (!srcNode || !dstNode) continue;
    const sbid = cellIdAtLevel(srcNode.gx, srcNode.gy, level);
    const dbid = cellIdAtLevel(dstNode.gx, dstNode.gy, level);
    if (sbid !== dbid) {
      // Cantor-like pairing: pack ordered pair into single number
      const lo = sbid < dbid ? sbid : dbid;
      const hi = sbid < dbid ? dbid : sbid;
      const key = lo * 0x100000 + hi; // safe for bid < 1M
      snEdgeMap.set(key, (snEdgeMap.get(key) || 0) + 1);
    }
  }

  const snEdges = new Array(snEdgeMap.size);
  let idx = 0;
  for (const [key, weight] of snEdgeMap) {
    const lo = (key / 0x100000) | 0;
    const hi = key % 0x100000;
    snEdges[idx++] = {a: lo, b: hi, weight};
  }

  return { supernodes, snEdges, level };
}

// ─── Node property helpers ───────────────────────────────────────────────────

export function getNodePropValue(n, prop, adjList) {
  if (prop === 'label') return n.label || n.id;
  if (prop === 'group') return n.group || 'unknown';
  if (prop === 'structure') return `deg:${n.degree}`;
  if (prop === 'neighbors') return `${(adjList[n.id] || []).length} nbrs`;
  if (prop === 'edgetype' && n.edgeTypes) {
    const types = Array.isArray(n.edgeTypes) ? n.edgeTypes : [...n.edgeTypes];
    return types.length > 0 ? types[0] : n.id;
  }
  if (n.extraProps && n.extraProps[prop]) return n.extraProps[prop];
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
