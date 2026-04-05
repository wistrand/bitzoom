// bitzoom-utils.js — Utility functions (auto-tune, etc).
// Depends on bitzoom-algo.js for unifiedBlend and quantization.

import { unifiedBlend, normalizeAndQuantize, gaussianQuantize } from './bitzoom-algo.js';

// ─── Auto-tune optimizer ─────────────────────────────────────────────────────
// Async heuristic search for weights/alpha/quant that maximize layout quality.
// Yields to the browser between phases so progress can be painted.
//
// Objective: spread × clumpiness at an adaptive grid level.
// - Spread (cell occupancy): penalizes collapse.
// - Clumpiness (CV of per-cell counts): penalizes uniform scatter, rewards clusters.

/**
 * Layout quality score: spread × clumpiness × group-purity.
 *
 * - spread: fraction of grid cells that are occupied (penalizes total collapse)
 * - clumpiness: CV of per-cell counts (penalizes uniform scatter, rewards clusters)
 * - purity: average fraction of each cell belonging to its majority category
 *   for the given `nodeCategory` array (penalizes mixed clusters, rewards
 *   semantic separation). Skipped (treated as 1) when nodeCategory is null.
 *
 * @param {Array} nodes        — must have .gx/.gy populated
 * @param {number} level       — grid subdivision level (3..7)
 * @param {Array<string>|null} nodeCategory — per-node category for purity, or null to skip
 */
function layoutScore(nodes, level, nodeCategory) {
  const shift = 16 - level;
  const gridK = 1 << level;
  const totalCells = gridK * gridK;
  const cellCounts = new Map();
  const cellCats = nodeCategory ? new Map() : null; // cell → Map<category, count>
  for (let i = 0; i < nodes.length; i++) {
    const key = (nodes[i].gx >> shift) * gridK + (nodes[i].gy >> shift);
    cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
    if (cellCats) {
      const cat = nodeCategory[i];
      let inner = cellCats.get(key);
      if (!inner) { inner = new Map(); cellCats.set(key, inner); }
      inner.set(cat, (inner.get(cat) || 0) + 1);
    }
  }
  const occupied = cellCounts.size;
  if (occupied <= 1) return 0;
  const spread = occupied / totalCells;
  let sum = 0, sumSq = 0;
  for (const c of cellCounts.values()) { sum += c; sumSq += c * c; }
  const mean = sum / occupied;
  const variance = sumSq / occupied - mean * mean;
  const cv = Math.sqrt(Math.max(0, variance)) / Math.max(1, mean);

  // Group purity: weighted average of majority-category fraction per cell.
  // Each cell contributes its majority count; total divided by total nodes.
  // Range: ~1/K (random) to 1.0 (every cell is pure). Raised to 0.5 to soften
  // the penalty — a layout with imperfect purity but great spread is still useful.
  let purity = 1;
  if (cellCats) {
    let majoritySum = 0, totalSum = 0;
    for (const [key, inner] of cellCats) {
      let maxCat = 0;
      for (const c of inner.values()) if (c > maxCat) maxCat = c;
      majoritySum += maxCat;
      totalSum += cellCounts.get(key);
    }
    purity = totalSum > 0 ? Math.sqrt(majoritySum / totalSum) : 1;
  }

  return spread * cv * purity;
}

function quantizeOnly(nodes, mode) {
  if (mode === 'gaussian') gaussianQuantize(nodes, {});
  else normalizeAndQuantize(nodes);
}

// Cooperative yield that works in both browser and non-browser environments.
// Browsers get requestAnimationFrame (aligns with paint, ~60Hz); Deno/Node fall
// back to setTimeout(0) so autoTuneWeights can run from CLI tools and tests
// without any caller-side polyfill.
const yieldFrame = typeof requestAnimationFrame !== 'undefined'
  ? () => new Promise(resolve => requestAnimationFrame(resolve))
  : () => new Promise(resolve => setTimeout(resolve, 0));

export async function autoTuneWeights(nodes, groupNames, adjList, nodeIndexFull, opts = {}) {
  const t0 = performance.now();
  const doWeights = opts.weights !== false;
  const doAlpha = opts.alpha !== false;
  const doQuant = opts.quant !== false;
  const onProgress = opts.onProgress;
  const signal = opts.signal;
  const timeoutMs = opts.timeout ?? 20000;

  const WEIGHT_VALS = [0, 3, 8, 10];
  const ALPHA_VALS = [0, 0.25, 0.5, 0.75, 1.0];
  const QUANT_VALS = doQuant ? ['rank', 'gaussian'] : ['gaussian'];
  // Skip topology blending search for nodes-only graphs — no edges means alpha
  // has no effect and any non-zero value just wastes blend evaluations.
  const hasEdges = adjList && Object.values(adjList).some(a => a && a.length > 0);
  const alphaVals = (doAlpha && hasEdges) ? ALPHA_VALS : [0];

  // Adaptive grid level: scale with dataset size so the metric has meaningful resolution.
  // 34 nodes → L3 (8x8=64 cells), 5K nodes → L5 (32x32), 367K nodes → L7 (128x128).
  const scoreLevel = Math.max(3, Math.min(7, Math.round(Math.log2(nodes.length) - 2)));

  // Determine tunable groups: 'group' + extra properties + edgetype if rich.
  // Exclude label (too high cardinality), structure (degree buckets), neighbors (auto-generated).
  // Also exclude any group with only one distinct value across all nodes —
  // it provides no spreading signal, so any weight on it is a no-op (pulls all
  // nodes toward a constant offset) that would just show up as noise in the UI.
  const ALWAYS_EXCLUDE = new Set(['label', 'structure', 'neighbors']);
  const tunableGroups = groupNames.filter(g => {
    if (ALWAYS_EXCLUDE.has(g)) return false;
    if (g === 'edgetype') {
      // Include edgetype only when it has >2 distinct values
      const types = new Set();
      for (const n of nodes) {
        if (n.edgeTypes) for (const t of n.edgeTypes) types.add(t);
        if (types.size > 2) return true;
      }
      return false;
    }
    // For all other groups: skip if <2 distinct values (no signal).
    const vals = new Set();
    for (const n of nodes) {
      const v = g === 'group' ? n.group : (n.extraProps && n.extraProps[g]);
      vals.add(v);
      if (vals.size >= 2) return true;
    }
    return false;
  });

  // Precompute per-node category arrays for each tunable group, used by the
  // purity term in layoutScore. Only categoricals (2-50 distinct values) get
  // a cache entry — high-cardinality groups (numeric columns, identifiers)
  // are excluded from purity since exact-equality makes no sense there.
  const PURITY_MAX_CARDINALITY = 50;
  const categoryCache = new Map(); // groupName → string[]
  for (const g of tunableGroups) {
    if (g === 'edgetype') continue; // multi-valued per node, skip purity for edgetype
    const arr = new Array(nodes.length);
    const distinct = new Set();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const v = g === 'group' ? n.group : (n.extraProps && n.extraProps[g]);
      arr[i] = v == null ? '' : String(v);
      distinct.add(arr[i]);
      if (distinct.size > PURITY_MAX_CARDINALITY) break;
    }
    if (distinct.size >= 2 && distinct.size <= PURITY_MAX_CARDINALITY) {
      categoryCache.set(g, arr);
    }
  }

  // Detect edge-only datasets: if all tunable groups have <=1 distinct value,
  // skip weight search (no property signal to optimize).
  let hasPropertySignal = false;
  if (doWeights) {
    for (const g of tunableGroups) {
      const vals = new Set();
      for (const n of nodes) {
        const v = g === 'group' ? n.group
          : (n.extraProps && n.extraProps[g]) || undefined;
        vals.add(v);
        if (vals.size > 1) { hasPropertySignal = true; break; }
      }
      if (hasPropertySignal) break;
    }
  }
  const effectiveDoWeights = doWeights && hasPropertySignal;

  let bestScore = -1, bestWeights = {}, bestAlpha = 0, bestQuant = 'gaussian';
  let blends = 0, quants = 0, step = 0;

  const G = tunableGroups.length;
  const presetCount = (effectiveDoWeights ? G + 2 : 1) * alphaVals.length; // +2 for balanced + interaction
  const descentPerRound = (effectiveDoWeights ? G * WEIGHT_VALS.length : 0) + alphaVals.length;
  // Refinement phase: 4 deltas per non-zero group + 4 alpha deltas (upper bound)
  const refineSteps = (effectiveDoWeights ? G * 4 : 0) + (doAlpha && hasEdges ? 4 : 0);
  const totalEstimate = presetCount + descentPerRound * 3 + refineSteps;

  let lastYield = performance.now();
  let aborted = false;
  const isAborted = () => signal?.aborted || (timeoutMs > 0 && performance.now() - t0 > timeoutMs);
  const maybeYield = async (phase) => {
    if (isAborted()) { aborted = true; return; }
    const now = performance.now();
    if (now - lastYield > 50) {
      if (onProgress) onProgress({ phase, step, total: totalEstimate, score: bestScore });
      await yieldFrame();
      lastYield = performance.now();
      if (isAborted()) aborted = true;
    }
  };
  const forceYield = async (phase) => {
    if (isAborted()) { aborted = true; return; }
    if (onProgress) onProgress({ phase, step, total: totalEstimate, score: bestScore });
    await yieldFrame();
    lastYield = performance.now();
    if (isAborted()) aborted = true;
  };

  const savedPx = new Float64Array(nodes.length);
  const savedPy = new Float64Array(nodes.length);

  const blendFn = opts.blendFn || unifiedBlend;
  // Tuning uses fewer smoothing passes than the final blend. Topology smoothing
  // converges exponentially — 2 passes capture ~60-70% of the structure of 5
  // passes at 40% of the cost. Score RANKING (which the tuner cares about) is
  // preserved even with partial convergence; the final blend at the end uses
  // full passes for the actual layout the user sees.
  const TUNE_PASSES = 2;
  // Pick the category array for purity scoring based on the current trial's
  // dominant weight. Falls back to the 'group' category cache, otherwise the
  // first available cached group, otherwise null (purity skipped).
  const pickCategoryArray = (weights) => {
    if (categoryCache.size === 0) return null;
    let dominant = null, maxW = 0;
    for (const g of tunableGroups) {
      const w = weights[g] || 0;
      if (w > maxW && categoryCache.has(g)) { maxW = w; dominant = g; }
    }
    if (dominant) return categoryCache.get(dominant);
    // No weighted categorical — use any cached one (prefer 'group')
    return categoryCache.get('group') || categoryCache.values().next().value || null;
  };
  // Memoize (weights, alpha) → result so refinement/descent revisits don't re-blend.
  const scoreCache = new Map();
  const cacheKey = (weights, alpha) => {
    let k = alpha.toFixed(3) + '|';
    for (const g of tunableGroups) k += (weights[g] || 0) + ',';
    return k;
  };
  const blendAndScore = (weights, alpha) => {
    const key = cacheKey(weights, alpha);
    const cached = scoreCache.get(key);
    if (cached) { step++; return cached; }
    blendFn(nodes, groupNames, weights, alpha, adjList, nodeIndexFull, TUNE_PASSES, 'gaussian', {});
    blends++;
    for (let i = 0; i < nodes.length; i++) { savedPx[i] = nodes[i].px; savedPy[i] = nodes[i].py; }
    const nodeCategory = pickCategoryArray(weights);
    let localBest = -1, localQuant = 'gaussian';
    for (const q of QUANT_VALS) {
      for (let i = 0; i < nodes.length; i++) { nodes[i].px = savedPx[i]; nodes[i].py = savedPy[i]; }
      quantizeOnly(nodes, q);
      quants++;
      const score = layoutScore(nodes, scoreLevel, nodeCategory);
      if (score > localBest) { localBest = score; localQuant = q; }
    }
    step++;
    const out = { score: localBest, quant: localQuant };
    scoreCache.set(key, out);
    return out;
  };

  // Phase 1: Presets
  const presets = [];

  // Balanced (all tunable groups at weight 3)
  const balanced = {};
  for (const g of groupNames) balanced[g] = tunableGroups.includes(g) ? 3 : 0;
  presets.push(balanced);

  if (effectiveDoWeights) {
    // Each tunable group solo at weight 8
    for (const g of tunableGroups) {
      const solo = {};
      for (const g2 of groupNames) solo[g2] = (g2 === g) ? 8 : 0;
      presets.push(solo);
    }
  }

  await forceYield('presets');
  const soloWinners = []; // track top solo scorers for interaction presets
  for (let pi = 0; pi < presets.length; pi++) {
    if (aborted) break;
    const weights = presets[pi];
    for (const alpha of alphaVals) {
      const { score, quant } = blendAndScore(weights, alpha);
      if (score > bestScore) {
        bestScore = score;
        bestWeights = { ...weights };
        bestAlpha = alpha;
        bestQuant = quant;
      }
      // Track solo preset scores (pi > 0 are solo presets)
      if (pi > 0 && alpha === 0) {
        soloWinners.push({ group: tunableGroups[pi - 1], score });
      }
      await maybeYield('presets');
      if (aborted) break;
    }
  }

  // Interaction presets: combine top 2 solo winners
  if (effectiveDoWeights && soloWinners.length >= 2 && !aborted) {
    soloWinners.sort((a, b) => b.score - a.score);
    const g1 = soloWinners[0].group, g2 = soloWinners[1].group;
    const combo = {};
    for (const g of groupNames) combo[g] = (g === g1 || g === g2) ? 5 : 0;
    for (const alpha of alphaVals) {
      if (aborted) break;
      const { score, quant } = blendAndScore(combo, alpha);
      if (score > bestScore) {
        bestScore = score;
        bestWeights = { ...combo };
        bestAlpha = alpha;
        bestQuant = quant;
      }
      await maybeYield('presets');
    }
  }

  // Phase 2: Coordinate descent (3 rounds)
  for (let round = 0; round < 3 && !aborted; round++) {
    let improved = false;
    await forceYield('descent');
    if (aborted) break;

    if (effectiveDoWeights) {
      for (const g of tunableGroups) {
        if (aborted) break;
        let bestV = bestWeights[g];
        for (const v of WEIGHT_VALS) {
          bestWeights[g] = v;
          const { score, quant } = blendAndScore(bestWeights, bestAlpha);
          if (score > bestScore) {
            bestScore = score;
            bestV = v;
            bestQuant = quant;
            improved = true;
          }
          await maybeYield('descent');
          if (aborted) break;
        }
        bestWeights[g] = bestV;
      }
    }

    if (doAlpha && hasEdges && !aborted) {
      for (const a of alphaVals) {
        const { score, quant } = blendAndScore(bestWeights, a);
        if (score > bestScore) {
          bestScore = score;
          bestAlpha = a;
          bestQuant = quant;
          improved = true;
        }
        await maybeYield('descent');
        if (aborted) break;
      }
    }

    if (!improved) break;
  }

  // Phase 3: Local refinement around the best discrete point.
  // Descent's weight grid is [0,3,8,10]; the true optimum often sits between.
  // Probe ±1 and ±2 around each non-zero weight, and ±0.05 / ±0.15 around alpha.
  // One pass, each parameter independently (greedy per-parameter).
  if (!aborted) {
    await forceYield('refine');
    if (effectiveDoWeights && !aborted) {
      for (const g of tunableGroups) {
        if (aborted) break;
        const original = bestWeights[g];
        if (original === 0) continue; // leave zeros alone — the descent decided they don't contribute
        let groupBestV = original;
        for (const delta of [-2, -1, 1, 2]) {
          const v = original + delta;
          if (v < 0 || v > 15) continue;
          bestWeights[g] = v;
          const { score, quant } = blendAndScore(bestWeights, bestAlpha);
          if (score > bestScore) {
            bestScore = score;
            bestQuant = quant;
            groupBestV = v;
          }
          await maybeYield('refine');
          if (aborted) break;
        }
        bestWeights[g] = groupBestV;
      }
    }
    if (doAlpha && hasEdges && !aborted) {
      const original = bestAlpha;
      for (const delta of [-0.15, -0.05, 0.05, 0.15]) {
        if (aborted) break;
        const a = Math.max(0, Math.min(1, original + delta));
        if (a === original) continue;
        const { score, quant } = blendAndScore(bestWeights, a);
        if (score > bestScore) {
          bestScore = score;
          bestAlpha = a;
          bestQuant = quant;
        }
        await maybeYield('refine');
      }
    }
  }

  // Interpretability constraint: if descent zeroed out every tunable group
  // (e.g. karate, where topology alone scores best), auto-select ONE group to
  // carry a small positive weight so colorBy has something meaningful to use.
  // Pick the highest-scoring solo winner — that's the group with the most
  // information content per the metric. Use a small weight (3) that minimally
  // perturbs the topology-driven layout but gives the legend/colors purpose.
  if (effectiveDoWeights && !aborted) {
    const anyNonZero = tunableGroups.some(g => (bestWeights[g] || 0) > 0);
    if (!anyNonZero && soloWinners.length > 0) {
      soloWinners.sort((a, b) => b.score - a.score);
      const pickGroup = soloWinners[0].group;
      bestWeights[pickGroup] = 3;
      // Don't re-score — this is an aesthetic override, not a performance tweak.
    }
  }

  // Final blend with best params
  unifiedBlend(nodes, groupNames, bestWeights, bestAlpha, adjList, nodeIndexFull, 5, bestQuant, {});
  if (onProgress) onProgress({ phase: 'done', step: totalEstimate, total: totalEstimate, score: bestScore });

  // Pick label properties.
  // Rule: the node's natural `label` field is almost always what users want —
  // unique labels ARE the right labels for person/technique/product graphs.
  // Additionally add the dominant tuned group as a secondary component IF it's
  // categorical-ish (low-to-moderate distinct value count). Skip the dominant
  // group if it's high-cardinality (continuous / identifier-like) since its
  // values don't help identify individual nodes.
  const labelProps = [];

  // 1. Always include `label` when it exists and distinguishes at least 2 nodes.
  if (groupNames.includes('label')) {
    let twoDistinct = false;
    const first = nodes[0]?.label || nodes[0]?.id;
    for (let i = 1; i < nodes.length; i++) {
      if ((nodes[i].label || nodes[i].id) !== first) { twoDistinct = true; break; }
    }
    if (twoDistinct) labelProps.push('label');
  }

  // 2. Add the dominant tuned group as a secondary label component, but only
  //    when it has few distinct values (categorical, not a continuous property).
  let maxTunedW = 0, dominantGroup = null;
  for (const g of tunableGroups) {
    if ((bestWeights[g] || 0) > maxTunedW) { maxTunedW = bestWeights[g] || 0; dominantGroup = g; }
  }
  if (dominantGroup && dominantGroup !== 'label' && !labelProps.includes(dominantGroup)) {
    const distinct = new Set();
    const MAX_CATEGORICAL = 50;
    for (const n of nodes) {
      const v = dominantGroup === 'group' ? n.group
        : (n.extraProps && n.extraProps[dominantGroup]) || undefined;
      if (v != null) distinct.add(v);
      if (distinct.size > MAX_CATEGORICAL) break;
    }
    if (distinct.size > 1 && distinct.size <= MAX_CATEGORICAL) {
      labelProps.push(dominantGroup);
    }
  }

  return {
    weights: bestWeights,
    alpha: bestAlpha,
    quantMode: bestQuant,
    labelProps,
    score: bestScore,
    blends, quants,
    timeMs: Math.round(performance.now() - t0),
  };
}
