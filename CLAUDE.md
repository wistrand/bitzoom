# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BitZoom is a deterministic layout and hierarchical aggregation viewer for large property graphs. Nodes are positioned by property similarity (MinHash + Gaussian projection), with stable zoom levels derived from uint16 grid coordinates via bit shifts.

- [`agent_docs/SPEC.md`](agent_docs/SPEC.md) — algorithm theory, tradeoffs, complexity analysis
- [`agent_docs/ARCHITECTURE.md`](agent_docs/ARCHITECTURE.md) — implementation details, module responsibilities, data flow, caching, design rationale

## Running

```sh
deno task serve       # dev server at http://localhost:8000
deno task test        # run pipeline tests (48 tests)
deno task stix2snap   # STIX 2.1 JSON → SNAP converter
deno task csv2snap    # OpenCTI CSV → SNAP converter
deno task src2snap    # source code → SNAP call graph
```

## File Structure

```
htdocs/                    Web app (ES modules, no build step)
  index.html               Landing page (265 lines)
  viewer.html              Viewer HTML shell (105 lines)
  about.html               How It Works page (1478 lines)
  howto.html               Developer Guide (513 lines)
  bitzoom.css              Styles (646 lines)
  bitzoom-algo.js          Pure algorithm functions and constants (471 lines)
  bitzoom-pipeline.js      Parsers, graph building, tokenization, projection (348 lines)
  bitzoom-renderer.js      Canvas rendering, heatmaps, hit testing (937 lines)
  bitzoom-canvas.js        Standalone embeddable component — canvas, interaction, rendering (778 lines)
  bitzoom-viewer.js        BitZoom app (composes BitZoomCanvas) — UI, workers, data loading (1336 lines)
  bitzoom-worker.js        Web Worker coordinator (142 lines)
  bitzoom-proj-worker.js   Web Worker projection (95 lines)

data/                      5 SNAP-format datasets (.edges + .labels, Amazon .gz compressed)
tests/pipeline_test.ts     48 tests: unit, numeric, undefined values, E2E
scripts/
  serve.ts                 Deno HTTP server (no-cache headers)
  stix2snap.ts             STIX 2.1 → SNAP converter (extracts platforms, kill chains)
  csv2snap.ts              OpenCTI CSV → SNAP converter (Jaccard co-reference edges)
  src2snap.ts              Source code → SNAP call graph (functions, methods, calls)
```

## Data Format (SNAP)

- `.edges` (required): tab-delimited, `#` comments. `From\tTo` or `From\tTo\tEdgeType`.
- `.labels` (optional): tab-delimited. `# NodeId\tLabel\tGroup[\tExtra1\tExtra2...]`.
  - Extra columns become MinHash property groups.
  - Numeric columns auto-detected (>=80% parseable) → 3-level tokenization (coarse/medium/fine).
  - Empty fields = undefined → 0 tokens, neutral projection, no false clustering.

## Datasets

| Name             | Nodes | Edges  | Properties                            |
| ---------------- | ----- | ------ | ------------------------------------- |
| Epstein          | 514   | 534    | group, edge types                     |
| BitZoom Source   | 403   | 971    | kind, file, lines, bytes, age         |
| Synth Packages   | 2,000 | 4,050  | downloads, license, version, depcount |
| MITRE ATT&CK    | 4,736 | 25,856 | kill chain, platforms, aliases         |
| Amazon           | 367K  | 988K   | product category                      |

## Key Design Decisions

- **ES modules** — `import`/`export` everywhere. Module workers. `<script type="module">` in each HTML page.
- **No code duplication** — GC-optimized MinHash/projection (`computeMinHashInto`, `_sig`, `projectInto`, typed-array `HASH_PARAMS_A/B`) in [bitzoom-algo.js](htdocs/bitzoom-algo.js), imported by pipeline and workers.
- **Composition** — `BitZoom` owns a `BitZoomCanvas` (`this.view`) for all graph state, rendering, and interaction primitives. `BitZoom` adds UI, workers, data loading, detail panel, URL hash state. `BitZoomCanvas` is standalone (no DOM beyond `<canvas>`), with `createBitZoomView()` factory and `skipEvents`/`onRender` options for embedding.
- **Web Workers** — coordinator fans out to up to 3 projection sub-workers. Transferable Float64Array buffers.
- **Supernode color/label cached at build time** — not recomputed per frame. `_refreshPropCache()` invalidates level cache.
- **Two-zoom system** — logical zoom triggers level changes; `renderZoom = max(1, zoom * 2^levelOffset)` keeps visual scale continuous.
- **Multi-select** — Ctrl+click toggles; `selectedIds` Set; edges highlight for all selected.
- **Adaptive rendering** — edge sampling scales with visible nodes; labels/counts hide at high density, appear on zoom-in; node opacity scales with importance.
- **5-layer render order** — edges → heatmap → highlighted edges → circles → labels.
- **URL hash state** — dataset + zoom + pan + level + selection. `replaceState` on render.

## Important Invariants

- Per-node projections computed once at load, never change.
- Weight changes trigger blend + quantize only (no re-projection).
- Bit-prefix containment: level L cell is always a sub-cell of level L-1.
- Renderer never mutates BitZoom state (except `n.x`/`n.y` in layoutAll).
- `_refreshPropCache()` must be called when weights or label selection change.
- `getLevel()` calls `layoutAll()` when building a new level.
- `switchLevel()` adjusts zoom to preserve renderZoom across level changes.
- Empty/undefined property values emit 0 tokens → NaN sentinel → neutral [0,0] projection. No false clustering at low weight, but degenerate clustering when that group dominates (all undefined nodes share the same projection point).
- Gaussian quantization boundaries (μ,σ) freeze from the dataset-tuned weight snapshot (reset in `_applyDatasetSettings`) — stable across subsequent weight/alpha changes but can misfit if the distribution shifts significantly.
- Heatmap density maxW is cached per level/zoom config, lerped on change — stable across pan.


## Code Style

2-space indent, single quotes, semicolons, 100 char width.


## Documentation Style

- **Use markdown links** for file references: `[doc.md](path/to/doc.md)` not `` `path/to/doc.md` ``
- **Align table columns** by padding cells to consistent widths
