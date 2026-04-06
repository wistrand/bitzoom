# Auto-Tune: Architecture and Implementation

Heuristic optimizer for BitZoom strength/alpha/quant parameters. Implemented in
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

Because the dominant group changes across trials (coordinate descent varies weights), the purity term is re-evaluated per trial using the category array of whichever group has the highest strength in that trial.

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
- **Any group with <2 distinct values** — e.g., GEXF files where `group` defaults to `'unknown'` for all nodes. Such a group provides no spreading signal, so any strength on it is a no-op (pulls all nodes toward a constant offset). Previously these zero-signal groups leaked into the result as visible-but-meaningless noise; now they're filtered out of `tunableGroups` entirely.

**Conditionally included:**
- `edgetype` is tuned only when it has >2 distinct values across all nodes. Datasets like Epstein (5+ edge types) get it tuned; graphs with one or two types don't.

### Edge-only detection

Before starting the strength search, the optimizer scans tunable groups for distinct values. If all have ≤1 distinct value, `hasPropertySignal = false` and `effectiveDoWeights = false` — strength search is skipped entirely. Only alpha and quant are tuned. Avoids wasting blends on meaningless property configurations.

### Category cache for purity

At initialization, for each tunable group (except `edgetype`, which is multi-valued per node), build an array `category[i]` = the node's value for that group. Only cache groups with 2–50 distinct values — excludes high-cardinality numerics (`bill_length_mm`, `body_mass_g`) and identifiers where exact-equality purity is nonsensical.

Per trial, `pickCategoryArray(weights)` returns the cached array for the currently-dominant weighted group. If the dominant group isn't in the cache (or no categorical is weighted), falls back to the `group` cache, then any cached group, then `null` (purity skipped).

## Why auto-tune works

The optimizer is effective because it exploits structural properties of the BitZoom layout:

1. **Fixed anchors eliminate most variables.** MinHash + Gaussian projection computes each node's 2D position per group once at load. Strengths linearly blend these fixed points — no force simulation to converge, no embedding to train. Small strength changes produce small layout changes, making the objective smooth and coordinate descent effective.

2. **The metric correlates with visual quality.** Spread × CV × purity measures what makes a layout look good: nodes aren't collapsed (spread), they form clusters with gaps (CV), and clusters are semantically clean (purity). It's a cheap O(n) proxy that tracks visual quality well enough for ranking.

3. **The search space is tiny.** With 5 tunable groups × 4 discrete values ≈ 1000 possible strength combinations. Coordinate descent with 3 rounds + refinement covers this efficiently. Compare to force-directed (continuous optimization over 2n variables) or t-SNE (gradient descent on n×n distances). We optimize 5-10 parameters, not thousands.

4. **The dual-pass discovers synergies.** Searching at both α=0 and α=0.5 finds two kinds of useful properties: those that cluster nodes independently (type, generation) AND those that only help when topology connects related nodes (edgetype, platforms). The α=0.5 pass discovers the second kind — this is why Epstein finds `edgetype` and BZ Source finds `lines`/`bytes`.

5. **Memoization makes it fast.** The `(strengths, alpha)` → score cache means revisited configurations are free. At 2-5ms per blend, the full dual-pass runs in 30-300ms.

6. **The α cap prevents the one failure mode.** Without it, α=1 always wins on CV because topology collapses nodes into tight clusters (CV can jump 3-4× at full topology). The 0.75 cap eliminates this attractor while allowing genuine topology contributions at moderate α.

## Search strategy

### Dual-pass strength search

The optimizer runs the full preset → descent → refine pipeline at **two α levels** (0 and 0.5), then picks whichever produces the higher score. This explores both the property-only and property+topology landscapes:

- **Pass A (α=0)**: finds strengths that work for property separation alone. Discovers groups like `generation` (Pokemon) that cluster independently of edges.
- **Pass B (α=0.5)**: finds strengths that synergize with topology. Discovers groups like `edgetype` (Epstein) that only differentiate when connected nodes share edge-type structure.

The two passes share the same memoized score cache, so overlapping evaluations are free.

For each pass, the pipeline is:

**1. Preset scan** — evaluate balanced (all groups at 3), solo (each group at 8), and interaction (top 2 solos combined at 5) configurations.

**2. Coordinate descent** (3 rounds, early exit) — sweep each tunable group's strength over `STRENGTH_VALS = [0, 3, 8, 10]`.

**3. Local refinement** — probe ±1, ±2 around each non-zero strength.

### Alpha fine-tuning

After the dual-pass picks the winning (strengths, α) pair, sweep α over {0, 0.25, 0.5, 0.75} with the winning strengths, then fine-tune ±0.05/±0.15. For property datasets, α is capped at 0.75 — full topology (α=1) inflates CV by 3-4× and always wins on the metric even when it destroys property structure. Edge-only datasets use the full [0, 1] range.

### Aesthetic fallback

If descent + refinement zero out every tunable group (e.g., karate where topology alone wins), force the highest-scoring solo preset group to strength 3. This is an **interpretability override** — gives colorBy something meaningful without re-scoring.

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
import { autoTuneStrengths } from './bitzoom-utils.js';

const result = await autoTuneStrengths(nodes, groupNames, adjList, nodeIndexFull, {
  weights: true,      // tune property strengths
  alpha: true,        // tune topology weight
  quant: false,       // tune quantization mode (default: only gaussian)
  signal: controller.signal,  // AbortSignal (optional)
  timeout: 20000,     // max ms (default 20000, 0 = no limit)
  onProgress(info) {  // { phase, step, total, score }
    // phase ∈ 'presets' | 'descent' | 'refine' | 'done'
    console.log(`${info.phase} ${info.step}/${info.total}`);
  },
});
// result: { strengths, alpha, quantMode, labelProps, score, blends, quants, timeMs }
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

2. **Automatic: `_autoTuneFresh()` on load** — fired from `_finalizeLoad` when the dataset has no preset `settings` AND the URL hash doesn't carry explicit strengths (`params.st`). Shares the same abort controller and apply path as the manual button (`this._tuneAbort`, `this._applyTuneResult`). Users loading a curated preset (epstein, pokemon, mitre-attack) skip auto-tune entirely; users dropping a raw CSV get a meaningful first frame. After `autoTuneStrengths` completes, `autoTuneBearings` runs to optimize per-group rotations.

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

## Bearing auto-tune (closed-form trace maximization)

After weight/alpha optimization, `autoTuneBearings(nodes, groupNames, propStrengths)` finds per-group rotations that maximize the total 2D spread of the blended layout. Implemented in [bitzoom-utils.js](../docs/bitzoom-utils.js).

### Mathematical basis

Each group contributes a weighted, rotated 2D vector to each node's position:

```
p_i = Σ_g  w_g · R(θ_g) · proj_g(i)  /  Σ w_g
```

For a fixed reference (all other groups), varying one group's angle θ_g changes the total variance (trace of point-cloud covariance) as a sinusoid:

```
Var(x) + Var(y) = K + 2A·cos(θ) + 2B·sin(θ)
  where  A = Cov(S_x, U_x) + Cov(S_y, U_y)
         B = Cov(S_y, U_x) − Cov(S_x, U_y)
```

`S` is the sum of all other groups' contributions, `U` is the current group's unrotated contribution. The maximum is at **θ\* = atan2(B, A)** — a closed-form solution requiring only mean/covariance computation, no search or sampling.

### Algorithm

Two coordinate-descent passes over groups (sorted by weight descending):

1. Compute total sum `S_x, S_y` across all groups with current bearings — O(N·G)
2. For each group g with user-set strength > 0:
   - Subtract g's current contribution from S — O(N)
   - Compute covariances A, B between S (without g) and g's projection — O(N)
   - Set θ_g = atan2(B, A) — O(1)
   - Add g back with new θ_g — O(N)
3. Repeat for a second pass (convergence is fast since each step is optimal given the others)

**Total cost: O(N·G) per pass, 2 passes ≈ same as one blend call.** No scoring, no quantization, no trial blends.

### Why trace instead of purity

- **Purity** needs quantization + bin histograms per evaluation — too expensive for a per-angle optimizer, and discrete (no closed form).
- **Determinant of Cov** (true 2D area) has a closed form in 2θ but requires 4 cross-covariance terms — messier with marginal benefit.
- **Trace** (Var(x) + Var(y)) is the simplest closed-form target and directly measures "spreading nodes apart in 2D". In practice it produces good results because maximizing total variance with well-chosen weights already pushes groups toward orthogonal orientations.

### Entry guards

Returns `{}` (no rotation) when:
- Fewer than 2 groups — rotation is meaningless with one projection axis
- Fewer than 2 groups with user-set strength > 0 — floored groups are noise, rotating them adds no signal
- Fewer than 4 nodes — covariance is degenerate

Groups at exactly the strength floor (user weight 0) are skipped during optimization — they contribute via the floor but their arbitrary PRNG direction shouldn't be "optimized" since the user didn't select them.

### Integration

Called inside `_applyTuneResult` after `autoTuneStrengths` completes:

```
autoTuneStrengths(...)  →  result.strengths
autoTuneBearings(nodes, groupNames, result.strengths)  →  bearings {}
v.propBearings = bearings
_syncBearingUI()      →  updates dial tick, aria, nonzero class
rebuildProjections()  →  re-blends with new bearings
```

Runs for both the manual Auto button and the auto-tune-on-load path. The bearing dials in the sidebar update to reflect the computed angles and remain manually adjustable afterward.

### Dial snap-to-zero

The dial UI snaps to 0° when within ±5° of north. This prevents jitter near the reset point and gives a clear tactile detent at the default orientation.

## Limitations

- Optimizes for visual structure (spread × CV × purity), not domain semantics. The purity term improves semantic quality but still can't know which properties the user cares about — e.g., Epstein's `edgetype` is highly discriminative but the tuner picks `group` instead because it scores better on the metric.
- Cannot distinguish fine-grained numeric dimensions from noise. A column with 300 distinct values contributes to spread but has near-zero purity (each cell holds at most 1 of each value); the tuner may still pick it if the CV boost is large.
- Coordinate descent can miss strength interactions beyond the top-2 combination preset.
- Edge-only datasets (Email EU, Facebook, Power Grid) have no tunable property signal — result is `strengths: {}`, `alpha` only. The aesthetic fallback doesn't fire because there are no tunable groups to promote.
- The α cap (0.75 for property datasets) prevents the worst cases of topology-dominated layouts but moderate α (0.25-0.75) can still reduce PropNbrP on some datasets. The dual-pass mitigates this by finding strengths that work with topology, but multi-group interactions (MITRE's group + platforms + killchain) remain hard to discover via coordinate descent.
- `TUNE_PASSES=2` may occasionally rank layouts differently than fully-converged (5-pass) smoothing would for high-α topology-heavy datasets, though in practice the ordering is stable.
- Sensitive to starting strengths: the coordinate descent path depends on the best preset found in Phase 1, so highly degenerate datasets can land in different local optima on different runs (though each run is deterministic).

## Benchmark results

Autotune vs hand-tuned and baselines on 5 property datasets (PropNbrP, higher = better):

| Dataset | Hand-tuned | Autotune | Best baseline | Autotune / baseline |
|---------|----------:|----------:|--------------:|-------------------:|
| Epstein (514) | 0.118 | **0.116** | 0.090 (t-SNE) | **1.28×** |
| Pokemon (959) | 0.019 | **0.025** | 0.022 (FA2) | **1.13×** |
| MITRE (4,736) | 0.034 | 0.013 | 0.026 (t-SNE) | 0.49× |
| Synth Pkg (1,868) | 0.050 | 0.022 | 0.013 (t-SNE) | **1.76×** |
| BZ Source (917) | 0.244 | 0.163 | 0.303 (UMAP) | 0.54× |

Autotune beats all baselines on 3 of 5 property datasets (Epstein, Pokemon, Synth Packages). Epstein is the dual-pass showcase — the α=0.5 pass discovers `edgetype:3`, reaching 98% of hand-tuned PropNbrP. MITRE remains the weak spot: the optimal three-group interaction isn't discoverable from coordinate descent. All at 1,000-70,000× faster than FA2/t-SNE/UMAP. See [comparison.html](../docs/comparison.html) for full results.
