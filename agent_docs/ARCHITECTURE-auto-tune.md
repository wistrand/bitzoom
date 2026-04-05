# Auto-Tune: Architecture and Implementation

Heuristic optimizer for BitZoom weight/alpha/quant parameters. Implemented in
[bitzoom-utils.js](../docs/bitzoom-utils.js). Exploits the O(n) blend+quantize
cost to evaluate many configurations and find a well-structured layout.

## Objective function

**spread × clumpiness × group-purity** at an adaptive grid level.

- **Spread** = occupied cells / total cells. Penalizes collapse (everyone in one cell).
- **Clumpiness** = coefficient of variation of per-cell node counts. Penalizes uniform scatter (all cells equal) and rewards clusters with gaps.
- **Group purity** = weighted average of majority-category fraction per cell, softened via `sqrt`. Penalizes mixed clusters and rewards layouts where cells are semantically clean (all nodes in a cell share the same category for the currently-dominant weighted group). Range ~1/K (random) to 1.0 (every cell pure). Skipped (treated as 1) when no categorical group has a cached category array.

Computation: O(n) per evaluation. Counts cell occupancy via `Map` on shifted `gx/gy`, plus per-cell per-category counts when a purity category array is available.

### Why purity matters

Without purity, the metric only measures spatial structure — "the points are clustered" — without checking whether **semantically similar** points cluster together. A random layout that happens to have uneven density can score the same as a clean group-separated layout. The purity term rewards layouts where the currently-dominant weighted group actually produces clean per-cell groupings.

Because the dominant group changes across trials (coordinate descent varies weights), the purity term is re-evaluated per trial using the category array of whichever group has the highest weight in that trial.

### Adaptive grid level

The grid level scales with dataset size so the metric has meaningful resolution:

```
scoreLevel = clamp(round(log2(n) - 2), 3, 7)
```

| Nodes | Level | Grid     | Cells |
| ----: | ----: | -------- | ----: |
|    34 |     3 | 8×8      |    64 |
| 1,000 |     5 | 32×32    | 1,024 |
| 5,000 |     5 | 32×32    | 1,024 |
|  367K |     7 | 128×128  | 16,384 |

## Tunable groups

Only semantically meaningful property groups are tuned: `group`, extra property columns from the `.nodes` file, and conditionally `edgetype`.

**Always excluded:**
- `label` — too high cardinality; each node has a unique label
- `structure` — degree buckets; auto-generated
- `neighbors` — auto-generated neighbor-count token

These produce high spread/CV scores but meaningless layouts.

**Excluded at runtime (new):**
- **Any group with <2 distinct values** — e.g., GEXF files where `group` defaults to `'unknown'` for all nodes. Such a group provides no spreading signal, so any weight on it is a no-op (pulls all nodes toward a constant offset). Previously these zero-signal groups leaked into the result as visible-but-meaningless noise; now they're filtered out of `tunableGroups` entirely.

**Conditionally included:**
- `edgetype` is tuned only when it has >2 distinct values across all nodes. Datasets like Epstein (5+ edge types) get it tuned; graphs with one or two types don't.

### Edge-only detection

Before starting the weight search, the optimizer scans tunable groups for distinct values. If all have ≤1 distinct value, `hasPropertySignal = false` and `effectiveDoWeights = false` — weight search is skipped entirely. Only alpha and quant are tuned. Avoids wasting blends on meaningless property configurations.

### Category cache for purity

At initialization, for each tunable group (except `edgetype`, which is multi-valued per node), build an array `category[i]` = the node's value for that group. Only cache groups with 2–50 distinct values — excludes high-cardinality numerics (`bill_length_mm`, `body_mass_g`) and identifiers where exact-equality purity is nonsensical.

Per trial, `pickCategoryArray(weights)` returns the cached array for the currently-dominant weighted group. If the dominant group isn't in the cache (or no categorical is weighted), falls back to the `group` cache, then any cached group, then `null` (purity skipped).

## Search strategy

### Phase 1: Preset scan

Evaluate preset weight configurations crossed with alpha values:

- **Balanced**: all tunable groups at weight 3
- **Solo**: each tunable group at weight 8 (others at 0)
- **Interaction**: top 2 solo winners combined at weight 5 each (catches common two-group combinations that coordinate descent alone would miss)

Crossed with `alphaVals` = {0, 0.25, 0.5, 0.75, 1.0} and `quantVals` = {gaussian} (or {rank, gaussian} if `opts.quant` is true).

Alpha is pinned to `[0]` when the graph has no edges — no topology to smooth, saves trial runs.

### Phase 2: Coordinate descent (3 rounds, early exit on no improvement)

From the best preset, optimize one parameter at a time:
1. Sweep each tunable group's weight over `WEIGHT_VALS = [0, 3, 8, 10]`
2. Sweep alpha over `alphaVals`
3. For each blend, try both quant modes if enabled
4. Early exit if no improvement in a round

### Phase 3: Local refinement (new)

Coordinate descent only probes a discrete grid `[0, 3, 8, 10]`. The true optimum often sits between grid points. Phase 3 does one local refinement pass around the best discrete point:

- **Per non-zero weight group**: probe `±1, ±2` around the current value. Skip groups already at zero (descent decided they don't contribute).
- **Alpha**: probe `±0.05, ±0.15` around the current alpha (clamped to `[0, 1]`). Only when `hasEdges`.

Greedy per-parameter: if any delta improves, commit. This catches cases where e.g. `α=0.8` beats the discrete grid's `α=0.75` by a meaningful margin.

### Aesthetic fallback

If coordinate descent + refinement zero out every tunable group (e.g., karate where topology alone wins), the tuner would leave `weights = {}` which produces a mathematically correct layout but a visually useless one — `colorBy` has nothing to pick and nodes are all rendered the same color.

After refinement, if `anyNonZero` is false, force the highest-scoring solo preset group to weight 3. This is explicitly an **interpretability override**, not a score-based decision — it doesn't re-score. The final blend still uses the aesthetic weight, giving the legend and coloring something meaningful without materially changing the topology-driven layout.

## Blend/quantize separation and performance

Each `blendAndScore` call does:
1. Call `blendFn` once with `TUNE_PASSES = 2` topology passes (not 5)
2. Save px/py into `savedPx/savedPy` Float64Arrays
3. For each quant mode: restore px/py, quantize, score via `layoutScore(nodes, scoreLevel, nodeCategory)`
4. Return `{score, quant}` for the best mode

### Reduced trial passes

`TUNE_PASSES = 2` instead of 5. Topology smoothing converges exponentially — 2 passes capture ~60-70% of the structure of 5 passes at 40% of the cost. Score **ranking** (what the tuner optimizes) is preserved even with partial convergence; the **final blend** uses full 5 passes for the layout the user actually sees.

### Score memoization

Every `(weights, alpha)` combination is hashed into a cache key (alpha.toFixed(3) + tunable-group weights joined). Coordinate descent and refinement sometimes revisit points already evaluated in the preset or previous rounds — cached lookups skip the blend entirely. On amazon, memoization cut blend count from 25 to 18.

### Module-level buffer reuse

`unifiedBlend` in [bitzoom-algo.js](../docs/bitzoom-algo.js) pre-allocates four `Float64Array(N)` buffers (`propPx`, `propPy`, `newPx`, `newPy`) in a module-level cache, grown on demand. Previously, each blend call allocated ~12MB at N=367K — for a tune with 25 blends × 5 passes that's ~880MB of allocation + GC churn per session. Now allocation is once per session and reused across all blend calls. Safe because the blend is sequential (not reentrant).

## Label auto-selection

After optimization, the result includes recommended `labelProps`:

1. **`label` (primary)** — always included when the dataset has a `label` group AND at least two nodes have distinct labels. This replaced an earlier 80%-cardinality threshold that mistakenly excluded unique-per-node labels from datasets like Les Mis (77 unique character names), Pokemon (959 names), and MITRE (4.7K T-codes). Unique labels ARE the right labels for person/entity graphs — they're identifiers, not clustering dimensions.

2. **Dominant weighted group (secondary)** — added alongside `label` when the dominant tuned group has 2–50 distinct values (categorical). High-cardinality groups (continuous numerics, identifiers) are excluded — their values don't help identify individual nodes.

Result: datasets with explicit names produce readable labels first, with a categorical context second. E.g., miserables produces `["label", "group"]` showing character names with community as context; karate.graphml produces `["label", "Faction"]`.

Explicit `labelProps` in opts take precedence over auto-tuned values.

## Portable async execution

The optimizer is `async` and yields to the event loop via `yieldFrame`:

```js
const yieldFrame = typeof requestAnimationFrame !== 'undefined'
  ? () => new Promise(resolve => requestAnimationFrame(resolve))
  : () => new Promise(resolve => setTimeout(resolve, 0));
```

**Browser environments** get `requestAnimationFrame` — paint-aligned, ~60Hz throttled, integrates with browser rendering.

**Non-browser environments** (Deno, Node, Bun, tests, CLI tools) fall back to `setTimeout(0)`. The tuner is fully usable from command-line scripts without caller-side polyfills.

Yields happen at phase boundaries and whenever >50ms has elapsed since the last yield. Keeps the UI responsive during optimization and lets progress callbacks paint.

### Stopping

- **AbortSignal**: pass `signal` in opts. Checked at every yield point.
- **Timeout**: pass `timeout` in ms (default: 20000). Checked alongside signal.
- **Viewer button**: toggles between "Auto" (start) and "Stop" (abort). Shared `this._tuneAbort` controller means pressing Stop works identically for both the manual click and the auto-on-load tune triggered by `_finalizeLoad`.

On abort or timeout, the optimizer returns the best result found so far.

## API

```javascript
import { autoTuneWeights } from './bitzoom-utils.js';

const result = await autoTuneWeights(nodes, groupNames, adjList, nodeIndexFull, {
  weights: true,      // tune property weights
  alpha: true,        // tune topology weight
  quant: false,       // tune quantization mode (default: only gaussian)
  signal: controller.signal,  // AbortSignal (optional)
  timeout: 20000,     // max ms (default 20000, 0 = no limit)
  onProgress(info) {  // { phase, step, total, score }
    // phase ∈ 'presets' | 'descent' | 'refine' | 'done'
    console.log(`${info.phase} ${info.step}/${info.total}`);
  },
});
// result: { weights, alpha, quantMode, labelProps, score, blends, quants, timeMs }
```

## Integration

### Embedded (createBitZoomView)

```javascript
const view = createBitZoomView(canvas, edgesText, nodesText, {
  autoTune: { weights: true, alpha: true },
});
```

Returns `BitZoomCanvas` synchronously with default weights. The optimizer runs
async in the background, shows progress overlay on the canvas, and re-renders
with tuned parameters (including label props) when done. Explicit `weights`,
`smoothAlpha`, `quantMode`, `labelProps` in opts take precedence.

### Viewer

Two entry points, sharing code:

1. **Manual: "Auto" button in the toolbar.** Click to start, click again to abort and apply best-so-far. Progress displayed as overlay on the canvas. After completion, weight sliders, alpha slider, quant button, and label checkboxes sync to reflect the tuned values. Click handler wrapped in try/catch so unexpected errors restore the button state and clear `_tuneAbort` rather than leaving a stuck "Stop" button.

2. **Automatic: `_autoTuneFresh()` on load** — fired from `_finalizeLoad` when the dataset has no preset `settings` AND the URL hash doesn't carry explicit strengths (`params.w`). Shares the same abort controller and apply path as the manual button (`this._tuneAbort`, `this._applyTuneResult`). Users loading a curated preset (epstein, pokemon, mitre-attack) skip auto-tune entirely; users dropping a raw CSV get a meaningful first frame.

## Performance

Each evaluation = `unifiedBlend` (TUNE_PASSES × (n+E)) + quantize + score.

With the post-optimization stack (buffer reuse, TUNE_PASSES=2, memoization):

| Dataset      |    Nodes |    Edges | Per blend | Typical total |
| ------------ | -------: | -------: | --------: | ------------: |
| karate       |       34 |       78 |    <0.1ms |         ~10ms |
| miserables   |       77 |      254 |    <0.1ms |          ~5ms |
| epstein      |      514 |      534 |      ~0.5ms |        ~20ms |
| penguins.csv |      344 |        0 |      ~0.1ms |        ~15ms |
| mitre-attack |    4,736 |   25,856 |      ~3ms |       ~320ms |
| amazon       |  367,000 |  988,000 |      ~670ms |       ~12s   |

The amazon tune dropped from ~32s (pre-optimization) to ~12s — a 2.6× speedup driven primarily by module-level buffer reuse (eliminates ~880MB of GC pressure per tune) and reduced trial passes (2 instead of 5 for topology smoothing).

## Limitations

- Optimizes for visual structure (spread × CV × purity), not domain semantics. The purity term improves semantic quality but still can't know which properties the user cares about — e.g., Marvel's `eye` (16 distinct) might beat `alignment` (4 distinct) because 16 categories produce more cells and potentially cleaner numerical structure, even though alignment is semantically richer.
- Cannot distinguish fine-grained numeric dimensions from noise. A column with 300 distinct values contributes to spread but has near-zero purity (each cell holds at most 1 of each value); the tuner may still pick it if the CV boost is large.
- Coordinate descent can miss weight interactions beyond the top-2 combination preset.
- Edge-only datasets (Email EU, Facebook, Power Grid) have no tunable property signal — result is `weights: {}`, `alpha` only. The aesthetic fallback doesn't fire because there are no tunable groups to promote.
- `TUNE_PASSES=2` may occasionally rank layouts differently than fully-converged (5-pass) smoothing would for high-α topology-heavy datasets, though in practice the ordering is stable.
- Sensitive to starting weights: the coordinate descent path depends on the best preset found in Phase 1, so highly degenerate datasets can land in different local optima on different runs (though each run is deterministic).
