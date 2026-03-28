# BitZoom Architecture

## Overview

BitZoom is a deterministic layout and hierarchical aggregation viewer for large property graphs. Nodes are positioned by property similarity using MinHash + Gaussian projection, with stable zoom levels derived from stored uint16 grid coordinates via bit shifts.

## Project Structure

```
docs/                    Web application (ES modules, served by Deno)
  index.html               Landing page
  viewer.html              Viewer HTML shell — header, loader, canvas, sidebar, detail panel
  about.html               How It Works — interactive explainer with embedded demos
  howto.html               Developer Guide — embedding API, data format, examples
  bitzoom.css              Styles — dark theme, responsive, loader, detail panel overlay
  bitzoom-algo.js          Pure algorithm functions and constants (no DOM)
  bitzoom-pipeline.js      Shared parsers, graph building, tokenization, projection
  bitzoom-renderer.js      Canvas rendering, heatmaps, hit testing (no state mutation)
  bitzoom-canvas.js        Standalone embeddable component — canvas, interaction, rendering
  bitzoom-viewer.js        BitZoom app (composes BitZoomCanvas) — UI, workers, data loading
  bitzoom-worker.js        Web Worker coordinator — uses pipeline, fans out projection
  bitzoom-proj-worker.js   Web Worker — imports from algo+pipeline, computes projections

tests/pipeline_test.ts     48 Deno tests: algo unit, pipeline, numeric, undefined, E2E

data/                      5 SNAP-format graph datasets (.edges + .labels, Amazon .gz compressed)
agent_docs/                Architecture and spec documentation
scripts/
  serve.ts                 Deno HTTP server (docs/ + data/ at root, no-cache headers)
  stix2snap.ts             STIX 2.1 JSON → SNAP (extracts platforms, kill chains, aliases)
  csv2snap.ts              OpenCTI CSV → SNAP (Jaccard co-reference container graph)
  src2snap.ts              Source code → SNAP call graph (files, functions, methods, calls)
deno.json                  Tasks: serve, test, stix2snap, csv2snap, src2snap
```

## Module System

All JS files use **ES modules** (`import`/`export`). Web Workers use `{ type: 'module' }`. Viewer loads `<script type="module" src="bitzoom-viewer.js">`.

Dependency graph:
```
bitzoom-algo.js              (no deps — pure functions + constants)
  ↑
bitzoom-pipeline.js          (imports from algo)
  ↑             ↑
bitzoom-canvas.js            (imports from algo + renderer)
  ↑             ↑
bitzoom-viewer.js  bitzoom-worker.js → bitzoom-proj-worker.js
  (composes                            ↑
   BitZoomCanvas)            (imports from algo + pipeline)
  ↑
bitzoom-renderer.js
  (imports from algo)
```

No code duplication. GC-optimized MinHash variants (`computeMinHashInto`, `_sig`, `projectInto`, typed-array `HASH_PARAMS_A/B`) live once in [bitzoom-algo.js](../docs/bitzoom-algo.js). `BitZoom` composes `BitZoomCanvas` (`this.view`) — all graph state, rendering, and interaction primitives live on the canvas component.

## Data Format (SNAP)

**`.edges`** (required): tab-delimited, `#` comment lines.
- 2-column: `FromNodeId\tToNodeId`
- 3-column: `FromNodeId\tToNodeId\tEdgeType`

**`.labels`** (optional): tab-delimited.
- Header: `# NodeId\tLabel\tGroup[\tExtraProp1\tExtraProp2...]`
- Extra columns become additional MinHash property groups.
- **Numeric columns**: auto-detected (>=80% of non-empty values parseable). Tokenized at 3 resolution levels (coarse: 5 bins, medium: 50, fine: 500) for smooth Jaccard similarity.
- **Undefined values**: empty field between tabs → 0 tokens emitted → neutral `[0,0]` projection. No false clustering.

## Module Responsibilities

### [bitzoom-algo.js](../docs/bitzoom-algo.js) (471 lines)

Pure functions, no DOM. Single source of truth for MinHash/projection.

- **Constants**: `MINHASH_K=128`, `GRID_BITS=16`, `GRID_SIZE=65536`, `ZOOM_LEVELS[1..14]`, `RAW_LEVEL=14`, `LEVEL_LABELS`
- **MinHash** (GC-optimized): `HASH_PARAMS_A/B` (Int32Array), `computeMinHashInto` → reusable `_sig` Float64Array (NaN sentinel for empty tokens), `computeMinHash` (allocating wrapper). Universal hash via Mersenne fast-mod (`hashSlot` + `mersMod`) — split 16-bit halves to stay within safe integer range.
- **Projection** (GC-optimized): `projectInto(sig, ROT, buf, offset)` → writes to buffer, `projectWith` (convenience wrapper returning `[px, py]`). NaN sentinel check: `sig[0] !== sig[0]`.
- **Blend**: `unifiedBlend(nodes, groupNames, propWeights, smoothAlpha, adjList, nodeIndexFull, passes, quantMode, quantStats)`
- **Quantization**: `normalizeAndQuantize(nodes)` (rank-based, O(n log n)), `gaussianQuantize(nodes, stats)` (Φ(z) via precomputed lookup table, O(n)). Default: Gaussian. Reasonable fit when blended coordinates are roughly bell-shaped; an approximation, not a guarantee.
- **Grid**: `cellIdAtLevel(gx, gy, level)`
- **Level building**: `buildLevelNodes` (phase 1: bucket nodes into supernodes, O(n)) + `buildLevelEdges` (phase 2: aggregate edges, O(|E|), numeric key packing for levels 1-13, string keys for level 14) + `buildLevel` (combined wrapper). Caches `cachedColor`/`cachedLabel` on supernodes.
- **Helpers**: `maxCountKey` (O(k) max), `generateGroupColors` (golden-angle HSL → hex), `getNodePropValue`, `getSupernodeDominantValue`

### [bitzoom-pipeline.js](../docs/bitzoom-pipeline.js) (348 lines)

Shared parsing, graph building, tokenization. Imports from algo. No DOM.

- **Parsers**: `parseEdgesFile` (streaming line-by-line, flat arrays), `parseLabelsFile` (header detection, extra columns, preserves empty tabs)
- **Graph building**: `buildGraph` — nodes, edges, adjacency, neighbor groups, numeric column auto-detection (`numericBins`)
- **Tokenization**: `degreeBucket`, `tokenizeLabel` (inline word scanner), `tokenizeNumeric` (3-level for numeric, categorical fallback, 0 tokens for empty/undefined)
- **Signature**: `computeNodeSig(node)` — on-demand signature computation (signatures not stored on nodes)
- **Full pipeline**: `computeProjections` (GC-optimized), `runPipeline(edgesText, labelsText)` (parse → build → project)

### [bitzoom-renderer.js](../docs/bitzoom-renderer.js) (937 lines)

Canvas rendering. Reads BitZoom instance, no state mutation (except `n.x`/`n.y` in layout).

**GC caches**: `_rgbCache`, `_fontCache`, `_rgbaCache`, persistent density heatmap buffers.

**5-layer render order**:
1. Normal edges (sampled, distance-faded, behind heatmap)
2. Heatmap (splat or density)
3. Highlighted edges (selected/hovered, on top of heatmap)
4. Node circles (opacity-scaled by importance)
5. Labels/counts (topmost, never occluded)

**Adaptive rendering** (based on visible supernode count):
- <=50 visible: all counts, all labels (if cellPx >= 20)
- 51-100: all counts, labels on large nodes (importance > 0.7, cellPx >= 20)
- 101-150: counts on large (importance > 0.7), labels on large (importance > 0.7, cellPx >= 20)
- 151-200: counts on large (importance > 0.7), labels hover/select only
- 200+: all hover/select only. Node opacity scales with `0.3 + 0.7 * sqrt(size/maxSize)` when >50 visible.

**Edge sampling**: `maxEdgesToDraw = min(5000, max(200, nodeCount × 3))`. Short-edge bias in probabilistic sampling.

**Other**: cubic bezier edges, Gaussian splat heatmap (additive), KDE density heatmap (1/4 resolution, persistent buffers), hit testing.

### [bitzoom-canvas.js](../docs/bitzoom-canvas.js) (778 lines)

Standalone embeddable canvas component. No external DOM dependencies beyond a `<canvas>` element.

**`BitZoomCanvas`**: holds all graph state (nodes, edges, adjList, groupNames, propWeights, propColors), view state (zoom, pan, level, selection), property caching, level building, rendering delegates. Constructor accepts `skipEvents` (for composition), `onRender` callback, `showLegend`, and `showResetBtn` options.

**`createBitZoomView(canvas, edgesText, labelsText, opts)`**: convenience factory — parses SNAP data, hydrates nodes, blends, returns ready-to-use canvas view.

**Public API**: `setWeights()`, `setAlpha()`, `setOptions()`, `destroy()`. Callbacks: `onSelect`, `onHover`.

### [bitzoom-viewer.js](../docs/bitzoom-viewer.js) (1336 lines)

`BitZoom` class — composes `BitZoomCanvas` as `this.view`. Adds application UI and orchestration.

**Composition**: all graph/view state accessed via `this.view.*`. BitZoom owns app-only state (dataLoaded, presets, workers, hash timers, mouse state).

**Navigation**: `switchLevel` (delegates to view + UI updates, animates supernodes when both old and new levels have <80 nodes), `_checkAutoLevel` (delegates to view, adds stepper/info updates), `zoomToNode` (animated 350ms with reselection after level change), `_animateZoom` (shift+dblclick zoom-out).

**Multi-select**: Ctrl+click toggles `view.selectedIds`. Edges highlight for all selected nodes.

**Data loading**: module workers with transferable Float64Array. `DATASETS[]` presets. Hash state restore on load.

**URL hash**: `d=name&l=level&z=zoom&x=pan&y=pan&bl=base&s=selected`. Updates via `replaceState` on each render (via `onRender` callback).

**UI**: dynamic weight sliders, preset buttons, label checkboxes, size-by toggle (members/edges), quantization mode toggle (gaussian/rank), heatmap mode cycle (off/splat/density), edge mode cycle (curves/lines/none), detail panel (slide-in overlay with grouped linked nodes), single-click delayed 250ms for dblclick disambiguation.

### Workers (142 + 95 lines)

**[bitzoom-worker.js](../docs/bitzoom-worker.js)**: coordinator. Imports parsers from pipeline. Fans out to up to 3 sub-workers. Merges Float64Array chunks. Passes `numericBins` for numeric tokenization.

**[bitzoom-proj-worker.js](../docs/bitzoom-proj-worker.js)**: imports from algo + pipeline — zero duplicated code. Receives node slice + neighbor groups, computes all projections.

## Key Data Flow

```
SNAP files (.edges, .labels)
  → bitzoom-worker.js: parse (streaming), build graph, detect numeric columns
    → bitzoom-proj-worker.js (×3): tokenize → MinHash → project → Float64Array
  → main thread: unpack → hydrate → unifiedBlend → quantize → render

Weight/alpha change:
  → _refreshPropCache → invalidate levels → unifiedBlend → layoutAll → render

Zoom/pan:
  → render (levels cached, just transform + draw)

Level change (auto or manual):
  → adjusts zoom to preserve renderZoom → lazy getLevel → buildLevelNodes → layoutAll → render
    (buildLevelEdges runs async after initial render)
```

## Key Invariants

- Per-node projections computed once at load, never change.
- Weight changes trigger blend + quantize only — no re-projection.
- Bit-prefix containment: level L cell is always a sub-cell of level L-1.
- Supernode `cachedColor`/`cachedLabel` set at `buildLevel` time, not per frame.
- Level cache invalidated when weights, labels, or topology alpha change.
- `renderZoom` compensates for level offset — visual scale never jumps.
- `switchLevel` adjusts logical zoom so renderZoom stays constant.
- Renderer never mutates BitZoom state (except `n.x`/`n.y` in `layoutAll`).
- `getLevel()` calls `layoutAll()` after building a new level.
- Empty/undefined property values emit 0 tokens — no false clustering.
- Numeric columns tokenized at 3 resolution levels for smooth similarity.

## Design Decisions & Rationale

### Per-group projections (why not a single MinHash?)

An early design used a single MinHash with token multiplicity for weights. Changing weight from 3→4 caused 98% of nodes to change their L4 cell — catastrophic reorganization. MinHash is not smooth in token counts.

**Fix**: independent MinHash per property group, each projected to 2D. Final position is a weighted linear combination of fixed vectors. Weight changes produce smooth proportional movement. No rehashing. O(n) per change.

### Unified blend (property + topology in one formula)

```
px_i = (1 − α) · (Σ_g w_g · p_g(i) / W)  +  α · avg_{j∈N(i)}(px_j)
```

Equivalent to one layer of a degree-normalized GCN (Kipf & Welling 2017). Known failure: oversmoothing at high α.

### Neighborhood tokens removed

Early design included 1-hop and 2-hop neighbor tokens in MinHash. These became redundant with topology smoothing (α parameter). Removing them made the signals orthogonal: α=0 = pure property, α→1 = topology.

### Multi-resolution numeric tokenization

Numeric values emit 3 tokens (coarse/medium/fine bins). Nearby values share coarse tokens → smooth Jaccard. Non-numeric falls back to categorical. Empty values emit nothing.

## Known Limitations

- Jaccard on discretised tokens is crude for continuous/ordinal properties.
- 2D projection doesn't preserve distances — provides ordering signal, not metric embedding.
- Rank quantization (when selected) destroys density information; Gaussian quantization tends to preserve it better but assumes approximately normal marginals.
- Gaussian quantization uses fixed boundaries (μ,σ frozen from dataset-tuned weights, reset in `_applyDatasetSettings`) — subsequent weight changes can shift the distribution far from stored boundaries, pushing nodes to grid extremes.
- Undefined values with high weight cause degenerate clustering. Empty fields → neutral [0,0] projection. When that group dominates, all undefined nodes collapse to one pre-quantization point. Rank quantization spreads axes independently but preserves 2D correlation → edge pile-up. Simple axis-wise quantization cannot remove the 2D correlation.
- Supernode centroids use post-quantization display coordinates, not the original continuous blended coordinates. The nonlinear quantization transform (rank or Φ) means centroids in quantized space differ from centroids in blended space. The discrepancy is typically small at fine zoom levels and can be more noticeable at coarse levels (L1-L3).
- Weight stability is piecewise constant after quantization.
- Oversmoothing at high α with many passes.
- Layout quality depends entirely on tokenisation quality.

## What Is Novel

Individual components (MinHash, random projection, hierarchical grids, graph smoothing) are known. The contribution is the combination:

1. Per-group projected anchors — fixed, reusable across weight configurations
2. Interactive linear reweighting — smooth, proportional, no recomputation
3. Unified blend — property weights and topology in one normalization
4. Exact bit-prefix zoom hierarchy — all levels from two stored uint16 coordinates
5. Multi-resolution numeric tokenization — smooth similarity for continuous properties
6. Gaussian quantization as default — reasonable CDF fit for roughly bell-shaped blended coordinates
7. Adaptive density rendering — visibility thresholds based on visible node count

## Test Coverage (48 tests)

**Algo** (13): hashToken, computeMinHash/Into, computeMinHash with tokenCount, jaccardEstimate, buildGaussianProjection(seed, cols), projectWith/Into, cellIdAtLevel, maxCountKey, generateGroupColors, MinHash Jaccard convergence.

**Pipeline** (18): parsers (2-col, 3-col, comments, headers, trailing empties), buildGraph, degreeBucket, tokenizeLabel (words, fallback, offset), computeProjections, runPipeline, normalizeAndQuantize, buildLevelNodes, buildLevelEdges.

**Numeric** (9): multi-resolution tokens, nearby/distant sharing, categorical fallback, Jaccard smoothness, detection threshold.

**Undefined** (6): empty/null emit 0 tokens, neutral projection, no false clustering, parser preservation, numeric detection ignoring empties.

**E2E** (2): Epstein full pipeline + multi-level + bit-prefix verification. Topology alpha comparison.
