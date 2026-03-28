# BitZoom

A deterministic layout and hierarchical aggregation viewer for large property graphs. Nodes are positioned by property similarity using MinHash signatures and Gaussian projection, with stable zoom levels derived from stored uint16 grid coordinates via bit shifts.

![Datasets](https://img.shields.io/badge/datasets-9-blue) ![Tests](https://img.shields.io/badge/tests-45%20passing-green)

<p align="center">
  <img src="htdocs/images/bitzoom-1.png" width="48%" alt="BitZoom density heatmap with clustered supernodes">
  <img src="htdocs/images/bitzoom-2.png" width="48%" alt="BitZoom zoomed in with node labels visible">
</p>
<p align="center"><em>Left: density heatmap showing property-based clusters. Right: zoomed in with individual node labels.</em></p>

## Key Ideas

- **Property-first layout** — nodes are positioned by what they are (properties), not who they're connected to (topology). Topology influence is a tunable parameter, not the primary organizing principle.
- **Near-linear preprocessing** — MinHash signatures + random projection, O(n) per node. No force-directed O(n²) computation.
- **Instant zoom** — all 14 aggregation levels derive from two stored uint16 coordinates per node via bit shifts. No recomputation on navigation.
- **Interactive weight tuning** — change property weights and see the layout respond in real-time. No rehashing, no reprojection — just a weighted blend of fixed 2D anchors.

## Quick Start

```sh
# Requires Deno (https://deno.land)
deno task serve
# Open http://localhost:8000
```

The viewer loads the default dataset and renders immediately. Use the dataset picker to switch between included datasets, or drop your own `.edges` and `.labels` files.

## Interaction

| Action | Effect |
|---|---|
| Scroll wheel | Zoom in/out (auto-switches aggregation level) |
| Drag | Pan |
| Click node | Select, show detail panel |
| Ctrl+Click | Multi-select |
| Double-click node | Animated zoom to node |
| Double-click empty | Zoom in at point |
| Shift+Double-click | Zoom out |
| Arrow Left/Right | Manual level change |
| +/- keys | Zoom in/out |
| H button | Cycle heatmap: off → splat → density |
| n/e buttons | Size by member count or edge count |
| Label dropdown | Override label source property |
| Weight sliders | Adjust property group influence |

## Data Format (SNAP)

### `.edges` (required)

Tab-delimited edge list. Lines starting with `#` are comments.

```
# My graph
# Nodes: 100 Edges: 250
A	B
B	C	FRIEND
C	D	COLLEAGUE
```

2 columns (undirected) or 3 columns (with edge type).

### `.labels` (optional)

Tab-delimited node properties. First comment line defines column names.

```
# NodeId	Label	Group	Score	Department
A	Alice	engineer	95	backend
B	Bob	designer	82	frontend
C	Carol	engineer		backend
D	Dave	manager	88
```

- Columns 1-3: NodeId, Label, Group (required structure)
- Additional columns become MinHash property groups
- Numeric columns auto-detected and tokenized at 3 resolution levels
- Empty fields = undefined (no false clustering)

## Included Datasets

| Dataset | Nodes | Edges | Source |
|---|---|---|---|
| Karate Club | 34 | 78 | Zachary 1977 |
| Epstein Network | 364 | 534 | Public records |
| Melker src | 304 | 1,433 | Source code imports |
| Synth Packages | 1,868 | 4,050 | Generated |
| Amazon Co-purchase | 367K | 988K | SNAP Stanford |
| CERT Polska STIX | 93 | 417 | STIX 2.1 threat intel |
| OpenCTI PAP | 106 | 2,879 | OpenCTI CSV export |
| BitZoom Source | 145 | 443 | This project's code |
| MITRE ATT&CK | 4,736 | 25,856 | MITRE ATT&CK v15 |

## Converters

Convert external formats to SNAP:

```sh
# STIX 2.1 JSON bundle → SNAP
deno task stix2snap input.json data/output-prefix

# OpenCTI CSV export → SNAP (container similarity graph)
deno task csv2snap input.csv data/output-prefix

# Source code → SNAP call graph
deno task src2snap data/output-prefix
```

## Algorithm

1. **Tokenize** node properties into sets per property group
2. **MinHash** (k=128) each token set into a fixed-length signature via universal hashing
3. **Project** each z-score normalized signature to 2D via a seeded Gaussian random matrix (one per group)
4. **Blend** the per-group 2D positions as a weighted combination + optional topology smoothing
5. **Quantize** blended positions to a uint16 grid (65536×65536) — Gaussian (default, density-preserving) or rank (uniform occupancy)
6. **Zoom** by bit-shifting grid coordinates: level L gives a 2^L × 2^L cell grid

Weight changes only repeat steps 4-5: O(n × G) for anchor recomputation plus O(passes × (n + |E|)) for topology smoothing when α > 0. Zoom is O(1) per node. Signatures are not stored — recomputed on demand for detail panel visualization. See [SPEC.md](agent_docs/SPEC.md) for the full algorithm design.

## Architecture

```
bitzoom-algo.js        Pure algorithms (MinHash, projection, blend, levels)
bitzoom-pipeline.js    Parsers, graph building, tokenization pipeline
bitzoom-renderer.js    Canvas rendering (5-layer: edges → heatmap → hilite → circles → labels)
bitzoom-canvas.js      Standalone embeddable component — canvas, interaction, rendering
bitzoom.js             Application class (composes BitZoomCanvas, UI, workers)
bitzoom-worker.js      Web Worker coordinator (parse, fan-out)
bitzoom-proj-worker.js Web Worker (MinHash projection, ×3 parallel)
```

All ES modules. No build step. No dependencies. See [ARCHITECTURE.md](agent_docs/ARCHITECTURE.md) for details.

## Testing

```sh
deno task test    # 45 tests, ~100ms
```

Covers: MinHash determinism, projection correctness, bit-prefix containment, numeric tokenization, undefined value handling, E2E with Epstein dataset.

## License

MIT
