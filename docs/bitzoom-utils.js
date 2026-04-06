// bitzoom-utils.js — Utility functions (auto-tune, etc).
// Depends on bitzoom-algo.js for unifiedBlend and quantization.

import { unifiedBlend, normalizeAndQuantize, gaussianQuantize, STRENGTH_FLOOR_RATIO, STRENGTH_FLOOR_MIN } from './bitzoom-algo.js';

// ─── Auto-tune optimizer ─────────────────────────────────────────────────────
// Async heuristic search for strengths/alpha/quant that maximize layout quality.
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
// back to setTimeout(0) so autoTuneStrengths can run from CLI tools and tests
// without any caller-side polyfill.
const yieldFrame = typeof requestAnimationFrame !== 'undefined'
  ? () => new Promise(resolve => requestAnimationFrame(resolve))
  : () => new Promise(resolve => setTimeout(resolve, 0));

export async function autoTuneStrengths(nodes, groupNames, adjList, nodeIndexFull, opts = {}) {
  const t0 = performance.now();
  const doStrengths = (opts.strengths ?? opts.weights) !== false;
  const doAlpha = opts.alpha !== false;
  const doQuant = opts.quant !== false;
  const onProgress = opts.onProgress;
  const signal = opts.signal;
  const timeoutMs = opts.timeout ?? 20000;

  const STRENGTH_VALS = [0, 3, 8, 10];
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
  // it provides no spreading signal, so any strength on it is a no-op (pulls all
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
  // skip strength search (no property signal to optimize).
  let hasPropertySignal = false;
  if (doStrengths) {
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
  const effectiveDoStrengths = doStrengths && hasPropertySignal;

  let bestScore = -1, bestStrengths = {}, bestAlpha = 0, bestQuant = 'gaussian';
  let blends = 0, quants = 0, step = 0;

  const G = tunableGroups.length;
  // Dual-pass: run preset+descent+refine at α=0 and α=0.5, then sweep α
  const nPasses = (effectiveDoStrengths && hasEdges && doAlpha) ? 2 : 1;
  const presetCount = effectiveDoStrengths ? G + 2 : 1;
  const descentPerRound = effectiveDoStrengths ? G * STRENGTH_VALS.length : 0;
  const refineSteps = effectiveDoStrengths ? G * 4 : 0;
  const perPass = presetCount + descentPerRound * 3 + refineSteps;
  const alphaSteps = (doAlpha && hasEdges) ? alphaVals.length + 4 : 0;
  const totalEstimate = perPass * nPasses + alphaSteps;

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
  // dominant strength. Falls back to the 'group' category cache, otherwise the
  // first available cached group, otherwise null (purity skipped).
  const pickCategoryArray = (strengths) => {
    if (categoryCache.size === 0) return null;
    let dominant = null, maxW = 0;
    for (const g of tunableGroups) {
      const s = strengths[g] || 0;
      if (s > maxW && categoryCache.has(g)) { maxW = s; dominant = g; }
    }
    if (dominant) return categoryCache.get(dominant);
    // No dominant categorical — use any cached one (prefer 'group')
    return categoryCache.get('group') || categoryCache.values().next().value || null;
  };
  // Memoize (strengths, alpha) → result so refinement/descent revisits don't re-blend.
  const scoreCache = new Map();
  const cacheKey = (strengths, alpha) => {
    let k = alpha.toFixed(3) + '|';
    for (const g of tunableGroups) k += (strengths[g] || 0) + ',';
    return k;
  };
  const blendAndScore = (strengths, alpha) => {
    const key = cacheKey(strengths, alpha);
    const cached = scoreCache.get(key);
    if (cached) { step++; return cached; }
    blendFn(nodes, groupNames, strengths, alpha, adjList, nodeIndexFull, TUNE_PASSES, 'gaussian', {});
    blends++;
    for (let i = 0; i < nodes.length; i++) { savedPx[i] = nodes[i].px; savedPy[i] = nodes[i].py; }
    const nodeCategory = pickCategoryArray(strengths);
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

  // ── Dual-pass strength search ──────────────────────────────────────────────
  // Searching strengths at α=0 prevents topology from masking property signal.
  // But some strength configs only show value WITH topology (e.g., MITRE's
  // "platforms" group helps when connected techniques share platforms).
  //
  // Solution: run the full preset → descent → refine pipeline at two α levels
  // (0 and 0.5), then pick whichever produces the higher score. This explores
  // both the property-only and property+topology landscapes.
  //
  // For property datasets, cap α at 0.75 (never 1.0 — full topology collapses
  // property structure via CV inflation). Edge-only datasets use the full range.
  const maxAlpha = effectiveDoStrengths ? 0.75 : 1.0;
  const searchAlphas = (effectiveDoStrengths && hasEdges && doAlpha) ? [0, 0.5] : [0];

  const presets = [];
  // Balanced (all tunable groups at strength 3)
  const balanced = {};
  for (const g of groupNames) balanced[g] = tunableGroups.includes(g) ? 3 : 0;
  presets.push(balanced);

  if (effectiveDoStrengths) {
    // Each tunable group solo at strength 8
    for (const g of tunableGroups) {
      const solo = {};
      for (const g2 of groupNames) solo[g2] = (g2 === g) ? 8 : 0;
      presets.push(solo);
    }
  }

  const soloWinners = []; // track top solo scorers for interaction presets

  for (const searchAlpha of searchAlphas) {
    if (aborted) break;
    let passScore = -1, passStrengths = {}, passQuant = 'gaussian';

    // ── Preset scan at this α ────────────────────────────────────────────
    await forceYield('presets');
    for (let pi = 0; pi < presets.length; pi++) {
      if (aborted) break;
      const preset = presets[pi];
      const { score, quant } = blendAndScore(preset, searchAlpha);
      if (score > passScore) {
        passScore = score;
        passStrengths = { ...preset };
        passQuant = quant;
      }
      if (pi > 0 && searchAlpha === 0) {
        soloWinners.push({ group: tunableGroups[pi - 1], score });
      }
      await maybeYield('presets');
    }

    // Interaction presets: combine top 2 solo winners
    if (effectiveDoStrengths && soloWinners.length >= 2 && !aborted && searchAlpha === 0) {
      soloWinners.sort((a, b) => b.score - a.score);
      const g1 = soloWinners[0].group, g2 = soloWinners[1].group;
      const combo = {};
      for (const g of groupNames) combo[g] = (g === g1 || g === g2) ? 5 : 0;
      const { score, quant } = blendAndScore(combo, searchAlpha);
      if (score > passScore) {
        passScore = score;
        passStrengths = { ...combo };
        passQuant = quant;
      }
      await maybeYield('presets');
    }

    // ── Coordinate descent at this α (3 rounds) ──────────────────────────
    for (let round = 0; round < 3 && !aborted; round++) {
      let improved = false;
      await forceYield('descent');
      if (aborted) break;

      if (effectiveDoStrengths) {
        for (const g of tunableGroups) {
          if (aborted) break;
          let bestV = passStrengths[g];
          for (const v of STRENGTH_VALS) {
            passStrengths[g] = v;
            const { score, quant } = blendAndScore(passStrengths, searchAlpha);
            if (score > passScore) {
              passScore = score;
              bestV = v;
              passQuant = quant;
              improved = true;
            }
            await maybeYield('descent');
            if (aborted) break;
          }
          passStrengths[g] = bestV;
        }
      }
      if (!improved) break;
    }

    // ── Strength refinement at this α ────────────────────────────────────
    if (!aborted && effectiveDoStrengths) {
      await forceYield('refine');
      for (const g of tunableGroups) {
        if (aborted) break;
        const original = passStrengths[g];
        if (original === 0) continue;
        let groupBestV = original;
        for (const delta of [-2, -1, 1, 2]) {
          const v = original + delta;
          if (v < 0 || v > 15) continue;
          passStrengths[g] = v;
          const { score, quant } = blendAndScore(passStrengths, searchAlpha);
          if (score > passScore) {
            passScore = score;
            passQuant = quant;
            groupBestV = v;
          }
          await maybeYield('refine');
          if (aborted) break;
        }
        passStrengths[g] = groupBestV;
      }
    }

    // ── Keep this pass if it beats the current best ──────────────────────
    if (passScore > bestScore) {
      bestScore = passScore;
      bestStrengths = { ...passStrengths };
      bestAlpha = searchAlpha;
      bestQuant = passQuant;
    }
  }

  // ── Alpha fine-tuning (around the winning α) ──────────────────────────────
  // Sweep nearby α values to find the sweet spot. Cap at maxAlpha.
  if (doAlpha && hasEdges && !aborted) {
    await forceYield('alpha');
    const constrainedAlphaVals = alphaVals.filter(a => a <= maxAlpha);
    for (const a of constrainedAlphaVals) {
      if (aborted) break;
      const { score, quant } = blendAndScore(bestStrengths, a);
      if (score > bestScore) {
        bestScore = score;
        bestAlpha = a;
        bestQuant = quant;
      }
      await maybeYield('alpha');
    }
    if (!aborted && bestAlpha > 0) {
      const original = bestAlpha;
      for (const delta of [-0.15, -0.05, 0.05, 0.15]) {
        if (aborted) break;
        const a = Math.max(0, Math.min(maxAlpha, original + delta));
        if (a === original) continue;
        const { score, quant } = blendAndScore(bestStrengths, a);
        if (score > bestScore) {
          bestScore = score;
          bestAlpha = a;
          bestQuant = quant;
        }
        await maybeYield('alpha');
      }
    }
  }

  // Interpretability constraint: if descent zeroed out every tunable group
  // (e.g. karate, where topology alone scores best), auto-select ONE group to
  // carry a small positive strength so colorBy has something meaningful to use.
  // Pick the highest-scoring solo winner — that's the group with the most
  // information content per the metric. Use a small strength (3) that minimally
  // perturbs the topology-driven layout but gives the legend/colors purpose.
  if (effectiveDoStrengths && !aborted) {
    const anyNonZero = tunableGroups.some(g => (bestStrengths[g] || 0) > 0);
    if (!anyNonZero && soloWinners.length > 0) {
      soloWinners.sort((a, b) => b.score - a.score);
      const pickGroup = soloWinners[0].group;
      bestStrengths[pickGroup] = 3;
      // Don't re-score — this is an aesthetic override, not a performance tweak.
    }
  }

  // Final blend with best params
  unifiedBlend(nodes, groupNames, bestStrengths, bestAlpha, adjList, nodeIndexFull, 5, bestQuant, {});
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
    if ((bestStrengths[g] || 0) > maxTunedW) { maxTunedW = bestStrengths[g] || 0; dominantGroup = g; }
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
    strengths: bestStrengths,
    weights: bestStrengths, // deprecated alias
    alpha: bestAlpha,
    quantMode: bestQuant,
    labelProps,
    score: bestScore,
    blends, quants,
    timeMs: Math.round(performance.now() - t0),
  };
}

// ─── Bearing auto-tune (closed-form trace maximization) ─────────────────────
// For each group with non-trivial strength, find the rotation θ that maximizes
// trace(Cov(blended positions)) = Var(x) + Var(y). With other groups fixed,
// the trace is  K + 2A·cos(θ) + 2B·sin(θ)  ⟹  optimum at θ* = atan2(B, A).
// Two coordinate-descent passes over groups. Cost: O(N·G) per pass — same as
// one blend call. Returns a bearings object {groupName: radians}.

export function autoTuneBearings(nodes, groupNames, propStrengths) {
  const G = groupNames.length;
  if (G < 2) return {};

  // Compute effective strengths (mirrors unifiedBlend's floor logic).
  let maxW = 0;
  for (const g of groupNames) {
    const raw = propStrengths[g] || 0;
    if (raw > maxW) maxW = raw;
  }
  const floor = Math.max(maxW * STRENGTH_FLOOR_RATIO, STRENGTH_FLOOR_MIN);
  const effW = new Float64Array(G);
  let propTotal = 0;
  for (let gi = 0; gi < G; gi++) {
    effW[gi] = Math.max(propStrengths[groupNames[gi]] || 0, floor);
    propTotal += effW[gi];
  }
  // Skip if fewer than 2 groups have any user-set strength (floor-only groups
  // still contribute via the strength floor, but if the user set only 1 group,
  // the floored groups are noise — rotating them won't help).
  let userSet = 0;
  for (let gi = 0; gi < G; gi++) if ((propStrengths[groupNames[gi]] || 0) > 0) userSet++;
  if (userSet < 2) return {};

  const N = nodes.length;
  if (N < 4) return {};

  // Per-group weighted projection arrays (unrotated). ux[gi][i], uy[gi][i].
  const ux = new Array(G);
  const uy = new Array(G);
  for (let gi = 0; gi < G; gi++) {
    const gxArr = new Float64Array(N);
    const gyArr = new Float64Array(N);
    const g = groupNames[gi];
    const w = effW[gi] / propTotal;
    for (let i = 0; i < N; i++) {
      const p = nodes[i].projections[g];
      if (p) { gxArr[i] = p[0] * w; gyArr[i] = p[1] * w; }
    }
    ux[gi] = gxArr;
    uy[gi] = gyArr;
  }

  // Current bearings (start from zero).
  const bearings = new Float64Array(G); // radians

  // Sum arrays: total blended x, y per node.
  const sumX = new Float64Array(N);
  const sumY = new Float64Array(N);

  const recomputeSum = () => {
    sumX.fill(0);
    sumY.fill(0);
    for (let gi = 0; gi < G; gi++) {
      const c = Math.cos(bearings[gi]), s = Math.sin(bearings[gi]);
      const gx = ux[gi], gy = uy[gi];
      for (let i = 0; i < N; i++) {
        sumX[i] += gx[i] * c - gy[i] * s;
        sumY[i] += gx[i] * s + gy[i] * c;
      }
    }
  };

  recomputeSum();

  // Two coordinate-descent passes.
  for (let pass = 0; pass < 2; pass++) {
    for (let gi = 0; gi < G; gi++) {
      if (effW[gi] <= floor + 0.01) continue; // skip trivial groups

      // Subtract group gi's current contribution from sum.
      const oldC = Math.cos(bearings[gi]), oldS = Math.sin(bearings[gi]);
      const gx = ux[gi], gy = uy[gi];
      for (let i = 0; i < N; i++) {
        sumX[i] -= gx[i] * oldC - gy[i] * oldS;
        sumY[i] -= gx[i] * oldS + gy[i] * oldC;
      }

      // Compute covariances for closed-form solution.
      // A = Cov(S_x, U_x) + Cov(S_y, U_y)
      // B = Cov(S_y, U_x) - Cov(S_x, U_y)
      // where S = sum without gi, U = (gx, gy) for group gi.
      let mSx = 0, mSy = 0, mUx = 0, mUy = 0;
      for (let i = 0; i < N; i++) {
        mSx += sumX[i]; mSy += sumY[i];
        mUx += gx[i]; mUy += gy[i];
      }
      mSx /= N; mSy /= N; mUx /= N; mUy /= N;

      let covSxUx = 0, covSyUy = 0, covSyUx = 0, covSxUy = 0;
      for (let i = 0; i < N; i++) {
        const dSx = sumX[i] - mSx, dSy = sumY[i] - mSy;
        const dUx = gx[i] - mUx, dUy = gy[i] - mUy;
        covSxUx += dSx * dUx;
        covSyUy += dSy * dUy;
        covSyUx += dSy * dUx;
        covSxUy += dSx * dUy;
      }

      const A = covSxUx + covSyUy;
      const B = covSyUx - covSxUy;

      // If A and B are both ~0, this group's projection is uncorrelated with
      // the rest — any angle is equally good, keep current.
      if (Math.abs(A) < 1e-12 && Math.abs(B) < 1e-12) {
        // Add back old contribution.
        for (let i = 0; i < N; i++) {
          sumX[i] += gx[i] * oldC - gy[i] * oldS;
          sumY[i] += gx[i] * oldS + gy[i] * oldC;
        }
        continue;
      }

      bearings[gi] = Math.atan2(B, A);

      // Add back with new bearing.
      const newC = Math.cos(bearings[gi]), newS = Math.sin(bearings[gi]);
      for (let i = 0; i < N; i++) {
        sumX[i] += gx[i] * newC - gy[i] * newS;
        sumY[i] += gx[i] * newS + gy[i] * newC;
      }
    }
  }

  // Build result object. Only include non-zero bearings.
  const result = {};
  for (let gi = 0; gi < G; gi++) {
    if (Math.abs(bearings[gi]) > 1e-6) {
      result[groupNames[gi]] = bearings[gi];
    }
  }
  return result;
}
