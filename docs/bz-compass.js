// bz-compass.js — <bz-compass> web component for BitZoom.
// Radial 2D control: each property group is a spoke from center.
// Radial distance = strength (0–max), angular offset from home = bearing.
//
// Declarative usage (no JS needed):
//   <bz-graph id="g" edges="data/karate.edges" nodes="data/karate.nodes"></bz-graph>
//   <bz-compass for="g"></bz-compass>
//
// Programmatic usage:
//   const el = document.createElement('bz-compass');
//   el.groups = [
//     { name: 'group', color: '#e64', strength: 8, bearing: 0 },
//     { name: 'kind',  color: '#4ae', strength: 3, bearing: 0.5 },
//   ];
//   document.body.appendChild(el);
//
// Events:
//   'input'   — continuous during drag, detail: { name, strength, bearing }
//   'change'  — on drag end,            detail: { name, strength, bearing }
//   'colorby' — spoke label click,      detail: { name }

const TAU = Math.PI * 2;
const HANDLE_RADIUS = 7;
const HIT_RADIUS = 14;        // generous hit area
const SNAP_ANGLE_DEG = 5;     // ±5° bearing dead zone near home
const SNAP_CENTER_FRAC = 0.08; // radius fraction for strength→0 snap
const FLOOR_FRAC = 0.25;      // strength 0 displays at 25% radius
const LABEL_PAD = 14;         // px outside outer ring for labels

class BzCompass extends HTMLElement {
  static get observedAttributes() { return ['max-strength', 'for']; }

  constructor() {
    super();
    this._groups = [];
    this._maxStrength = 10;
    this._dragIdx = -1;
    this._dragConstraint = null; // null | 'radial' | 'angular'
    this._focusIdx = -1;
    this._hoverIdx = -1;
    this._showHelp = false;
    this._mouseInside = false;

    this._shadow = this.attachShadow({ mode: 'open' });
    this._shadow.innerHTML = `<style>
      :host { display: block; width: 200px; height: 200px; position: relative; }
      canvas { width: 100%; height: 100%; display: block; cursor: default; }
      canvas:focus { outline: 1px solid var(--border, #334); outline-offset: -1px; }
      .visually-hidden { position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0; }
      .toolbar { position: absolute; top: 4px; right: 4px; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; pointer-events: none; }
      :host(:hover) .toolbar, canvas:focus ~ .toolbar { opacity: 1; pointer-events: auto; }
      .toolbar button {
        background: var(--bg, #12122a); color: var(--fg, #dde); border: 1px solid var(--border, #334);
        font: bold 10px -apple-system, system-ui, sans-serif; padding: 2px 6px; border-radius: 3px;
        cursor: pointer; line-height: 1.2;
      }
      .toolbar button:hover { border-color: var(--accent, #5af); color: var(--accent, #5af); }
    </style>
    <canvas tabindex="0" role="application"
      aria-label="Strength and bearing compass. Tab to cycle handles, arrows to adjust, Up/Down for strength, Left/Right for bearing."></canvas>
    <div class="toolbar">
      <button data-action="zero" title="Reset all to zero" aria-label="Reset all strengths and bearings">0</button>
      <button data-action="auto" title="Auto-tune strengths and bearings" aria-label="Auto-tune">A</button>
    </div>
    <div class="visually-hidden" aria-live="assertive" aria-atomic="true"></div>`;
    this._canvas = this._shadow.querySelector('canvas');
    this._ariaLive = this._shadow.querySelector('[aria-live]');
    this._ctx = this._canvas.getContext('2d');

    this._bound = {
      pointerdown: this._onPointerDown.bind(this),
      pointermove: this._onPointerMove.bind(this),
      pointerup: this._onPointerUp.bind(this),
      dblclick: this._onDblClick.bind(this),
      pointercancel: this._onPointerCancel.bind(this),
      keydown: this._onKeyDown.bind(this),
      contextmenu: this._onContextMenu.bind(this),
    };
    this._rafPending = false;
  }

  connectedCallback() {
    const c = this._canvas;
    c.addEventListener('pointerdown', this._bound.pointerdown);
    c.addEventListener('pointermove', this._bound.pointermove);
    c.addEventListener('pointerup', this._bound.pointerup);
    c.addEventListener('dblclick', this._bound.dblclick);
    c.addEventListener('pointercancel', this._bound.pointercancel);
    c.addEventListener('keydown', this._bound.keydown);
    c.addEventListener('contextmenu', this._bound.contextmenu);
    c.addEventListener('mouseenter', () => { this._mouseInside = true; this._scheduleRender(); });
    c.addEventListener('mouseleave', () => { this._mouseInside = false; this._hoverIdx = -1; this._scheduleRender(); });
    // Toolbar buttons
    this._shadow.querySelector('.toolbar').addEventListener('click', (e) => {
      const action = e.target.dataset?.action;
      if (action === 'zero') this._zeroAll();
      else if (action === 'auto') this.dispatchEvent(new Event('autotune', { bubbles: true }));
    });
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this);
    // Defer initial resize to avoid forcing layout before stylesheets load
    requestAnimationFrame(() => this._resize());
    // Auto-bind if `for` attribute is present
    const forId = this.getAttribute('for');
    if (forId) this._bindToGraph(forId);
  }

  disconnectedCallback() {
    const c = this._canvas;
    c.removeEventListener('pointerdown', this._bound.pointerdown);
    c.removeEventListener('pointermove', this._bound.pointermove);
    c.removeEventListener('pointerup', this._bound.pointerup);
    c.removeEventListener('dblclick', this._bound.dblclick);
    c.removeEventListener('pointercancel', this._bound.pointercancel);
    c.removeEventListener('keydown', this._bound.keydown);
    c.removeEventListener('contextmenu', this._bound.contextmenu);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._boundReadyHandler) {
      this._boundTarget?.removeEventListener('ready', this._boundReadyHandler);
      this._boundReadyHandler = null;
      this._boundTarget = null;
    }
    if (this._boundView && this._boundBlendHandler) {
      this._boundView.canvas.removeEventListener('statechange', this._boundBlendHandler);
      this._boundBlendHandler = null;
    }
    if (this._onBoundInput) { this.removeEventListener('input', this._onBoundInput); this._onBoundInput = null; }
    if (this._onBoundAutotune) { this.removeEventListener('autotune', this._onBoundAutotune); this._onBoundAutotune = null; }
    this._boundView = null;
  }

  _announce(text) {
    if (this._ariaLive) {
      this._ariaLive.textContent = '';
      // Force re-announcement by clearing then setting in next frame
      requestAnimationFrame(() => { this._ariaLive.textContent = text; });
    }
  }

  _zeroAll() {
    for (const g of this._groups) {
      g.strength = 0;
      g.bearing = 0;
    }
    this._scheduleRender();
    // Fire change for each group so listeners can sync
    for (const g of this._groups) {
      this.dispatchEvent(new CustomEvent('change', {
        detail: { name: g.name, strength: 0, bearing: 0 },
        bubbles: true,
      }));
    }
  }

  _announceHandle(i) {
    const g = this._groups[i];
    if (!g) return;
    const deg = Math.round((g.bearing || 0) * 180 / Math.PI);
    this._announce(`${g.name}: strength ${Math.round(g.strength * 10) / 10}, bearing ${deg} degrees`);
  }

  attributeChangedCallback(name, _old, val) {
    if (name === 'max-strength') {
      this._maxStrength = parseFloat(val) || 10;
      this._scheduleRender();
    } else if (name === 'for') {
      this._bindToGraph(val);
    }
  }

  // ─── Public API ──��───────────────────────────────────────────────────────────

  get groups() { return this._groups; }
  set groups(arr) {
    this._groups = (arr || []).map(g => ({ ...g }));
    this._resize();
  }

  get maxStrength() { return this._maxStrength; }
  set maxStrength(v) { this._maxStrength = v; this._scheduleRender(); }

  /** Update a single group by name. */
  update(name, strength, bearing) {
    const g = this._groups.find(g => g.name === name);
    if (g) { g.strength = strength; g.bearing = bearing; this._scheduleRender(); }
  }

  /** Bulk-update all groups. */
  updateAll(arr) {
    for (const src of arr) {
      const g = this._groups.find(g => g.name === src.name);
      if (g) { g.strength = src.strength; g.bearing = src.bearing; if (src.color) g.color = src.color; }
    }
    this._scheduleRender();
  }

  /** Return an SVG string of the current compass state.
   *  @param {object} [opts] - { size, bg, fg, border, accent }
   *  @returns {string} SVG markup (no xmlns — suitable for embedding in a larger SVG) */
  toSVG(opts = {}) {
    const G = this._groups.length;
    if (!G) return '';
    const size = opts.size || 200;
    const cx = size / 2, cy = size / 2;
    const R = size / 2 - LABEL_PAD - 6;
    const bg = opts.bg || '#12122a';
    const fg = opts.fg || '#dde';
    const border = opts.border || '#334';
    const accent = opts.accent || '#5af';
    const maxW = this._maxStrength;

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const f1 = n => n.toFixed(1);

    const homeAngle = i => -Math.PI / 2 + (TAU * i) / G;
    const handleXY = (g, i) => {
      const frac = g.strength / maxW;
      const r = (FLOOR_FRAC + frac * (1 - FLOOR_FRAC)) * R;
      const a = homeAngle(i) + (g.bearing || 0);
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };

    const p = [];
    p.push(`<g font-family="-apple-system, system-ui, sans-serif">`);

    // Concentric rings (matching canvas FLOOR_FRAC scaling)
    const ringCount = 4;
    for (let r = 1; r <= ringCount; r++) {
      const rr = (FLOOR_FRAC + ((r / ringCount) * (1 - FLOOR_FRAC))) * R;
      p.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(rr)}" fill="none" stroke="${border}" stroke-width="0.5"/>`);
    }

    // Outer ring
    p.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(R)}" fill="none" stroke="${fg}" stroke-opacity="0.3" stroke-width="1"/>`);

    // Floor ring (strength=0 boundary)
    const floorR = FLOOR_FRAC * R;
    p.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(floorR)}" fill="none" stroke="${border}" stroke-width="0.5" stroke-dasharray="2 4"/>`);

    // Spokes + labels (auto-abbreviate long names)
    const maxLabelLen = Math.max(4, Math.round(R / 8));
    for (let i = 0; i < G; i++) {
      const a = homeAngle(i);
      const ex = cx + R * Math.cos(a), ey = cy + R * Math.sin(a);
      p.push(`<line x1="${f1(cx)}" y1="${f1(cy)}" x2="${f1(ex)}" y2="${f1(ey)}" stroke="${border}" stroke-width="0.5" stroke-dasharray="3 3"/>`);
      const lx = cx + (R + LABEL_PAD) * Math.cos(a);
      const ly = cy + (R + LABEL_PAD) * Math.sin(a);
      const cos = Math.cos(a);
      const anchor = Math.abs(cos) < 0.1 ? 'middle' : cos > 0 ? 'start' : 'end';
      const fontSize = Math.max(8, Math.min(11, R / (G + 1)));
      let name = this._groups[i].name;
      if (name.length > maxLabelLen) name = name.slice(0, maxLabelLen - 1) + '…';
      p.push(`<text x="${f1(lx)}" y="${f1(ly + 4)}" fill="${fg}" fill-opacity="0.7" font-size="${fontSize}" text-anchor="${anchor}">${esc(name)}</text>`);
    }

    // Polygon fill
    if (G >= 3) {
      const pts = [];
      for (let i = 0; i < G; i++) {
        const [hx, hy] = handleXY(this._groups[i], i);
        pts.push(`${f1(hx)},${f1(hy)}`);
      }
      p.push(`<polygon points="${pts.join(' ')}" fill="${accent}" fill-opacity="0.08" stroke="${accent}" stroke-opacity="0.25" stroke-width="1"/>`);
    } else {
      for (let i = 0; i < G; i++) {
        const [hx, hy] = handleXY(this._groups[i], i);
        p.push(`<line x1="${f1(cx)}" y1="${f1(cy)}" x2="${f1(hx)}" y2="${f1(hy)}" stroke="${this._groups[i].color || accent}" stroke-opacity="0.3" stroke-width="1.5"/>`);
      }
    }

    // Tether lines
    for (let i = 0; i < G; i++) {
      const g = this._groups[i];
      if (!g.bearing) continue;
      const [hx, hy] = handleXY(g, i);
      const a = homeAngle(i);
      const sx = cx + R * Math.cos(a), sy = cy + R * Math.sin(a);
      p.push(`<line x1="${f1(hx)}" y1="${f1(hy)}" x2="${f1(sx)}" y2="${f1(sy)}" stroke="${g.color || accent}" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="3 3"/>`);
    }

    // Handles
    for (let i = 0; i < G; i++) {
      const g = this._groups[i];
      const [hx, hy] = handleXY(g, i);
      const color = g.color || accent;
      p.push(`<circle cx="${f1(hx)}" cy="${f1(hy)}" r="7" fill="${color}" fill-opacity="0.7"/>`);
      const deg = Math.round((g.bearing || 0) * 180 / Math.PI);
      p.push(`<title>${esc(g.name)}: ${Math.round(g.strength * 10) / 10} / ${deg}°</title>`);
    }

    // Center dot
    p.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="3" fill="${fg}" fill-opacity="0.4"/>`);
    p.push('</g>');
    return p.join('\n');
  }

  // ─── Auto-bind to <bz-graph> via `for` attribute ─────────────────────────

  _bindToGraph(id) {
    // Clean up previous binding
    if (this._boundView && this._boundBlendHandler) {
      this._boundView.canvas.removeEventListener('statechange', this._boundBlendHandler);
      this._boundBlendHandler = null;
    }
    if (this._boundView) {
      this._boundView = null;
    }
    if (this._boundReadyHandler) {
      this._boundTarget?.removeEventListener('ready', this._boundReadyHandler);
      this._boundReadyHandler = null;
      this._boundTarget = null;
    }
    if (!id) return;

    const el = document.getElementById(id);
    if (!el) return;

    const attach = () => {
      const view = el.view;
      if (!view || !view.groupNames || !view.groupNames.length) return;
      this._boundView = view;
      this._syncFromView();

      // Push compass changes → view
      let _rebuildPending = false;
      this.addEventListener('input', this._onBoundInput = (e) => {
        const { name, strength, bearing } = e.detail;
        view.propStrengths[name] = strength;
        view.propBearings[name] = bearing;
        if (!_rebuildPending) {
          _rebuildPending = true;
          requestAnimationFrame(() => {
            _rebuildPending = false;
            view._quantStats = {};
            view.levels = new Array(view.levels.length).fill(null);
            view._blend().then(() => { view.layoutAll(); view.render(); });
          });
        }
      });

      // Auto-tune button — toggle start/stop
      let tuneAbort = null;
      this.addEventListener('autotune', this._onBoundAutotune = async () => {
        if (tuneAbort) { tuneAbort.abort(); return; }
        try {
          tuneAbort = new AbortController();
          const btn = this._shadow.querySelector('[data-action="auto"]');
          if (btn) { btn.textContent = '■'; btn.title = 'Stop auto-tune'; }
          const { autoTuneStrengths, autoTuneBearings } = await import('./bitzoom-utils.js');
          const result = await autoTuneStrengths(view.nodes, view.groupNames, view.adjList, view.nodeIndexFull, {
            strengths: true, alpha: true, signal: tuneAbort.signal,
          });
          for (const g of view.groupNames) view.propStrengths[g] = result.strengths[g] ?? 0;
          view.smoothAlpha = result.alpha;
          view.quantMode = result.quantMode;
          view._quantStats = {};
          const bearings = autoTuneBearings(view.nodes, view.groupNames, result.strengths);
          view.propBearings = bearings;
          view.levels = new Array(view.levels.length).fill(null);
          await view._blend();
          view.layoutAll();
          view.render();
        } catch (e) { console.warn('[bz-compass] autotune failed:', e.message); }
        tuneAbort = null;
        const btn = this._shadow.querySelector('[data-action="auto"]');
        if (btn) { btn.textContent = 'A'; btn.title = 'Auto-tune strengths and bearings'; }
      });

      // Pull view changes → compass after each statechange
      this._boundBlendHandler = () => this._syncFromView();
      view.canvas.addEventListener('statechange', this._boundBlendHandler);
    };

    // If the view is already ready, bind immediately; otherwise wait for 'ready' event
    if (el.view) {
      attach();
    } else {
      this._boundTarget = el;
      this._boundReadyHandler = () => attach();
      el.addEventListener('ready', this._boundReadyHandler, { once: true });
    }
  }

  /** Pull current strengths/bearings/colors from the bound view into groups. */
  _syncFromView() {
    const v = this._boundView;
    if (!v) return;
    const skip = new Set(['label', 'structure', 'neighbors']);
    const groups = v.groupNames.filter(g => !skip.has(g)).map(g => {
      const cmap = v.propColors && v.propColors[g];
      const color = cmap ? Object.values(cmap)[0] || '#888' : '#888';
      return {
        name: g,
        color,
        strength: v.propStrengths[g] || 0,
        bearing: v.propBearings[g] || 0,
      };
    });
    // Only update if actually changed (avoid render loop)
    const same = this._groups.length === groups.length &&
      groups.every((g, i) => {
        const o = this._groups[i];
        return o && o.name === g.name && o.strength === g.strength && o.bearing === g.bearing && o.color === g.color;
      });
    if (!same) {
      if (this._groups.length === groups.length) {
        this.updateAll(groups);
      } else {
        this.groups = groups;
      }
    }
  }

  // ─── Geometry helpers ────��───────────────────────────────────────────────────

  get _cx() { return this._canvas.width / 2; }
  get _cy() { return this._canvas.height / 2; }
  get _radius() { return Math.max(1, Math.min(this._cx, this._cy) - LABEL_PAD - 10); }

  /** Home angle for group index i (evenly spaced, first spoke at 12 o'clock). */
  _homeAngle(i) {
    return -Math.PI / 2 + (TAU * i) / this._groups.length;
  }

  /** Convert group state to canvas (x, y). Strength 0 maps to FLOOR_FRAC of radius. */
  _handleXY(g, i) {
    const frac = g.strength / this._maxStrength;
    const r = (FLOOR_FRAC + frac * (1 - FLOOR_FRAC)) * this._radius;
    const a = this._homeAngle(i) + (g.bearing || 0);
    return [this._cx + r * Math.cos(a), this._cy + r * Math.sin(a)];
  }

  /** Convert canvas (x, y) to (strength, bearing) for group index i. */
  _xyToStrengthBearing(x, y, i) {
    const dx = x - this._cx, dy = y - this._cy;
    const dist = Math.hypot(dx, dy);
    // Invert the floor mapping: visual frac = FLOOR_FRAC + (strength/max) * (1 - FLOOR_FRAC)
    const visFrac = dist / this._radius;
    let strength = Math.max(0, (visFrac - FLOOR_FRAC) / (1 - FLOOR_FRAC)) * this._maxStrength;
    strength = Math.max(0, Math.min(this._maxStrength, strength));

    // Snap to 0 near center
    if (visFrac < FLOOR_FRAC + SNAP_CENTER_FRAC) strength = 0;

    const angle = Math.atan2(dy, dx);
    let bearing = angle - this._homeAngle(i);
    // Normalize to [-π, π]
    while (bearing > Math.PI) bearing -= TAU;
    while (bearing < -Math.PI) bearing += TAU;

    // Snap bearing to 0 near home angle
    const snapRad = SNAP_ANGLE_DEG * Math.PI / 180;
    if (Math.abs(bearing) < snapRad) bearing = 0;

    return { strength, bearing };
  }

  /** Hit test: return group index at (x, y) or -1. */
  _hitTest(x, y) {
    const dpr = window.devicePixelRatio || 1;
    const px = x * dpr, py = y * dpr;
    for (let i = this._groups.length - 1; i >= 0; i--) {
      const [hx, hy] = this._handleXY(this._groups[i], i);
      if (Math.hypot(px - hx, py - hy) < HIT_RADIUS * dpr) return i;
    }
    return -1;
  }

  // ─── Rendering ───────���───────────────────────────────────────────────────────

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.getBoundingClientRect();
    this._canvas.width = rect.width * dpr;
    this._canvas.height = rect.height * dpr;
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => { this._rafPending = false; this._render(); });
  }

  _render() {
    const ctx = this._ctx;
    const w = this._canvas.width, h = this._canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const cx = this._cx, cy = this._cy, R = this._radius;
    const G = this._groups.length;
    if (!G) return;

    // Read CSS custom properties from host
    const style = getComputedStyle(this);
    const bg = style.getPropertyValue('--bg').trim() || '#12122a';
    const fg = style.getPropertyValue('--fg').trim() || '#dde';
    const border = style.getPropertyValue('--border').trim() || '#334';
    const accent = style.getPropertyValue('--accent').trim() || '#5af';

    ctx.clearRect(0, 0, w, h);

    // Concentric strength rings (faint)
    ctx.strokeStyle = border;
    ctx.lineWidth = 0.5 * dpr;
    const ringCount = 4;
    for (let r = 1; r <= ringCount; r++) {
      const ringR = (FLOOR_FRAC + ((r / ringCount) * (1 - FLOOR_FRAC))) * R;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, TAU);
      ctx.stroke();
    }

    // Outer ring
    ctx.strokeStyle = fg;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Floor ring (strength 0 boundary)
    ctx.strokeStyle = border;
    ctx.lineWidth = 0.5 * dpr;
    ctx.setLineDash([2 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.arc(cx, cy, FLOOR_FRAC * R, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    // Spokes + labels
    const fontSize = Math.max(8, Math.min(11, R / (G + 1)));
    ctx.font = `${fontSize * dpr}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    // Compute max label width available per spoke
    const maxLabelPx = (R * 0.5); // rough budget per label in CSS px
    for (let i = 0; i < G; i++) {
      const a = this._homeAngle(i);
      const ex = cx + R * Math.cos(a), ey = cy + R * Math.sin(a);

      // Spoke line
      ctx.strokeStyle = border;
      ctx.lineWidth = 0.5 * dpr;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label (auto-abbreviate to fit)
      const lx = cx + (R + LABEL_PAD * dpr) * Math.cos(a);
      const ly = cy + (R + LABEL_PAD * dpr) * Math.sin(a);
      ctx.fillStyle = fg;
      ctx.globalAlpha = 0.7;
      const cos = Math.cos(a);
      ctx.textAlign = Math.abs(cos) < 0.1 ? 'center' : cos > 0 ? 'left' : 'right';
      let name = this._groups[i].name;
      // Truncate if too wide for available space
      const budgetPx = maxLabelPx * dpr;
      while (name.length > 2 && ctx.measureText(name).width > budgetPx) {
        name = name.slice(0, -1);
      }
      if (name !== this._groups[i].name) name += '…';
      ctx.fillText(name, lx, ly);
      ctx.globalAlpha = 1;
    }

    // Polygon fill
    if (G >= 3) {
      ctx.beginPath();
      for (let i = 0; i < G; i++) {
        const [hx, hy] = this._handleXY(this._groups[i], i);
        if (i === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
      }
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.08;
      ctx.fill();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Lines from center to each handle (when < 3 groups, no polygon)
    if (G < 3) {
      for (let i = 0; i < G; i++) {
        const [hx, hy] = this._handleXY(this._groups[i], i);
        ctx.strokeStyle = this._groups[i].color || accent;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Tether lines: handle �� outer ring at home angle (bearing=0 guide)
    for (let i = 0; i < G; i++) {
      const g = this._groups[i];
      if (!g.bearing) continue; // no offset, handle is on the spoke already
      const [hx, hy] = this._handleXY(g, i);
      const a = this._homeAngle(i);
      const sx = cx + R * Math.cos(a), sy = cy + R * Math.sin(a);
      ctx.strokeStyle = g.color || accent;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Handles
    for (let i = 0; i < G; i++) {
      const g = this._groups[i];
      const [hx, hy] = this._handleXY(g, i);
      const color = g.color || accent;
      const active = i === this._dragIdx || i === this._focusIdx;
      const hover = i === this._hoverIdx;

      // Handle circle
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE_RADIUS * dpr, 0, TAU);
      ctx.fillStyle = color;
      ctx.globalAlpha = active ? 1 : hover ? 0.85 : 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Outline for active/focused
      if (active) {
        ctx.strokeStyle = fg;
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
      }

      // Value label on hover/drag + group name below handle when active
      if (active || hover) {
        const deg = Math.round((g.bearing || 0) * 180 / Math.PI);
        const label = `${Math.round(g.strength * 10) / 10} / ${deg}°`;
        ctx.font = `bold ${10 * dpr}px -apple-system, system-ui, sans-serif`;
        ctx.fillStyle = fg;
        ctx.textAlign = 'center';
        ctx.fillText(label, hx, hy - (HANDLE_RADIUS + 6) * dpr);
        ctx.fillText(g.name, hx, hy + (HANDLE_RADIUS + 12) * dpr);
      }
    }

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3 * dpr, 0, TAU);
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.4;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Help overlay
    if (this._showHelp) {
      const pad = 10 * dpr;
      const lines = [
        'Drag handle: set strength + bearing',
        'Shift+drag: strength only',
        'Alt+drag: bearing only',
        'Double-click: reset to zero',
        'Right-click: reset bearing only',
        'Tab: cycle handles',
        '↑↓: strength  ←→: bearing',
      ];
      const helpFontSize = 10 * dpr;
      ctx.font = `${helpFontSize}px -apple-system, system-ui, sans-serif`;
      const lineH = helpFontSize * 1.5;
      const boxH = lines.length * lineH + pad * 2;
      const boxW = w * 0.85;
      const bx = (w - boxW) / 2, by = (h - boxH) / 2;
      ctx.fillStyle = bg;
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, 6 * dpr);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = fg;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], bx + pad, by + pad + li * lineH);
      }
    }
  }

  // ─── Pointer events ───────────────────────────────��──────────────────────────

  _canvasXY(e) {
    const rect = this._canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  _onPointerDown(e) {
    const [x, y] = this._canvasXY(e);

    // Dismiss help on any click
    if (this._showHelp) {
      this._showHelp = false;
      this._scheduleRender();
      return;
    }

    const idx = this._hitTest(x, y);
    if (idx < 0) return;

    e.preventDefault();
    this._canvas.focus();
    this._dragIdx = idx;
    this._focusIdx = idx;
    this._dragConstraint = e.shiftKey ? 'radial' : e.altKey ? 'angular' : null;
    this._canvas.setPointerCapture(e.pointerId);
    this._canvas.style.cursor = 'grabbing';
    this._scheduleRender();
  }

  _onPointerMove(e) {
    const [x, y] = this._canvasXY(e);

    if (this._dragIdx >= 0) {
      // Update constraint if modifier changed mid-drag
      this._dragConstraint = e.shiftKey ? 'radial' : e.altKey ? 'angular' : null;

      const dpr = window.devicePixelRatio || 1;
      const { strength, bearing } = this._xyToStrengthBearing(x * dpr, y * dpr, this._dragIdx);
      const g = this._groups[this._dragIdx];

      if (this._dragConstraint === 'radial') {
        g.strength = strength;
      } else if (this._dragConstraint === 'angular') {
        g.bearing = bearing;
      } else {
        g.strength = strength;
        g.bearing = bearing;
      }
      this._scheduleRender();
      this.dispatchEvent(new CustomEvent('input', {
        detail: { name: g.name, strength: g.strength, bearing: g.bearing },
        bubbles: true,
      }));
    } else {
      // Hover detection
      const oldHover = this._hoverIdx;
      this._hoverIdx = this._hitTest(x, y);
      this._canvas.style.cursor = this._hoverIdx >= 0 ? 'grab' : 'default';
      if (this._hoverIdx !== oldHover) this._scheduleRender();
    }
  }

  _onPointerUp(e) {
    if (this._dragIdx >= 0) {
      const g = this._groups[this._dragIdx];
      this.dispatchEvent(new CustomEvent('change', {
        detail: { name: g.name, strength: g.strength, bearing: g.bearing },
        bubbles: true,
      }));
      this._dragIdx = -1;
      this._dragConstraint = null;
      try { this._canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      this._canvas.style.cursor = 'default';
      this._scheduleRender();
    }
  }

  _onPointerCancel(e) {
    if (this._dragIdx >= 0) {
      this._dragIdx = -1;
      this._dragConstraint = null;
      try { this._canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      this._canvas.style.cursor = 'default';
      this._scheduleRender();
    }
  }

  _onDblClick(e) {
    const [x, y] = this._canvasXY(e);
    const idx = this._hitTest(x, y);
    if (idx < 0) return;
    e.preventDefault();
    const g = this._groups[idx];
    g.strength = 0;
    g.bearing = 0;
    this._scheduleRender();
    this.dispatchEvent(new CustomEvent('change', {
      detail: { name: g.name, strength: 0, bearing: 0 },
      bubbles: true,
    }));
  }

  _onContextMenu(e) {
    const [x, y] = this._canvasXY(e);
    const idx = this._hitTest(x, y);
    if (idx < 0) return;
    e.preventDefault();
    // Right-click: reset bearing only, keep strength
    const g = this._groups[idx];
    g.bearing = 0;
    this._scheduleRender();
    this.dispatchEvent(new CustomEvent('change', {
      detail: { name: g.name, strength: g.strength, bearing: 0 },
      bubbles: true,
    }));
  }

  // ─── Keyboard ────────���──────────────────────────────���────────────────────────

  _onKeyDown(e) {
    const G = this._groups.length;
    if (!G) return;

    // Tab/Shift+Tab cycles focus between handles
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        this._focusIdx = this._focusIdx <= 0 ? G - 1 : this._focusIdx - 1;
      } else {
        this._focusIdx = this._focusIdx >= G - 1 ? 0 : this._focusIdx + 1;
      }
      this._announceHandle(this._focusIdx);
      this._scheduleRender();
      return;
    }

    if (this._focusIdx < 0 || this._focusIdx >= G) {
      this._focusIdx = 0;
      this._announceHandle(0);
      this._scheduleRender();
      return;
    }

    const g = this._groups[this._focusIdx];
    const step = e.shiftKey ? 0.5 : 1;
    const angleStep = e.shiftKey ? (5 * Math.PI / 180) : (15 * Math.PI / 180);
    let consumed = false;

    if (e.key === 'ArrowUp') {
      g.strength = Math.min(this._maxStrength, g.strength + step);
      consumed = true;
    } else if (e.key === 'ArrowDown') {
      g.strength = Math.max(0, g.strength - step);
      consumed = true;
    } else if (e.key === 'ArrowRight') {
      g.bearing = (g.bearing || 0) + angleStep;
      consumed = true;
    } else if (e.key === 'ArrowLeft') {
      g.bearing = (g.bearing || 0) - angleStep;
      consumed = true;
    } else if (e.key === 'Home' || e.key === '0') {
      g.strength = 0; g.bearing = 0;
      consumed = true;
    } else if (e.key === 'Enter') {
      // Dispatch colorby on Enter
      this.dispatchEvent(new CustomEvent('colorby', {
        detail: { name: g.name },
        bubbles: true,
      }));
      consumed = true;
    }

    if (consumed) {
      e.preventDefault();
      e.stopPropagation();
      // Normalize bearing to [-π, π]
      while (g.bearing > Math.PI) g.bearing -= TAU;
      while (g.bearing < -Math.PI) g.bearing += TAU;
      this._announceHandle(this._focusIdx);
      this._scheduleRender();
      this.dispatchEvent(new CustomEvent('input', {
        detail: { name: g.name, strength: g.strength, bearing: g.bearing },
        bubbles: true,
      }));
    }
  }
}

customElements.define('bz-compass', BzCompass);
export { BzCompass };
