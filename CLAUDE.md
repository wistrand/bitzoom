# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BitZoom is a deterministic layout and hierarchical aggregation viewer for large property graphs. Nodes are positioned by property similarity (MinHash + Gaussian projection), with stable zoom levels derived from uint16 grid coordinates via bit shifts.

- [`agent_docs/SPEC.md`](agent_docs/SPEC.md) — algorithm theory, tradeoffs, complexity analysis
- [`agent_docs/ARCHITECTURE.md`](agent_docs/ARCHITECTURE.md) — implementation details, module responsibilities, data flow, caching, design rationale
- [`agent_docs/ARCHITECTURE-webgl.md`](agent_docs/ARCHITECTURE-webgl.md) — WebGL2 rendering layer: shaders, dual canvas, GPU tessellation
- [`agent_docs/ARCHITECTURE-webgpu.md`](agent_docs/ARCHITECTURE-webgpu.md) — WebGPU compute: projection, blend, adaptive GPU/CPU selection
- [`agent_docs/ARCHITECTURE-svg.md`](agent_docs/ARCHITECTURE-svg.md) — SVG export: density contours, edge rendering, coordinate mapping

## Running

```sh
deno task serve       # dev server at http://localhost:8000
deno task test        # run pipeline tests (68 tests)
deno task stix2snap   # STIX 2.1 JSON → SNAP converter
deno task csv2snap    # OpenCTI CSV → SNAP converter
deno task src2snap    # source code → SNAP call graph
```

## File Structure

```
docs/                    Web app (ES modules, no build step)
  index.html               Landing page (308 lines)
  viewer.html              Viewer HTML shell (109 lines)
  about.html               How It Works page (1562 lines)
  howto.html               Developer Guide (932 lines)
  example.html             Minimal example — two graphs, linked from developer guide (53 lines)
  bitzoom.css              Styles (673 lines)
  bitzoom-algo.js          Pure algorithm functions and constants (~520 lines)
  bitzoom-pipeline.js      SNAP parsers, buildGraph, runPipeline(GPU), runPipelineFromObjects(GPU) (455 lines)
  bitzoom-parsers.js       Format adapters — CSV, D3 JSON, JGF, GraphML, GEXF, Cytoscape; parseAny dispatcher (965 lines)
  stix2snap.js             STIX 2.1 bundle parser (parseSTIX, browser-compatible)
  bitzoom-renderer.js      Canvas 2D rendering, heatmaps, hit testing, FPS counter (1108 lines)
  bitzoom-gl-renderer.js   WebGL2 rendering — shaders, instanced draw, GPU heatmap (1235 lines)
  bitzoom-canvas.js        Standalone embeddable component — canvas, interaction, rendering, all event handling (1688 lines)
  bitzoom-viewer.js        BitZoom app (composes BitZoomCanvas) — UI, workers, data loading, drop zones, auto-tune-on-load (2055 lines)
  bitzoom-utils.js         Auto-tune optimizer — portable async, memoization, refinement phase (469 lines)
  bitzoom-svg.js           SVG export — exportSVG(bz, opts), createSVGView() for headless (601 lines)
  bitzoom-colors.js        Color schemes (vivid, viridis, plasma, etc.)
  bitzoom-gpu.js           WebGPU compute acceleration (671 lines)
  bitzoom-worker.js        Web Worker coordinator (142 lines)
  bitzoom-proj-worker.js   Web Worker projection (95 lines)
  bz-graph.js              <bz-graph> web component
  bitzoom.js               Public API entrypoint (re-exports createBitZoomView, exportSVG, createSVGView, autoTuneWeights, parseAny, etc.)
  webgl-test.html          Side-by-side Canvas 2D vs WebGL2 comparison page (246 lines)

docs/dist/                 Bundled distribution
  bitzoom.bundle.js        Minified single-file bundle (~98KB, gzipped). Build: `deno task bundle`

docs/data/                 SNAP datasets + D3/JGF/GEXF/GraphML/Cytoscape/CSV samples, STIX bundles (.gz where large)
benchmarks/                Layout comparison suite (export, compare, Docker runner)
tests/pipeline_test.ts     172 tests: algo unit, pipeline, numeric, undefined, E2E, SVG, parsers, format dispatch
scripts/
  serve.ts                 Deno HTTP server (no-cache headers)
  stix2snap.ts             STIX 2.1 → SNAP converter (extracts platforms, kill chains)
  csv2snap.ts              OpenCTI CSV → SNAP converter (Jaccard co-reference edges)
  src2snap.ts              Source code → SNAP call graph (functions, methods, calls)
```

## Data Formats

BitZoom accepts multiple input formats through a unified detection/dispatch layer. See [agent_docs/ARCHITECTURE-data-import.md](agent_docs/ARCHITECTURE-data-import.md) for the full architecture.

**SNAP text** (two-file, worker pipeline):
- `.edges` (optional since nodes-only-SNAP support): tab-delimited, `#` comments. `From\tTo` or `From\tTo\tEdgeType`.
- `.nodes` (optional): tab-delimited. `# NodeId\tLabel\tGroup[\tExtra1\tExtra2...]`.
  - Extra columns become MinHash property groups.
  - Numeric columns auto-detected (>=80% parseable) → 3-level tokenization (coarse/medium/fine).
  - Empty fields = undefined → 0 tokens, neutral projection, no false clustering.

**Object pipeline** (single-file, main-thread via `runPipelineFromObjects`):
- **CSV / TSV / SSV** — header sniffing maps columns to id/label/group roles; everything else becomes extras. Handles quoted fields, escaped quotes, CRLF, BOM, auto-detects `,` / `\t` / `;` / `|`.
- **D3 force JSON** (`{nodes, links}`) — flat node bag; falls back to `name` as id (Miserables convention); resolves numeric link endpoints as both string-id matches and array indices.
- **JGF** (`{graph: {nodes, edges}}`) — single-graph or multi-graph; accepts nodes as array OR dict keyed by id (JGF v1).
- **GraphML / GEXF** — hand-rolled XML subset parser, two-pass with key/attribute registry resolution.
- **Cytoscape.js JSON** — grouped form `{elements: {nodes, edges}}` and flat-array form `{elements: [{group, data}]}`.
- **STIX 2.1 bundle** — inlined into the object pipeline via `parseSTIX` (was previously a separate flow).

Drop any of these files onto the canvas or loader panel, or load them via URL — `detectFormat` sniffs from content + filename, `parseAny` dispatches.

## Datasets

**SNAP pairs** (curated with presets in `datasets.json`):

| Name             | Nodes | Edges  | Properties                            |
| ---------------- | ----- | ------ | ------------------------------------- |
| Karate Club      | 34    | 78     | group                                 |
| Epstein          | 364   | 534    | group, edge types                     |
| BitZoom Source   | 433   | 940    | kind, file, lines, bytes, age         |
| Marvel Comics    | 327   | —      | alignment, gender, alive, eye, hair   |
| Porsche          | 297   | —      | body, drivetrain, weight, generation  |
| Pokemon          | 959   | —      | type1, type2, generation, stats       |
| Vadonland        | 512   | —      | government, type, biome, religion     |
| Synth Packages   | 2,000 | 4,044  | downloads, license, version, depcount |
| MITRE ATT&CK     | 4,736 | 25,856 | kill chain, platforms, aliases        |
| Ransomware       | 27K   | —      | group, year, raas, victims, sector    |
| Email EU         | 1,005 | 25,571 | (edge-only)                           |
| Facebook         | 4,039 | 88,234 | (edge-only)                           |
| Power Grid       | 4,941 | 6,594  | (edge-only)                           |
| Amazon           | 367K  | 988K   | product category                      |

**Object-pipeline samples**:

| File                      | Format     | Nodes | Notes                                 |
| ------------------------- | ---------- | ----- | ------------------------------------- |
| miserables.json           | D3 JSON    | 77    | Canonical Mike Bostock D3 example     |
| miserables.jgf.json       | JGF v1     | 77    | Dict-form `graph.nodes`               |
| miserables.gexf           | GEXF       | 74    | Gender attribute                      |
| miserables.cyjs.json      | Cytoscape  | 77    | Grouped form                          |
| karate.graphml            | GraphML    | 34    | Faction attribute                     |
| graphml-sample.xml        | GraphML    | 6     | Prefuse canonical example             |
| penguins.csv              | CSV        | 344   | Palmer Penguins with species/sex      |
| ics-attack.json.gz        | STIX 2.1   | 464   | MITRE ATT&CK for ICS                  |
| mobile-attack.json.gz     | STIX 2.1   | 738   | MITRE ATT&CK for Mobile               |

## Key Design Decisions

- **ES modules** — `import`/`export` everywhere. Module workers. `<script type="module">` in each HTML page.
- **No code duplication** — GC-optimized MinHash/projection (`computeMinHashInto`, `_sig`, `projectInto`, typed-array `HASH_PARAMS_A/B`) in [bitzoom-algo.js](docs/bitzoom-algo.js), imported by pipeline and workers.
- **Composition** — `BitZoom` owns a `BitZoomCanvas` (`this.view`) for all graph state, rendering, and interaction primitives. `BitZoom` adds UI, workers, data loading, detail panel, URL hash state. `BitZoomCanvas` is standalone (no DOM beyond `<canvas>`), with `createBitZoomView()` factory and `onRender`/`autoTune`/`autoGPU`/`webgl`/`colorBy` options for embedding. Canvas always owns its event handlers; the viewer extends behavior via callbacks (`onSelect`, `onDeselect`, `onLevelChange`, `onZoomToHit`, `onSwitchLevel`, `onKeydown`) and options (`clickDelay`, `keyboardTarget`).
- **colorBy** — `BitZoomCanvas.colorBy` property overrides which property group controls node colors (default: auto = highest-weight group). In the viewer, click a group name label to set colorBy (underline indicates active); click again to return to auto. `<bz-graph>` supports `color-by` attribute.
- **SVG export** — `exportSVG(bz, opts)` in [bitzoom-svg.js](docs/bitzoom-svg.js) renders the current graph view as an SVG string. `createSVGView(nodes, edges, opts)` builds a headless view from plain pipeline data (no DOM needed). In the viewer, press **S** to download an SVG file.
- **WebGL2 rendering** — optional GPU-accelerated layer for grid, edges, heatmap, and circles via 7 shader programs in [bitzoom-gl-renderer.js](docs/bitzoom-gl-renderer.js). Text stays on Canvas 2D overlay. Dual canvas architecture: wrapper div with GL canvas behind, original canvas transparent on top. Toggle via `webgl: true` option or GL button in viewer toolbar. Falls back silently if WebGL2 unavailable (`isWebGL2Available()` probe).
- **Auto-tune** — `autoTuneWeights` in [bitzoom-utils.js](docs/bitzoom-utils.js) optimizes weights/alpha/quant by maximizing **spread × clumpiness × group-purity** at an adaptive grid level. Four phases: preset scan → coordinate descent (3 rounds) → local refinement (±deltas around best discrete point) → aesthetic fallback (force one categorical weight non-zero if descent zeros out everything). Async with portable yield (browser `requestAnimationFrame`, Deno/Node `setTimeout(0)` fallback). Memoized by `(weights, alpha)` tuple, trial blends use 2 topology passes (final blend uses 5). Module-level Float64Array buffers in `unifiedBlend` eliminate GC pressure across repeated calls. Supports `AbortSignal` and timeout. Viewer auto-runs on fresh loads without preset settings via `_autoTuneFresh()`; shared `_tuneAbort` controller means the Stop button works for both manual and auto-on-load runs. See [agent_docs/ARCHITECTURE-auto-tune.md](agent_docs/ARCHITECTURE-auto-tune.md).
- **Unified format import** — `parseAny(text, filenameHint?)` in [bitzoom-parsers.js](docs/bitzoom-parsers.js) detects format from content + filename and dispatches to CSV/D3/JGF/GraphML/GEXF/Cytoscape/STIX parsers. All return `{nodes: Map, edges: Array|null, extraPropNames: string[]}` consumable by `runPipelineFromObjects`. Viewer uses `isObjectFormat`/`FILE_ACCEPT_ATTR` exports — no hardcoded format lists in UI code. Nodes-only graphs (CSV without edges, `.nodes` file alone) produce valid property-only layouts. See [agent_docs/ARCHITECTURE-data-import.md](agent_docs/ARCHITECTURE-data-import.md).
- **Canvas drop zone** — files dropped onto the canvas (mid-session) immediately load via `parseAny` → `runPipelineFromObjects`. Two sequential SNAP drops (edges + nodes within 600ms) debounce and load as a pair; any non-SNAP drop replaces the current view immediately.
- **Determinism** — seeded Gaussian projection + bit-prefix quantization give same-input-same-pixels forever. Load-bearing for URL-hash state, bookmarks, and `replaceState`-based shared views. No force-directed relaxation, no randomized t-SNE/UMAP iterations.
- **Web Workers** — coordinator fans out to up to 3 projection sub-workers. Transferable Float64Array buffers.
- **Supernode color/label cached at build time** — not recomputed per frame. `_refreshPropCache()` invalidates level cache.
- **Two-zoom system** — logical zoom triggers level changes; `renderZoom = max(1, zoom * 2^levelOffset)` keeps visual scale continuous. Level crossfade overlay positioned at canvas `offsetTop`/`offsetLeft` (not `top:0;left:0`) to align in any layout.
- **Multi-select** — Ctrl+click toggles; `selectedIds` Set; edges highlight for all selected.
- **Adaptive rendering** — edge sampling scales with visible nodes; labels/counts hide at high density, appear on zoom-in; node opacity scales with importance. Label truncation length quantized to 4px `cellPx` steps to prevent jitter during smooth zoom.
- **Zoom target highlight** — during scroll-wheel zoom-in, the zoom target (`zoomTargetId`) gets the same highlight treatment as hovered nodes (full label, glow, full opacity). Target selection prefers `hitTest` (cursor over circle/label) with `_nearestItem` fallback. On level change, tracks the dominant member of the old supernode to the new level. Cleared on zoom-out.
- **5-layer render order** — edges → heatmap → highlighted edges → circles → labels. WebGL2 renders geometry layers (grid through circles); Canvas 2D overlay handles text (labels, legend, reset button).
- **GPU tri-state** — viewer GPU button cycles Auto → GPU → CPU. Auto (default) uses adaptive thresholds: GPU projection when N×G > 2000, GPU blend when N > 50K. GPU forces all operations to GPU; CPU forces all to CPU.
- **Async initial blend** — `createBitZoomView()` returns synchronously; initial blend kicks off async (GPU probe → blend → render). Callers get a ready view immediately; first render completes in background.
- **FPS counter** — toggle with F key or click top-left corner. Shows fps/ms/mode (CPU/GPU/Auto).
- **Mobile improvements** — `touch-action: none` on canvas prevents browser gestures, compact toolbar layout, hidden hint section on small screens.
- **Cancel button** — load screen shows a cancel button when data is already loaded, allowing return to the current view without reloading.
- **GL wrapper visibility** — viewer hides the GL wrapper div alongside the canvas when showing the loader screen, restores it on cancel or load completion.
- **URL hash state** — dataset + zoom + pan + level + selection. `replaceState` on render.

## Important Invariants

- Per-node projections computed once at load, never change.
- Weight changes trigger blend + quantize only (no re-projection).
- Bit-prefix containment: level L cell is always a sub-cell of level L-1.
- Renderer never mutates BitZoom state (except `n.x`/`n.y` in layoutAll).
- `_refreshPropCache()` must be called when weights or label selection change.
- `getLevel()` calls `layoutAll()` when building a new level.
- `switchLevel()` adjusts zoom to preserve renderZoom across level changes.
- Empty/undefined property values emit 0 tokens → NaN sentinel → neutral [0,0] projection. Adaptive weight floor (`WEIGHT_FLOOR_RATIO=0.10`, `WEIGHT_FLOOR_MIN=0.10`) ensures zero-weight high-entropy groups always contribute 10% spreading, preventing low-entropy collapse. No special all-zero case: the floor produces equal blend naturally with smooth weight transitions.
- Gaussian quantization boundaries (μ,σ) freeze from the dataset-tuned weight snapshot (reset in `_applyDatasetSettings`) — stable across subsequent weight/alpha changes but can misfit if the distribution shifts significantly.
- Heatmap density maxW is cached per level/zoom config, lerped on change — stable across pan.
- `unifiedBlend` uses module-level Float64Array buffers grown on demand. Not reentrant — safe because blend calls are sequential.
- Fresh-load state reset in `_applyWorkerResult`: pan, zoom, colorBy, nav state, selection, current dataset id all cleared. User preferences (color scheme, GPU mode, WebGL toggle, showFps/Legend, theme) preserved.
- Initial level picked by `pickInitialLevel` in `_finalizeLoad` AFTER `gx/gy` is populated by blend + quantize. Walks coarse→fine, returns first level with 25-400 distinct cells and ≥1 multi-member cell. Dataset preset `initialLevel` and URL hash `l=` still override.
- `buildGraph` unions ids from `parsed.nodeIds` AND `nodesMap.keys()` — nodes-only inputs and orphaned metadata rows are preserved (fixes pre-refactor silent drop).


## Code Style

2-space indent, single quotes, semicolons, 100 char width.


## Documentation Style

- **Use markdown links** for file references: `[doc.md](path/to/doc.md)` not `` `path/to/doc.md` ``
- **Align table columns** by padding cells to consistent widths
