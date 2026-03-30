# WebGL Rendering Architecture

WebGL2 instanced renderer for BitZoom geometry. Text stays on a Canvas 2D
overlay. Self-contained in BitZoomCanvas — no external HTML changes.

## Dual Canvas Layout

```
wrapper div (position: relative, inherits grid/flex slot from canvas)
  ├── <canvas> WebGL2 — geometry (grid, edges, heatmap, circles)
  └── <canvas> original — transparent text overlay (labels, legend, reset)
```

- **GL canvas**: `pointer-events: none`, behind the original, opaque (`alpha: false`)
- **Original canvas**: keeps all events, `background: transparent`, text on top
- **Wrapper div**: copies border + layout properties from the canvas, replaces it
  in the DOM flow so CSS grid/flex layout is unaffected

Toggled via `view.useWebGL = true/false` (getter/setter on BitZoomCanvas).
Constructor accepts `{ webgl: true }`. Probe: `isWebGL2Available()`.

## Files

| File | Role |
| --- | --- |
| [bitzoom-gl-renderer.js](../docs/bitzoom-gl-renderer.js) | Shaders, programs, VAOs, instance builders, draw calls (~1202 lines) |
| [bitzoom-canvas.js](../docs/bitzoom-canvas.js) | `_initWebGL`, `_destroyWebGL`, `useWebGL`, wrapper management, resize |
| [bitzoom-renderer.js](../docs/bitzoom-renderer.js) | `render()` skips geometry when `bz._gl` active, always draws text |
| [bitzoom-viewer.js](../docs/bitzoom-viewer.js) | GL toggle button, `isWebGL2Available` import, GL wrapper hide/show with loader |
| [webgl-test.html](../docs/webgl-test.html) | Side-by-side Canvas 2D vs WebGL2 visual comparison page |

## Shaders and Programs

Seven shader programs, all compiled and linked in `initGL()`:

| Program | Vertex shader | Draw mode | Purpose |
| --- | --- | --- | --- |
| `_circleProgram` | `CIRCLE_VS` | instanced TRIANGLE_STRIP (4 verts) | SDF circles with fill + stroke |
| `_circleProgram._glow` | `GLOW_VS` | instanced TRIANGLE_STRIP (4 verts) | Selection/hover radial glow |
| `_edgeLineProgram` | `EDGE_LINE_VS` | instanced TRIANGLE_STRIP (4 verts) | Straight line edges |
| `_edgeCurveProgram` | `EDGE_CURVE_VS` | instanced TRIANGLE_STRIP (34 verts) | Bezier curve edges (GPU tessellation) |
| `_heatSplatProg` | `HEAT_SPLAT_VS` | instanced TRIANGLE_STRIP (4 verts) | Density splats to FBO |
| `_heatResolveProg` | `HEAT_RESOLVE_VS` | TRIANGLE_STRIP (4 verts) | Fullscreen quad: FBO → screen |
| `_gridProgram` | `GRID_VS` | TRIANGLE_STRIP (4 verts) | Fullscreen quad: procedural grid |

## Static VBOs

| Buffer | Contents | Vertices |
| --- | --- | --- |
| `_quadVBO` | Unit quad `[-1,1]²` | 4 (circle/glow/heatmap instances) |
| `_edgeLineQuadVBO` | Line quad `[0..1] × [-1,1]` | 4 (straight edge instances) |
| `_edgeCurveVBO` | Curve strip `t ∈ [0,1]` × `[-1,1]` | 34 (16 segments × 2 sides + 2) |
| `_fsQuadVBO` | Clip-space fullscreen quad | 4 (grid, heatmap resolve) |

All static, uploaded once at init.

## Instance Data Layouts

**Circles** (11 floats, 44 bytes per instance):
```
[cx, cy, radius, fillR, fillG, fillB, fillA, strokeR, strokeG, strokeB, strokeA]
```

**Edges** (8 floats, 32 bytes per instance):
```
[startX, startY, endX, endY, r, g, b, a]
```

**Heatmap splats** reuse the circle layout (11 floats), with `fillColor.a` =
kernel weight and `fillColor.rgb` = node color.

All instance data written to `_instanceVBO` (shared, dynamic) per draw call.

## VAOs

| VAO | Quad VBO (loc 0) | Instance VBO (loc 1-4) |
| --- | --- | --- |
| `_circleVAO` | `_quadVBO` | 11-float circle layout |
| `_edgeLineVAO` | `_edgeLineQuadVBO` | 8-float edge layout |
| `_edgeCurveVAO` | `_edgeCurveVBO` | 8-float edge layout |
| `_heatResolveVAO` | `_fsQuadVBO` | (none) |

## Render Order

```
renderGL(gl, bz)
  1. clear (color from canvas CSS background)
  2. grid            — fullscreen quad, procedural lines in fragment shader
  3. normal edges    — instanced lines or curves
  4. heatmap         — density: FBO splat + resolve, or splat: additive glow
  5. hilite edges    — instanced, thicker, for selected/hovered nodes
  6. glow halos      — instanced radial gradient for selected/hovered
  7. circles         — instanced SDF circles with fill + stroke
```

Matches Canvas 2D layer order: grid → edges → heatmap → hilite edges → circles.
Labels, legend, reset button drawn by Canvas 2D `render()` on the overlay.

## Bezier Curve Edges (GPU Tessellation)

Curves evaluate entirely on the GPU. Each edge is **one instance** regardless
of edge mode. The vertex shader computes:

```glsl
// Control points (same as Canvas 2D drawEdge)
vec2 c1 = start + dir * 0.3 + perp * len * 0.15;
vec2 c2 = start + dir * 0.7 + perp * len * 0.05;

// Cubic Bezier at t (from vertex attribute)
vec2 p = (1-t)³·start + 3(1-t)²t·c1 + 3(1-t)t²·c2 + t³·end;

// Tangent-perpendicular offset for line width
vec2 tang = 3(1-t)²·(c1-start) + 6(1-t)t·(c2-c1) + 3t²·(end-c2);
```

The curve strip VBO has 16 segments (34 vertices), uploaded once. No per-frame
CPU tessellation or buffer allocation.

## Heatmap Density (Two-Pass)

1. **Splat pass**: Render each node as a Gaussian kernel quad to a quarter-res
   RGBA16F FBO with additive blending (`gl.ONE, gl.ONE`). Positions and radius
   in FBO grid coordinates (screen / 4). Kernel: `k = (1 - dist²)² × weight`.

2. **Resolve pass**: Fullscreen quad reads FBO texture, normalizes color by
   weight, maps intensity via `maxW`. Output alpha capped at 0.7.

`maxW` computed on CPU using the same kernel accumulation as Canvas 2D
(quarter-res grid, weight channel only). Lerped over time for smooth
transitions. Cached by level/zoom/size config key.

Requires `EXT_color_buffer_half_float` (requested at init, ~97% support).

## Heatmap Splat Mode

Additive-blended radial quads using the glow shader. Each node becomes a large
quad (radius 50–400px) with `alpha = 0.15`. Blended with `gl.SRC_ALPHA, gl.ONE`.

## Grid

Procedural fullscreen quad shader. Fragment shader computes grid line distance
from `u_gridSize` and `u_pan`:

```glsl
vec2 g = abs(fract(p / u_gridSize + 0.5) - 0.5) * u_gridSize;
float line = 1.0 - smoothstep(0.0, 1.0, min(g.x, g.y));
```

Fades out at `gridSize < 4px` (same as Canvas 2D).

## Circle SDF

Fragment shader uses signed distance for anti-aliased circles:

```glsl
float dist = length(v_uv) * (radius + 1.0);
float aa = smoothstep(radius + 1.0, radius - 0.5, dist);
float strokeMask = smoothstep(radius - 2.0, radius - 0.5, dist);
```

Fill and stroke blended in a single fragment pass (no separate draw calls).
Selection: white stroke, full alpha. Importance-based opacity for dense views.

## Clear Color

Parsed from the canvas element's CSS `backgroundColor` at init time and stored
on the GL context (`gl._clearR/G/B`). Matches the viewer's `#12122a` or any
custom background. Fallback: `#0a0a0f`.

## Wrapper and Layout

`_initWebGL` creates a wrapper div that replaces the canvas in the DOM flow:

1. Copies `border`, `min-height`, `width`, `height` from canvas computed style
2. Inserts GL canvas (behind) and original canvas (on top, transparent) as
   absolute-positioned children
3. Sets original canvas `background: transparent`, `border: none`
4. `_destroyWebGL` unwraps: moves canvas back, removes wrapper, restores styles

`resize()` measures the wrapper (or canvas if no GL) via `getBoundingClientRect`.

## Fallback

If `getContext('webgl2')` fails, `_initWebGL` unwraps and falls back silently
to Canvas 2D. No error shown to user. `isWebGL2Available()` probes without
side effects (creates and destroys a temporary canvas).

## Event Handling

All events bind to the original canvas (on top). GL canvas has
`pointer-events: none`. Hit testing uses the existing CPU spatial index.
No changes to mouse/touch/keyboard handlers.

## Viewer Integration

**GL toggle button**: toolbar button (`#glBtn`). Shows "GL" when WebGL2 available, "N/A" when
not. Highlighted with accent color when active. Toggles `view.useWebGL` on click.

**Loader screen**: `showLoaderScreen()` hides the canvas and its GL wrapper div (if present).
A cancel button (`#cancelLoadBtn`) appears when data is already loaded, allowing the user to
dismiss the loader and return to the current view. On cancel, the canvas and GL wrapper are
restored and `resize()` is called.

**webgl-test.html**: standalone comparison page that renders the same dataset side-by-side in
Canvas 2D and WebGL2 using two `createBitZoomView()` instances (one with `webgl: false`, one
with `webgl: true`).

## Buffer Rebuild Triggers

| Trigger | Edges | Circles | Heatmap |
| --- | --- | --- | --- |
| Zoom/pan | rebuild (screen coords) | rebuild | rebuild |
| Level change | rebuild | rebuild | rebuild |
| Selection change | hilite pass only | glow + alpha | no |
| Weight/blend change | rebuild | rebuild | rebuild |

All instance data rebuilt per frame from node positions (already in screen
coordinates from `layoutAll`). No persistent GPU buffers for instance data —
`_instanceVBO` is overwritten each draw call with `DYNAMIC_DRAW`.
