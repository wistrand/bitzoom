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

function layoutScore(nodes, level) {
  const shift = 16 - level;
  const gridK = 1 << level;
  const totalCells = gridK * gridK;
  const cellCounts = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const key = (nodes[i].gx >> shift) * gridK + (nodes[i].gy >> shift);
    cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
  }
  const occupied = cellCounts.size;
  if (occupied <= 1) return 0;
  const spread = occupied / totalCells;
  let sum = 0, sumSq = 0;
  for (const c of cellCounts.values()) { sum += c; sumSq += c * c; }
  const mean = sum / occupied;
  const variance = sumSq / occupied - mean * mean;
  const cv = Math.sqrt(Math.max(0, variance)) / Math.max(1, mean);
  return spread * cv;
}

function quantizeOnly(nodes, mode) {
  if (mode === 'gaussian') gaussianQuantize(nodes, {});
  else normalizeAndQuantize(nodes);
}

const yieldFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

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
  const alphaVals = doAlpha ? ALPHA_VALS : [0];

  // Adaptive grid level: scale with dataset size so the metric has meaningful resolution.
  // 34 nodes → L3 (8x8=64 cells), 5K nodes → L5 (32x32), 367K nodes → L7 (128x128).
  const scoreLevel = Math.max(3, Math.min(7, Math.round(Math.log2(nodes.length) - 2)));

  // Determine tunable groups: 'group' + extra properties + edgetype if rich.
  // Exclude label (too high cardinality), structure (degree buckets), neighbors (auto-generated).
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
    return true;
  });

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
  const descentPerRound = (effectiveDoWeights ? G * WEIGHT_VALS.length : 0) + (doAlpha ? ALPHA_VALS.length : 0);
  const totalEstimate = presetCount + descentPerRound * 3;

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

  // Use custom blend function if provided (e.g., gpuUnifiedBlend), otherwise CPU
  const blendFn = opts.blendFn || unifiedBlend;

  const blendAndScore = async (weights, alpha) => {
    await blendFn(nodes, groupNames, weights, alpha, adjList, nodeIndexFull, 5, 'gaussian', {});
    blends++;
    for (let i = 0; i < nodes.length; i++) { savedPx[i] = nodes[i].px; savedPy[i] = nodes[i].py; }
    let localBest = -1, localQuant = 'gaussian';
    for (const q of QUANT_VALS) {
      for (let i = 0; i < nodes.length; i++) { nodes[i].px = savedPx[i]; nodes[i].py = savedPy[i]; }
      quantizeOnly(nodes, q);
      quants++;
      const score = layoutScore(nodes, scoreLevel);
      if (score > localBest) { localBest = score; localQuant = q; }
    }
    step++;
    return { score: localBest, quant: localQuant };
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
      const { score, quant } = await blendAndScore(weights, alpha);
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
      const { score, quant } = await blendAndScore(combo, alpha);
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
          const { score, quant } = await blendAndScore(bestWeights, bestAlpha);
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

    if (doAlpha && !aborted) {
      for (const a of ALPHA_VALS) {
        const { score, quant } = await blendAndScore(bestWeights, a);
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

  // Final blend with best params
  await blendFn(nodes, groupNames, bestWeights, bestAlpha, adjList, nodeIndexFull, 5, bestQuant, {});
  if (onProgress) onProgress({ phase: 'done', step: totalEstimate, total: totalEstimate, score: bestScore });

  // Pick label properties: show what the layout clusters by.
  // 1. The dominant weight group (matches visual clustering)
  // 2. 'label' if it has moderate cardinality (useful for identification, not too noisy)
  const labelProps = [];
  let maxTunedW = 0, dominantGroup = null;
  for (const g of tunableGroups) {
    if ((bestWeights[g] || 0) > maxTunedW) { maxTunedW = bestWeights[g] || 0; dominantGroup = g; }
  }
  if (dominantGroup && dominantGroup !== 'label') labelProps.push(dominantGroup);

  if (groupNames.includes('label')) {
    const distinctLabels = new Set();
    for (const n of nodes) { distinctLabels.add(n.label || n.id); if (distinctLabels.size > nodes.length * 0.8) break; }
    // Include 'label' when cardinality is moderate (>1 and <80% of nodes).
    // Too high = every supernode label is unique (not useful for pattern recognition).
    // Too low = all nodes share one label.
    if (distinctLabels.size > 1 && distinctLabels.size <= nodes.length * 0.8) {
      labelProps.push('label');
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
