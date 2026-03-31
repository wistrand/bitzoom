# SVG Export: Architecture and Implementation

Static SVG rendering of the current BitZoomCanvas state. Implemented in
[bitzoom-svg.js](../docs/bitzoom-svg.js). Produces a self-contained SVG string
that reproduces the canvas view — background, grid, edges, density heatmap,
circles, labels, and legend.

## Entry points

### exportSVG — render view to SVG

```javascript
import { exportSVG } from './bitzoom-svg.js';

const svg = exportSVG(bz, {
  background: true,   // dark/light background rect
  grid: true,         // coordinate grid lines
  edges: true,        // edge lines/curves
  heatmap: true,      // density contour bands (when heatmapMode === 'density')
  labels: true,       // node/supernode labels
  legend: true,       // color legend box
  metadata: 'extra',  // appended to SVG comment header
});
```

`bz` is a `BitZoomCanvas` instance or a `createSVGView()` result. All options
default to `true` (except `legend`, which follows `bz.showLegend`). Returns an
SVG string suitable for download or embedding.

In the viewer, press **S** to trigger download.

### createSVGView — headless view from pipeline data

```javascript
import { createSVGView, exportSVG } from './bitzoom-svg.js';

const view = createSVGView(nodes, edges, {
  width: 800,            // canvas width (default 800)
  height: 600,           // canvas height (default 600)
  zoom: 1,               // renderZoom (default 1)
  pan: { x: 400, y: 300 }, // defaults to center
  colorBy: 'group',      // property name for coloring
  colorScheme: 0,        // scheme index (vivid, viridis, etc.)
  colorMap: { a: '#f00' }, // explicit value→hex (overrides colorScheme)
  sizeBy: 'nodes',       // 'nodes' or 'edges'
  sizeLog: false,        // log2 scaling
  edgeMode: 'lines',     // 'lines', 'curves', 'none'
  heatmapMode: 'off',    // 'off', 'density'
  lightMode: false,      // dark/light theme
  showLegend: false,     // false or corner position 1-4
  selectedIds: new Set(), // highlighted node ids
  labelProps: new Set(['label']),
  level: undefined,      // aggregated level (omit for raw)
});

const svg = exportSVG(view);
```

No DOM required. Takes pipeline output (nodes with `x`, `y`, `gx`, `gy`,
projections from `unifiedBlend`) and returns a view object that `exportSVG`
can render. Builds aggregated levels on demand via `buildLevel`. Uses
`generateGroupColors` for auto-coloring when no explicit `colorMap` is provided.

## Render layer order

Matches the canvas 5-layer order:

1. **Background** — solid `<rect>`, color from `bz._lightMode`
2. **Grid** — `<line>` elements at `40 * renderZoom` spacing, offset by `pan`
3. **Edges** — `<line>` (straight) or `<path>` with cubic Bézier (curves mode)
4. **Density heatmap** — contour band `<path>` elements with Gaussian blur filter
5. **Circles** — `<circle>` per node/supernode with fill/stroke opacity
6. **Labels** — `<text>` elements (same visibility rules as canvas renderer)
7. **Legend** — `<rect>` + `<circle>` + `<text>` positioned to match canvas

## Coordinate mapping

All node positions use the same transform as the canvas renderer:

```
screenX = node.x * renderZoom + pan.x
screenY = node.y * renderZoom + pan.y
```

Works at both raw level (`bz.nodes`) and aggregated levels (`level.supernodes`).

## Edge rendering

- **Sampling**: deterministic hash-based (`edgeHash`) with distance bias — closer
  edges are more likely to survive sampling. Cap at `min(5000, max(200, N*3))`.
- **Distance fade**: full opacity within 25% of diagonal, linear fade to zero at 120%.
- **Curve mode**: cubic Bézier with perpendicular offset (30%/70% control points),
  matching the canvas `drawCurveEdge` visual.

## Density heatmap contours

The canvas renderer draws density as a per-pixel rasterized image. SVG
approximates this with contour band polygons at three threshold levels,
smoothed and blurred.

### Pipeline

```
nodes → kernel density grid → threshold → trace boundary → simplify → smooth → SVG path
```

### Grid construction (scale = 4)

The viewport is divided into a coarse grid (`ceil(W/4)` × `ceil(H/4)`). Each
node contributes density via a quadratic kernel (`(1 - d²/R²)²`) within radius
`R = clamp(min(gw,gh)/8, 8, 40)`.

### Global normalization

**Critical design decision**: density thresholds use a **global maxW** computed
across all color groups, matching the canvas renderer's single `_densityW` grid.
Without this, small groups (5 nodes) would produce contours as large as dominant
groups (300 nodes), since per-color normalization scales each group to its own max.

Two-pass approach:
1. **Global pass**: accumulate all nodes into one grid → find `globalMaxW`
2. **Per-color pass**: accumulate each color group separately, threshold against
   `globalMaxW`

### Contour tracing (Moore neighborhood)

For each threshold (`0.08`, `0.25`, `0.5` of globalMaxW), cells above threshold
are identified and boundaries traced clockwise:

- Scan left-to-right, top-to-bottom for boundary cells (above threshold,
  left neighbor below or at grid edge)
- Trace using 8-directional Moore neighbor search
- `traced[]` bitmap prevents re-tracing the same region
- Max steps = `4 * gw * gh` to handle large complex boundaries

### Polygon post-processing

1. **Simplify**: Ramer-Douglas-Peucker (ε = 0.5 grid cells) removes collinear points
2. **Smooth**: Chaikin corner-cutting (2 iterations) produces organic curves
3. **Scale**: grid coordinates → SVG coordinates (multiply by scale factor 4)
4. **Filter**: SVG `<feGaussianBlur stdDeviation="6">` softens edges

### Opacity per band

| Band | Threshold | Dark mode | Light mode |
| ---: | --------: | --------: | ---------: |
|    0 |      0.08 |      0.12 |       0.18 |
|    1 |      0.25 |      0.24 |       0.30 |
|    2 |      0.50 |      0.36 |       0.42 |

Outer bands (low threshold) are drawn first → larger, fainter. Inner bands
(high threshold) overlay → smaller, more opaque. Combined with `fill-rule="evenodd"`.

## Circle sizing

```
rMax = clamp(cellPx * 0.40, 1, 20)     // raw level
rMax = clamp(cellPx * 0.42, 1.5, 40)   // aggregated levels
r    = clamp(rMin + sqrt(sizeVal) * rScale, rMin, rMax)
```

Where `cellPx = min(W,H) * renderZoom / gridDivisions` and `sizeVal` respects
`sizeBy` (edges vs count) and `sizeLog` (log2 scaling).

### Importance-based opacity

When >50 nodes visible, fill opacity scales with importance:
```
importance = 0.3 + 0.7 * sqrt(sizeVal / maxSizeVal)
```

## Label visibility

Same rules as canvas renderer:
- Always shown: selected or hovered nodes
- Shown when sparse: ≤50 visible nodes and `cellPx ≥ 20`
- Shown when important: ≤150 visible, importance > 0.7, `cellPx ≥ 20`

Multi-line labels (when `label` prop is active) split on ` · ` — name above,
properties below.

## Legend

Positioned in the same corner as the canvas legend (`bz.showLegend` 1-4 =
corners). Shows up to 12 entries sorted by frequency, with `+N more` overflow.

## Exports

| Function              | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `exportSVG(bz, opts)` | Render view to SVG string                         |
| `createSVGView(nodes, edges, opts)` | Build headless view from pipeline data |

## Internal functions

| Function              | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `esc(s)`              | XML-escape for text content                        |
| `scaleSize(val, bz)`  | Applies log2 scaling when `bz.sizeLog` is true     |
| `edgeHash(i)`         | Deterministic [0,1) hash for edge sampling         |
| `maxEdgesToDraw(N)`   | Edge count cap: `clamp(N*3, 200, 5000)`            |
| `traceThresholdRegions` | Moore neighbor contour tracing                   |
| `simplifyRDP`         | Ramer-Douglas-Peucker line simplification          |
| `smoothChaikin`       | Chaikin corner-cutting subdivision                 |
| `polyToSVGPath`       | Polygon → SVG `M...L...Z` path string              |
| `buildDensityContours` | Full heatmap pipeline: grid → contours → SVG      |

## Limitations

- Density heatmap is an approximation (contour bands vs per-pixel raster).
  Fine density gradients visible on canvas may merge or disappear in SVG.
- No WebGL equivalent — always uses CPU-side node positions.
- Edge sampling is deterministic but may differ from the canvas frame's
  adaptive sampling (which also considers frame rate).
- SVG file size grows with edge count and contour complexity. Large graphs
  (>5K nodes) can produce multi-MB SVGs.
