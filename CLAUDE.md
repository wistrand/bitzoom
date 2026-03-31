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
  bitzoom-algo.js          Pure algorithm functions and constants (495 lines)
  bitzoom-pipeline.js      Parsers, graph building, tokenization, projection (369 lines)
  bitzoom-renderer.js      Canvas 2D rendering, heatmaps, hit testing, FPS counter (1108 lines)
  bitzoom-gl-renderer.js   WebGL2 rendering — shaders, instanced draw, GPU heatmap (1235 lines)
  bitzoom-canvas.js        Standalone embeddable component — canvas, interaction, rendering (1072 lines)
  bitzoom-viewer.js        BitZoom app (composes BitZoomCanvas) — UI, workers, data loading (1806 lines)
  bitzoom-utils.js         Auto-tune optimizer (277 lines)
  bitzoom-svg.js           SVG export — exportSVG(bz, opts), createSVGView() for headless (601 lines)
  bitzoom-colors.js        Color schemes (vivid, viridis, plasma, etc.)
  bitzoom-gpu.js           WebGPU compute acceleration (671 lines)
  bitzoom-worker.js        Web Worker coordinator (142 lines)
  bitzoom-proj-worker.js   Web Worker projection (95 lines)
  bz-graph.js              <bz-graph> web component
  bitzoom.js               Public API entrypoint (re-exports createBitZoomView, exportSVG, createSVGView, autoTuneWeights, etc.)
  webgl-test.html          Side-by-side Canvas 2D vs WebGL2 comparison page (246 lines)

docs/dist/                 Bundled distribution
  bitzoom.bundle.js        Minified single-file bundle (~98KB, gzipped). Build: `deno task bundle`

docs/data/                 9 SNAP-format datasets (.edges + .nodes, Amazon .gz compressed)
benchmarks/                Layout comparison suite (export, compare, Docker runner)
tests/pipeline_test.ts     68 tests: unit, numeric, undefined values, E2E, SVG export
scripts/
  serve.ts                 Deno HTTP server (no-cache headers)
  stix2snap.ts             STIX 2.1 → SNAP converter (extracts platforms, kill chains)
  csv2snap.ts              OpenCTI CSV → SNAP converter (Jaccard co-reference edges)
  src2snap.ts              Source code → SNAP call graph (functions, methods, calls)
```

## Data Format (SNAP)

- `.edges` (required): tab-delimited, `#` comments. `From\tTo` or `From\tTo\tEdgeType`.
- `.nodes` (optional): tab-delimited. `# NodeId\tLabel\tGroup[\tExtra1\tExtra2...]`.
  - Extra columns become MinHash property groups.
  - Numeric columns auto-detected (>=80% parseable) → 3-level tokenization (coarse/medium/fine).
  - Empty fields = undefined → 0 tokens, neutral projection, no false clustering.

## Datasets

| Name             | Nodes | Edges  | Properties                            |
| ---------------- | ----- | ------ | ------------------------------------- |
| Karate Club      | 34    | 78     | group                                 |
| Epstein          | 364   | 534    | group, edge types                     |
| BitZoom Source   | 433   | 940    | kind, file, lines, bytes, age         |
| Synth Packages   | 1,868 | 4,044  | downloads, license, version, depcount |
| MITRE ATT&CK    | 4,736 | 25,856 | kill chain, platforms, aliases         |
| Email EU         | 1,005 | 25,571 | (edge-only)                           |
| Facebook         | 4,039 | 88,234 | (edge-only)                           |
| Power Grid       | 4,941 | 6,594  | (edge-only)                           |
| Amazon           | 367K  | 988K   | product category                      |

## Key Design Decisions

- **ES modules** — `import`/`export` everywhere. Module workers. `<script type="module">` in each HTML page.
- **No code duplication** — GC-optimized MinHash/projection (`computeMinHashInto`, `_sig`, `projectInto`, typed-array `HASH_PARAMS_A/B`) in [bitzoom-algo.js](docs/bitzoom-algo.js), imported by pipeline and workers.
- **Composition** — `BitZoom` owns a `BitZoomCanvas` (`this.view`) for all graph state, rendering, and interaction primitives. `BitZoom` adds UI, workers, data loading, detail panel, URL hash state. `BitZoomCanvas` is standalone (no DOM beyond `<canvas>`), with `createBitZoomView()` factory and `skipEvents`/`onRender`/`autoTune`/`autoGPU`/`webgl`/`colorBy` options for embedding.
- **colorBy** — `BitZoomCanvas.colorBy` property overrides which property group controls node colors (default: auto = highest-weight group). In the viewer, click a group name label to set colorBy (underline indicates active); click again to return to auto. `<bz-graph>` supports `color-by` attribute.
- **SVG export** — `exportSVG(bz, opts)` in [bitzoom-svg.js](docs/bitzoom-svg.js) renders the current graph view as an SVG string. `createSVGView(nodes, edges, opts)` builds a headless view from plain pipeline data (no DOM needed). In the viewer, press **S** to download an SVG file.
- **WebGL2 rendering** — optional GPU-accelerated layer for grid, edges, heatmap, and circles via 7 shader programs in [bitzoom-gl-renderer.js](docs/bitzoom-gl-renderer.js). Text stays on Canvas 2D overlay. Dual canvas architecture: wrapper div with GL canvas behind, original canvas transparent on top. Toggle via `webgl: true` option or GL button in viewer toolbar. Falls back silently if WebGL2 unavailable (`isWebGL2Available()` probe).
- **Auto-tune** — `autoTuneWeights` in [bitzoom-utils.js](docs/bitzoom-utils.js) optimizes weights/alpha/quant by maximizing spread × clumpiness at L5. Async with yield-based progress. Supports `AbortSignal` and timeout. Accepts `blendFn` option (defaults to CPU `unifiedBlend`). Viewer has "Auto" button; embedded views accept `autoTune` option.
- **Web Workers** — coordinator fans out to up to 3 projection sub-workers. Transferable Float64Array buffers.
- **Supernode color/label cached at build time** — not recomputed per frame. `_refreshPropCache()` invalidates level cache.
- **Two-zoom system** — logical zoom triggers level changes; `renderZoom = max(1, zoom * 2^levelOffset)` keeps visual scale continuous.
- **Multi-select** — Ctrl+click toggles; `selectedIds` Set; edges highlight for all selected.
- **Adaptive rendering** — edge sampling scales with visible nodes; labels/counts hide at high density, appear on zoom-in; node opacity scales with importance.
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


## Code Style

2-space indent, single quotes, semicolons, 100 char width.


## Documentation Style

- **Use markdown links** for file references: `[doc.md](path/to/doc.md)` not `` `path/to/doc.md` ``
- **Align table columns** by padding cells to consistent widths
