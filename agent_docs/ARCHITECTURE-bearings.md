# Bearings: Per-Group Rotation

Each property group's MinHash projection produces a 2D point in an arbitrary PRNG-seeded frame. **Bearings** expose this hidden degree of freedom: a user-settable rotation θ per group, applied during the blend inner loop. Each group becomes a steerable 2D vector with strength (how much it pulls) and bearing (which direction).

## The math

Before the weighted sum in `unifiedBlend`, rotate each group's per-node projection by θ_g:

```
px = Σ_g  s_g · (p_g.x · cos θ_g − p_g.y · sin θ_g) / S
py = Σ_g  s_g · (p_g.x · sin θ_g + p_g.y · cos θ_g) / S
```

Cost: `cos/sin` looked up once per group per blend, 2 mul + 1 add per (node, group) pair instead of 2 mul. Effectively free. Topology blend (α term) is unaffected — bearings shape the property signal, topology smooths it afterward.

## Implementation

### Blend layer ([bitzoom-algo.js](../docs/bitzoom-algo.js))

`unifiedBlend` accepts an optional `propBearings` parameter (object mapping group name → radians, default `null`). When non-null with any non-zero entry:

1. Precomputes `cosBearing[gi]` / `sinBearing[gi]` arrays — O(G)
2. Uses the rotation branch in the property-anchor loop
3. Fast path preserved: `null` or all-zero bearings skip rotation entirely

### Canvas state ([bitzoom-canvas.js](../docs/bitzoom-canvas.js))

- `this.propBearings = {}` — per-group rotation in radians
- `setBearing(group, radians)` — sets one group, triggers re-blend + render
- `bulkSetBearings(obj)` — sets multiple without per-group re-blending (caller triggers blend)
- GPU fallback: when bearings are set, `_blend()` falls back to CPU (WebGPU compute shader lacks rotation support)

### URL hash persistence

Serialized as a positional array in degrees (2 decimal places): `b=28.65,0,0,0` — indexed by `groupNames` order, always present alongside `st=` as an all-or-nothing settings block. Parsed in `_applyHashState`; when settings are present, all are restored atomically with a full blend + layout + render.

### Dataset presets

Optional `settings.bearings` field in [datasets.json](../docs/datasets.json). Stored in degrees for human readability, converted to radians on load via `_applyDatasetSettings`.

### Sidebar dial ([bitzoom-viewer.js](../docs/bitzoom-viewer.js))

Each property group row in the sidebar has a 24×24px bearing dial (`.bearing-dial` + `.bearing-tick`):

- **Music-software knob UX**: vertical drag only — drag up to increase, drag down to decrease. 200px vertical = 360° rotation. Shift = 4× fine control.
- **Snap to 0°**: ±5° dead zone near north prevents jitter at reset.
- **Reset**: double-click or Ctrl/Cmd-click resets to 0°.
- **Visual feedback**: `.nonzero` class on dial when bearing ≠ 0 (stronger border + opacity).
- **Keyboard**: arrow keys ±15° (Shift ±45°), PageUp/PageDown ±45°, Home/End, `0` resets.
- **Accessibility**: `role="slider"`, `aria-valuetext="N degrees"`, focus ring.

### Auto-tune bearings ([bitzoom-utils.js](../docs/bitzoom-utils.js))

`autoTuneBearings(nodes, groupNames, propStrengths)` — closed-form trace maximization. For each group, finds the rotation θ that maximizes `Var(x) + Var(y)` of the blended point cloud:

```
θ* = atan2(B, A)
  where  A = Cov(S_x, U_x) + Cov(S_y, U_y)
         B = Cov(S_y, U_x) − Cov(S_x, U_y)
```

Two coordinate-descent passes over groups. Total cost: O(N·G) — same as one blend call. No sampling, no scoring. Runs inside `_applyTuneResult` after `autoTuneStrengths` completes.

Entry guards: returns `{}` when <2 groups with user-set strength >0, or <4 nodes.

See [ARCHITECTURE-auto-tune.md](ARCHITECTURE-auto-tune.md) for full details.

## Invariants

- Bearings are purely a blend-time operation — no re-projection needed.
- `_quantStats` is cleared on every blend-triggering change (strengths, bearings, alpha) — layouts are path-independent.
- GPU compute blend falls back to CPU when bearings are set.
- Bearing auto-tune does NOT run during the tuner's search — only after the final strengths are chosen.
- URL hash uses positional arrays: `b=28.6,0,0` (degrees, group order). Always serialized with `st=` as an all-or-nothing settings block.
