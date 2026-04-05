# Design: Per-Group Bearings and Higher-Level Layout Effects

Exploration of exposing manual rotation on per-group projection axes, plus related higher-level effects (vortex, gravity, tides). Not yet implemented — this document captures the math, scope, and caveats before committing.

## Motivation

Each property group has an independent Gaussian projection matrix producing `(p_g.x, p_g.y)`. The blend step sums these as 2D vectors weighted by `propWeights`:

```
prop_x = Σ_g  w_g · p_g.x / W
prop_y = Σ_g  w_g · p_g.y / W
```

Every group's 2D output lives in its own arbitrary local frame, because each `R_g` uses an independent seed. The blend silently assumes these frames are compatible — they aren't; they only share the origin. Groups can fight each other (one pushes (1,0), another pushes (−1,0), sum is zero) and the user has no control over which direction each group "points."

**Bearings** expose this hidden degree of freedom: per-group rotation, applied during blend, turning each group from a random-direction scalar contribution into a user-steerable 2D vector with magnitude (strength) and direction (bearing).

## Math

Rotate `(p_g.x, p_g.y)` by `θ_g` before the weighted sum:

```
prop_x = Σ_g  w_g · (p_g.x · cos θ_g − p_g.y · sin θ_g) / W
prop_y = Σ_g  w_g · (p_g.x · sin θ_g + p_g.y · cos θ_g) / W
```

Rotating the output is exactly equivalent to rotating the two rows of `R_g` before projection — projection and rotation are the same operation applied in sequence. Exposing rotation pulls it out of the matrix and makes it a knob.

Topology blend (α term) is unaffected — rotation shapes the property signal, topology then smooths it over neighbors. Composes cleanly, no interaction.

## Implementation scope

**Three possible places to apply rotation:**

1. **Rotate R_g itself** — re-project every node per group per rotation change. ~50ms per group for 367K nodes. Too expensive.
2. **Rotate stored `(p_g.x, p_g.y)` in place** — mutates cached projections. Fast but destroys the original; rotation deltas compound numerically.
3. **Rotate during blend** — lookup `cos/sin` per group once, apply in inner loop. Zero extra cost, fully reversible, angle is just another parameter like weight.

**Option 3 is the right answer.** But the "20 lines of code" estimate is optimistic. Realistic scope:

- `unifiedBlend` in [bitzoom-algo.js](../docs/bitzoom-algo.js) — CPU blend inner loop (trivial)
- [bitzoom-gpu.js](../docs/bitzoom-gpu.js) — WebGPU compute blend shader needs per-group cos/sin buffer/uniform
- `propBearings` dataset setting + constructor opt + URL hash serialization
- Sidebar UI — draggable dial per group label to set bearing
- `autoTuneWeights` — decide whether to include bearings in search
- Quantization interaction (see below)

Realistic budget: ~1-2 days, not 20 lines.

## Caveats

### Quantization is rotation-sensitive

From [CLAUDE.md](../CLAUDE.md):

> Gaussian quantization boundaries (μ,σ) freeze from the dataset-tuned weight snapshot (reset in `_applyDatasetSettings`) — stable across subsequent weight/alpha changes but can misfit if the distribution shifts significantly.

Rotation changes the distribution of blended x/y values (not magnitudes, but axis projections of the sum). Frozen boundaries will misfit in exactly the way the comment warns about. Must decide: **refreeze on bearing change**, or accept the misfit. This is not free.

### Weight floor behavior (improvement, not caveat)

`WEIGHT_FLOOR_RATIO=0.10` guarantees zero-weight groups still contribute 10% magnitude for spreading. Currently that 10% goes in a random direction determined by the PRNG seed. After bearings, the floor's contribution becomes user-controlled — strictly better than current behavior. Worth highlighting as a benefit.

### Auto-tune interaction

`autoTuneWeights` maximizes spread × clumpiness over weight/alpha/quant. Adding bearings widens the search space by `G` continuous parameters. Two options:

- **Ignore bearings** — user sets them manually, auto-tune only handles strengths
- **Include bearings** — search space multiplies, significant runtime cost

Recommend the first: auto-tune finds strengths, user sets bearings.

### URL hash and persistence

Add `bearings=platform:0,kill_chain:90,group:45` alongside existing `w=` weights hash. Store in dataset settings for persistence. Serializes per existing URL hash pattern.

### Edge cases

- **Empty signatures** (sentinel `-1` → neutral `[0,0]`) — rotating zero is zero. Unaffected.
- **Topology blend** — unchanged. Rotation shapes property contribution, topology smooths after.
- **colorBy / labels** — unaffected. These are orthogonal to the spatial projection.

## Vocabulary: weight → strength

Once bearings exist, "weight" is the wrong word for magnitude. A force/navigation metaphor needs a matching pair:

- "Platform has **weight** 5 and **bearing** 090°" — mismatched. Weight is statistical scalar; bearing is vector direction.
- "Platform has **strength** 5 and **bearing** 090°" — coherent. Both live in physics/navigation vocabulary.

### Rename mechanics

| Before | After |
|--------|-------|
| `propWeights` | `propStrengths` |
| `setWeights()` | `setStrengths()` |
| `WEIGHT_FLOOR_RATIO`, `WEIGHT_FLOOR_MIN` | `STRENGTH_FLOOR_RATIO`, `STRENGTH_FLOOR_MIN` |
| `autoTuneWeights` | `autoTuneStrengths` |
| `.weight-slider`, `.weight-label`, `#wv-*` CSS/IDs | `.strength-*` |
| URL hash `w=group:5,lang:8` | `s=group:5,lang:8` |

Breaking change. Migration: accept both `w=` and `s=` in hash parser for one release, then drop.

### Why rename at all

"Weight" carries statistical baggage (weighted average, regression weights, edge weights, attention weights) that BitZoom doesn't actually want. "Strength" matches the physics/navigation metaphor BitZoom is already committing to (bearings, property vectors, navigation of similarity space).

Don't rename unless bearings ship. Without bearings, "weight" alone is fine and familiar.

## Higher-level effects

Once the blend is understood as "sum of per-group 2D vectors," other effects become visible. Not all of them fit BitZoom's math.

### Vortex (ring mode) — needs rework

**The idea:** each group gets a mode switch — linear (bearing + strength) or ring (cyclic). Ring mode arranges nodes angularly around a center, matching cyclic/ordinal properties: kill chain phases, months, ATT&CK tactics, MITRE phases.

**The flaw in the naive approach:** reinterpreting the existing `(p_g.x, p_g.y)` MinHash output as polar coordinates `(r, θ)` does not give you cyclic ordering. The MinHash projection is random — it has no relationship to any ordering of the property values. Re-interpreting random Cartesian as polar just gives you the same random cloud viewed in polar coordinates.

**The real implementation:** a per-group *projection mode replacement*. For ordinal/cyclic properties, bypass MinHash and map the property value directly to an angle:

```
θ_node = 2π × (phase_index / num_phases) + small_jitter
r_node = strength_g
```

This is a new projection mode, not a tweak to blend. More invasive than the naive pitch, but the only way it works.

**Verdict:** real capability, no other tool has it for ordinal properties, but requires a new per-group projection pipeline alongside MinHash. Defer until bearings ship.

### Gravity (anchors) — cleanest fit

**The idea:** pin one or more nodes as anchors. All other nodes are attracted toward anchors proportional to their MinHash similarity. Stronger similarity = stronger pull.

**Why it fits:** BitZoom already has MinHash signatures cached per node, typed-array `_sig` for fast comparisons, and a selection mechanism (`selectedId`, `selectedIds`). Gravity is a post-blend relaxation step that reuses existing machinery. "Pin a node, see what's like it" becomes a zero-cost feature of existing selection.

**Mathematically:** add a pass after `unifiedBlend` that pulls every node toward each anchor by `similarity(node, anchor) × gravity_strength`. One or two iterations, no force balance needed (not a simulation).

**Caveat:** moving nodes after layout breaks the bit-prefix containment invariant. A node at level L might no longer fall in a sub-cell of its level L−1 parent. The quantizer re-runs so valid supernodes still form, but cross-level lineage (same-node-same-supernode-under-zoom) breaks. Not fatal, but worth knowing. Alternatively: apply gravity *before* quantization each pass, keeping containment intact.

**Verdict:** highest capability-to-cost ratio. Turns static layout into a query interface. "Set a lodestar" as UX.

### Tides (temporal modulation) — trivial

**The idea:** for time-typed properties (`year`, `last_seen`, `age`), animate strength over time to reveal how clusters form and dissolve.

**Why it fits:** blend already recomputes on strength change. Animating `strength_g(t)` is just a timer + repeated `_blend()` calls. No architectural friction.

**Cost:** re-quantize per frame if quantization is enabled (this is the expensive part). Could pre-compute snapshots at discrete timesteps for smooth scrubbing.

**Verdict:** simple to implement, powerful storytelling for time-varying data. Good demo material.

### Effects that don't fit

- **Turbulence / jitter** — chaotic perturbation encodes no signal. Dresses up a jitter function as profundity. Only makes sense as a rendering effect at extreme zoom, not a layout effect.
- **Wind / constant force** — just translation. Pan already handles this.
- **Repulsion** — would break quantization-based overlap handling and destroy determinism (same input → same layout forever). Don't do it.
- **Drag / friction** — requires velocities. BitZoom has no simulation step.
- **Buoyancy** — requires concept of "up" and density differences. Neither exists.
- **Magnetism** — gravity with a sign (attraction + repulsion). The repulsion half breaks determinism.

### Summary

| Effect | Fit | Cost | Notes |
|--------|-----|------|-------|
| **Bearings** | Strong | ~1-2 days | CPU + GPU blend, UI, hash, quant refreeze |
| **Gravity** | Strong | ~1 day | Reuses MinHash, containment caveat |
| **Tides** | Strong (time data only) | Trivial | Animate strength over time |
| **Vortex / ring** | Weak as pitched | High | Needs new projection mode for cyclic props |
| Turbulence, wind, drag, buoyancy, magnetism, repulsion | None | — | Skip |

## Priority

If any of these ship, this order:

1. **Bearings + strength rename** — fixes the hidden "random local frame" problem, exposes the latent rotation degree of freedom, gives vocabulary a coherent metaphor.
2. **Gravity / anchors** — turns layout into a query. The feature that would make analysts fall in love with BitZoom.
3. **Tides** — for datasets with time dimension. Animated GIFs of clusters evolving. Marketing-friendly.
4. **Vortex / ring mode** — only after 1-3, and only with a real per-group projection mode, not the naive reinterpretation.

## Open questions

- Should bearings be per-dataset settings, per-group defaults, or user-interactive only (reset on reload)?
- Should quantization refreeze on bearing change, or accept the misfit with a "reset quantization" button?
- Should the sidebar dial snap to 0/90/180/270° for easy orthogonal alignment, or free rotation with modifier-key snap?
- Does the legend already show enough group affordance for a draggable dial UI, or does it need a new compass-rose widget?
