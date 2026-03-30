# WebGL Rendering Plan

Replace Canvas 2D rendering with WebGL for circles, edges, and heatmap.
Text stays on a Canvas 2D overlay (hybrid approach). Optional — falls back
to current Canvas 2D renderer when WebGL is unavailable.

## Architecture

Two canvases stacked via CSS:

```
<div style="position:relative">
  <canvas id="gl-canvas" style="position:absolute">   <!-- WebGL: circles, edges, heatmap -->
  <canvas id="text-canvas" style="position:absolute">  <!-- Canvas 2D: labels, legend, UI -->
</div>
```

The WebGL canvas renders geometry. The text canvas renders on top with
`globalCompositeOperation` or simply draws text over the transparent overlay.
Both canvases share the same dimensions and coordinate system.

## Current renderer breakdown

From [bitzoom-renderer.js](../docs/bitzoom-renderer.js) (938 lines):

| Layer | Current impl | WebGL replacement | Text canvas |
| --- | --- | --- | --- |
| Background grid | fillRect per line | Single fullscreen quad with grid shader | — |
| Edges (curves/lines) | strokeStyle + beginPath per edge | Instanced line segments | — |
| Heatmap | Per-pixel JS kernel | Density texture + color-map shader | — |
| Highlighted edges | Same as edges, different color | Same instanced lines, different uniform | — |
| Circles (supernodes) | arc() per node | Instanced quads with circle fragment shader | — |
| Labels + counts | fillText per node | — | fillText (same as now) |
| Legend | fillText + fillRect | — | Same as now |
| Reset button | fillRect + fillText | — | Same as now |
| Progress overlay | fillRect + fillText | — | Same as now |

## WebGL components

### 1. Circle renderer (highest impact)

One instanced draw call for all visible supernodes.

**Vertex data (per-instance attributes):**
- `vec2 center` — screen position (x, y)
- `float radius` — circle radius in pixels
- `vec4 color` — RGBA
- `float alpha` — opacity (importance-based)

**Vertex shader:** expand point to quad (4 vertices per instance, triangle strip).

**Fragment shader:** discard fragments outside circle radius (smooth edge via
`smoothstep` for anti-aliasing).

**Draw call:** `gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodeCount)`

**Estimated lines:** ~80 GLSL + ~60 JS

### 2. Edge renderer

Instanced line segments with alpha blending.

**Vertex data (per-instance):**
- `vec2 start` — source screen position
- `vec2 end` — target screen position
- `float alpha` — edge opacity (based on weight)

**Vertex shader:** compute line quad from start/end with configurable width.

**Fragment shader:** flat color with per-instance alpha.

**Draw call:** `gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, edgeCount)`

For curves: approximate Bezier with 3-4 line segments per edge. More instances
but same shader.

**Estimated lines:** ~60 GLSL + ~50 JS

### 3. Heatmap renderer

Two-pass approach:

**Pass 1 — Density accumulation:**
Render each node as a Gaussian splat (point sprite with Gaussian falloff)
to an offscreen framebuffer. Additive blending accumulates density.

**Pass 2 — Color mapping:**
Fullscreen quad reads density texture, maps through color ramp (uniform array
or 1D texture). Output to screen.

**Estimated lines:** ~40 GLSL + ~60 JS

### 4. Background grid

Single fullscreen quad. Fragment shader computes grid lines from zoom/pan
uniforms. Discards or dims fragments not on grid lines.

**Estimated lines:** ~20 GLSL + ~20 JS

## Text canvas overlay

The text canvas uses the existing Canvas 2D drawing code for:
- Node/supernode labels (`fillText`)
- Node counts
- Legend (color swatches + text)
- Reset button
- Progress overlay
- Algo info text

This code is extracted from the current renderer into a separate `renderText()`
function. It clears the text canvas, draws all text elements, and is called
after the WebGL render completes.

**Key:** the text canvas must have `willReadFrequently: false` and use
`globalCompositeOperation: 'source-over'` (default). Background is transparent
so the WebGL canvas shows through.

## Coordinate system

Both canvases use the same world-to-screen transform:

```javascript
screenX = (worldX - pan.x) * zoom * scale + W/2
screenY = (worldY - pan.y) * zoom * scale + H/2
```

The WebGL vertex shader receives world coordinates and pan/zoom as uniforms.
The text canvas uses the existing `worldToScreen` function.

## Integration with BitZoomCanvas

New module: `bitzoom-gl-renderer.js`

```javascript
export function createGLRenderer(glCanvas, textCanvas) {
  // Initialize WebGL2 context
  // Compile shaders
  // Create buffers
  // Return renderer object with render(state) method
}
```

The renderer object has the same interface as the current `render(state)` call
in `bitzoom-renderer.js`:

```javascript
// Current:
render(state)  // draws everything to state.canvas via Canvas 2D

// New:
glRenderer.render(state)   // draws geometry to GL canvas
textRenderer.render(state)  // draws text to overlay canvas
```

`BitZoomCanvas` checks for WebGL support at construction:

```javascript
if (opts.useWebGL !== false && canvas.getContext('webgl2')) {
  this._glRenderer = createGLRenderer(glCanvas, textCanvas);
} else {
  // Fall back to current Canvas 2D renderer
}
```

## Buffer management

**Static buffers (rebuilt on level change):**
- Circle instance buffer: position + radius + color per supernode
- Edge instance buffer: start + end + alpha per visible edge

**Dynamic uniforms (updated per frame):**
- Pan, zoom, viewport size
- Heatmap density scale (maxW)
- Grid spacing

**Rebuild triggers:**
- Level change: rebuild circle + edge buffers
- Weight/alpha change: rebuild circle colors + positions (after blend)
- Zoom/pan change: update uniforms only (no buffer rebuild)

## Hit testing

Keep CPU-based spatial hit testing (current `hitTest` function). WebGL
`readPixels` for picking adds latency and complexity. The current approach
uses the level's `_snByBid` spatial index which is O(1) lookup.

## Performance targets

| Operation | Canvas 2D | WebGL target |
| --- | ---: | ---: |
| 5K circles | 2ms | 0.1ms |
| 50K circles | 20ms+ | 0.5ms |
| 50K edges | 15ms (sampled) | 0.5ms (all) |
| Heatmap 1024x768 | 12ms | 0.3ms |
| Text (50 labels) | 1.5ms | 1.5ms (same) |
| Total frame 5K nodes | ~10ms | ~3ms |
| Total frame 50K nodes | ~50ms | ~4ms |

## Implementation order

1. **Canvas stacking + text extraction** — split current render into
   geometry and text passes. Text pass works on overlay canvas. Geometry
   pass still uses Canvas 2D. Validates the hybrid approach without WebGL.

2. **WebGL circle renderer** — replace Canvas 2D circle drawing with
   instanced WebGL quads. Biggest visual impact.

3. **WebGL edge renderer** — replace line/curve drawing with instanced
   line segments.

4. **WebGL heatmap** — replace JS kernel with density texture + color map.

5. **WebGL grid** — replace fillRect grid with fullscreen quad shader.

Step 1 is the critical foundation. It can be tested independently and
validates the dual-canvas architecture before any WebGL code is written.

## Fallback

```javascript
const gl = canvas.getContext('webgl2');
if (gl) {
  // WebGL path
} else {
  // Current Canvas 2D path (unchanged)
}
```

WebGL2 is available in all modern browsers (Chrome 56+, Firefox 51+,
Safari 15+, Edge 79+). Coverage is ~97%+ as of 2025. WebGL1 fallback
is not planned — the instanced rendering requires WebGL2.

## File structure

```
docs/
  bitzoom-gl-renderer.js    WebGL renderer: circles, edges, heatmap, grid
  bitzoom-text-renderer.js  Canvas 2D text: labels, legend, UI overlays
  shaders/                  (or inline in gl-renderer.js)
    circle.vert/frag
    edge.vert/frag
    heatmap-density.vert/frag
    heatmap-colormap.vert/frag
    grid.vert/frag
  bitzoom-renderer.js       Existing Canvas 2D renderer (kept as fallback)
```

## Estimated effort

| Component | GLSL | JS | Total |
| --- | ---: | ---: | ---: |
| Canvas stacking + text extraction | — | ~100 | ~100 |
| Circle renderer | ~80 | ~60 | ~140 |
| Edge renderer | ~60 | ~50 | ~110 |
| Heatmap renderer | ~40 | ~60 | ~100 |
| Grid renderer | ~20 | ~20 | ~40 |
| Integration + fallback | — | ~50 | ~50 |
| **Total** | **~200** | **~340** | **~540** |

## Open questions

- **Curves vs lines for edges.** Current renderer supports both. WebGL lines
  are straight segments. Curves would need tessellation (3-4 segments per
  edge) or a quadratic Bezier fragment shader. Start with lines only.

- **Node selection highlight.** Currently drawn as a thicker circle. In WebGL,
  this could be a second instanced draw pass with slightly larger radius and
  different color, or a uniform flag per instance.

- **Resize handling.** Both canvases must resize together. The WebGL viewport
  and text canvas dimensions must stay synchronized.

- **Transparency compositing.** The text canvas sits on top of the WebGL canvas.
  Both have transparent backgrounds where no content is drawn. CSS
  `pointer-events: none` on the text canvas ensures mouse events reach the
  WebGL/hit-test canvas underneath.
