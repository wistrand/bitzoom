// bitzoom-canvas.js — Standalone embeddable BitZoom graph view.
// No sidebar, no header, no detail panel, no workers, no file loading.
// Just a canvas with pan/zoom/select/hover and the full rendering pipeline.
//
// Usage:
//   import { BitZoomCanvas } from './bitzoom-canvas.js';
//   import { runPipeline } from './bitzoom-pipeline.js';
//   import { unifiedBlend, buildLevel, ... } from './bitzoom-algo.js';
//
//   const result = runPipeline(edgesText, nodesText);
//   // ... hydrate nodes with projections, blend ...
//   const view = new BitZoomCanvas(canvasElement, { nodes, edges, ... });

import {
  MINHASH_K, GRID_SIZE, GRID_BITS, ZOOM_LEVELS, RAW_LEVEL, LEVEL_LABELS,
  buildGaussianProjection, unifiedBlend, buildLevel,
  buildLevelNodes, buildLevelEdges, cellIdAtLevel,
  getNodePropValue, getSupernodeDominantValue, maxCountKey,
} from './bitzoom-algo.js';
import { generateGroupColors, COLOR_SCHEMES, COLOR_SCHEME_NAMES } from './bitzoom-colors.js';
import { autoTuneStrengths } from './bitzoom-utils.js';
import { initGL, renderGL } from './bitzoom-gl-renderer.js';

import { layoutAll, render, worldToScreen, screenToWorld, hitTest } from './bitzoom-renderer.js';

export class BitZoomCanvas {
  static _instanceCount = 0;
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {Array} opts.nodes - hydrated node objects with .projections, .px, .py, .gx, .gy, .x, .y
   * @param {Array} opts.edges - [{src, dst}, ...]
   * @param {object} opts.nodeIndexFull - {id: node}
   * @param {object} opts.adjList - {id: [neighborIds]}
   * @param {Array} opts.groupNames - property group names
   * @param {object} opts.propStrengths - {groupName: strength}
   * @param {object} opts.propColors - {groupName: {value: '#hex'}}
   * @param {object} opts.groupColors - {groupValue: '#hex'}
   * @param {string} [opts.heatmapMode='off'] - 'off', 'splat', 'density'
   * @param {string} [opts.edgeMode='curves'] - 'curves', 'lines', 'none'
   * @param {string} [opts.sizeBy='edges'] - 'members' or 'edges'
   * @param {boolean} [opts.sizeLog=false]
   * @param {number} [opts.initialLevel=3] - 0-indexed into ZOOM_LEVELS
   * @param {number} [opts.smoothAlpha=0]
   * @param {function} [opts.onSelect] - callback(hit) when a node/supernode is clicked
   * @param {function} [opts.onHover] - callback(hit) on hover change
   * @param {function} [opts.onAnnounce] - callback(text) for accessibility announcements
   * @param {function} [opts.onSummary] - callback([{label, group, connections}]) for summary table data (on level change/load)
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Graph data
    this.nodes = opts.nodes || [];
    this.edges = opts.edges || [];
    this.nodeIndexFull = opts.nodeIndexFull || {};
    this.adjList = opts.adjList || {};
    this.groupNames = opts.groupNames || [];
    this.propStrengths = { ...opts.propStrengths } || {};
    this.propBearings = { ...(opts.propBearings || {}) }; // per-group rotation in radians
    this.propColors = opts.propColors || {};
    this.groupColors = opts.groupColors || this.propColors['group'] || {};
    this.groupProjections = {};
    this.smoothAlpha = opts.smoothAlpha || 0;
    this.maxDegree = 1;
    this.hasEdgeTypes = opts.hasEdgeTypes || false;

    // Build projection matrices
    for (let i = 0; i < this.groupNames.length; i++) {
      this.groupProjections[this.groupNames[i]] = buildGaussianProjection(2001 + i, MINHASH_K);
    }

    // Compute max degree
    for (const n of this.nodes) {
      if (n.degree > this.maxDegree) this.maxDegree = n.degree;
    }

    // View state
    this.W = 0;
    this.H = 0;
    this.currentLevel = opts.initialLevel ?? 3;
    this.baseLevel = this.currentLevel;
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.sizeBy = opts.sizeBy || 'edges';
    this.sizeLog = opts.sizeLog || false;
    this.edgeMode = opts.edgeMode || 'curves';
    this.heatmapMode = opts.heatmapMode || 'off';
    this.quantMode = opts.quantMode || 'gaussian'; // 'gaussian' or 'rank'
    this.showLegend = opts.showLegend ? 1 : 0; // 0=hidden, 1=BR, 2=BL, 3=TL, 4=TR
    this.showResetBtn = opts.showResetBtn || false;
    this._progressText = null; // overlay text shown during auto-tune
    this.showFps = opts.showFps || false;
    this._colorScheme = opts.colorScheme || 0;
    this._colorBy = opts.colorBy || null; // null = auto (highest strength group)
    this._lightMode = opts.lightMode || false;
    this._useGPU = false; // when true, blend uses GPU compute
    this._gl = null;       // WebGL2 context (null = Canvas 2D mode)
    this._glCanvas = null; // WebGL canvas element
    this._glWrapper = null; // wrapper div for GL canvas pair
    this._quantStats = {}; // fixed Gaussian boundaries — computed once, reused
    this._blendGen = 0;   // incremented after each blend — used by heatmap cache

    // Initialize WebGL if requested
    if (opts.webgl) this._initWebGL(canvas);
    this.labelProps = new Set(opts.labelProps || []);

    // Store initial state for reset
    this._initLevel = this.currentLevel;
    this._initColorScheme = this._colorScheme;

    // Selection
    this.selectedIds = new Set();
    this._primarySelectedId = null;
    this.hoveredId = null;
    this.zoomTargetId = null;

    // Callbacks
    this._onSelect = opts.onSelect || null;
    this._onHover = opts.onHover || null;
    this._onAnnounce = opts.onAnnounce || null;
    this._onSummary = opts.onSummary || null;
    this._onDeselect = opts.onDeselect || null;
    this._onLevelChange = opts.onLevelChange || null;
    this._onZoomToHit = opts.onZoomToHit || null;
    this._onSwitchLevel = opts.onSwitchLevel || null;
    this._onKeydown = opts.onKeydown || null;
    this._clickDelay = opts.clickDelay || 0;
    this._clickTimer = null;
    this._keyboardTarget = opts.keyboardTarget || null;

    // Level cache
    this.levels = new Array(ZOOM_LEVELS.length).fill(null);

    // Property caching
    this._cachedDominant = 'label';
    this._cachedLabelProps = ['label'];
    this._cachedColorMap = {};
    this._refreshPropCache();

    // Input state
    this.mouseDown = false;
    this.mouseMoved = false;
    this.mouseStart = null;
    this.t1 = null;
    this.t2 = null;
    this.touchMoved = false;
    this._renderPending = false;
    this._edgeBuildRaf = null;
    this._abortController = new AbortController();
    this._resizeObserver = null;
    this._onRender = opts.onRender || null;
    this._viewAnnounceTimer = 0;
    this._hoverAnnounceTimer = 0;
    this._a11yState = { level: -1, zoom: -1, sel: null, hov: null, labelKey: '', colorBy: '' };

    // Keyboard node navigation
    this._navNeighbors = null; // sorted neighbor list for current selection
    this._navIndex = -1;       // current position in neighbor list
    this._navAnchorId = null;  // selection id that built the current list
    this._navStepping = false;  // true during _navStep to preserve neighbor list
    this._lastMouseX = -1;     // last known mouse position on canvas
    this._lastMouseY = -1;

    this._bindEvents();
    this.resize();
  }

  // ─── Computed properties ───────────────────────────────────────────────────

  get renderZoom() {
    return Math.max(1, this.zoom * Math.pow(2, this.currentLevel - this.baseLevel));
  }

  get selectedId() { return this._primarySelectedId; }
  set selectedId(id) {
    if (id !== this._primarySelectedId && !this._navStepping) {
      this._navNeighbors = null; this._navAnchorId = null; this._navIndex = -1;
    }
    this._primarySelectedId = id;
    if (id === null) this.selectedIds.clear();
    else if (!this.selectedIds.has(id)) { this.selectedIds.clear(); this.selectedIds.add(id); }
  }

  isSelected(id) { return this.selectedIds.has(id); }

  toggleSelection(id) {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      this._primarySelectedId = this.selectedIds.size > 0 ? [...this.selectedIds].pop() : null;
    } else {
      this.selectedIds.add(id);
      this._primarySelectedId = id;
    }
  }

  /** Fire an accessibility announcement via the onAnnounce callback. */
  announce(text) { if (this._onAnnounce) this._onAnnounce(text); }

  /** Push summary table data for visible nodes via the onSummary callback. */
  _emitSummary() {
    if (!this._onSummary) return;
    const isRaw = this.currentLevel === RAW_LEVEL;
    const allNodes = isRaw ? this.nodes : (this.getLevel(this.currentLevel)?.supernodes || []);
    const rz = this.renderZoom;
    const W = this.W, H = this.H;
    // Filter to visible nodes (within viewport)
    const visible = [];
    for (const n of allNodes) {
      const sx = n.x * rz + this.pan.x;
      const sy = n.y * rz + this.pan.y;
      if (sx >= -20 && sx <= W + 20 && sy >= -20 && sy <= H + 20) visible.push(n);
    }
    visible.sort((a, b) => {
      const av = isRaw ? (a.degree || 0) : (a.members?.length || 0);
      const bv = isRaw ? (b.degree || 0) : (b.members?.length || 0);
      return bv - av;
    });
    this._onSummary(visible.slice(0, 50).map(n => ({
      label: isRaw ? this._nodeLabel(n) : this._supernodeLabel(n),
      group: isRaw ? this._nodeColorVal(n) : (n.cachedColorVal || ''),
      connections: isRaw ? (n.degree || 0) : (n.members?.length || 0),
    })));
  }

  /** Describe a node/supernode for screen readers. */
  _describeNode(hit) {
    if (!hit) return '';
    if (hit.type === 'node') {
      const n = hit.item;
      return `${this._nodeLabel(n)}, ${this._nodeColorVal(n)}, ${n.degree || 0} connections`;
    }
    const sn = hit.item;
    return `${this._supernodeLabel(sn)}, ${sn.members ? sn.members.length : 0} members`;
  }

  /** Look up a node or supernode by id at the current level. */
  _findById(id) {
    if (this.currentLevel === RAW_LEVEL) return this.nodeIndexFull[id];
    const level = this.getLevel(this.currentLevel);
    if (!level) return null;
    if (!level._snByBid) {
      level._snByBid = new Map();
      for (const sn of level.supernodes) level._snByBid.set(sn.bid, sn);
    }
    return level._snByBid.get(id);
  }

  /** Describe the current level for announcements. */
  _describeLevel() {
    const isRaw = this.currentLevel === RAW_LEVEL;
    if (isRaw) return `Raw level, ${this.nodes.length} nodes`;
    const level = this.getLevel(this.currentLevel);
    const count = level ? level.supernodes.length : 0;
    return `Level ${LEVEL_LABELS[this.currentLevel]}, ${count} supernodes`;
  }

  get _dominantProp() { return this._cachedDominant; }
  get _labelProp() { return this._cachedLabelProps[0]; }

  _refreshPropCache() {
    let best = 'label', bestW = 0;
    for (const g of this.groupNames) {
      if ((this.propStrengths[g] || 0) > bestW) { bestW = this.propStrengths[g]; best = g; }
    }
    // colorBy overrides auto-selection for coloring; layout dominant stays strength-based
    const colorProp = (this._colorBy && this.groupNames.includes(this._colorBy)) ? this._colorBy : best;
    this._cachedDominant = colorProp;
    this._cachedLabelProps = this.labelProps.size > 0 ? [...this.labelProps] : [best];
    this._cachedColorMap = this.propColors[colorProp] || {};
    this.levels = new Array(ZOOM_LEVELS.length).fill(null);
    if (this._edgeBuildRaf) { cancelAnimationFrame(this._edgeBuildRaf); this._edgeBuildRaf = null; }
  }

  /** Cycle to next color scheme and regenerate all colors */
  cycleColorScheme() {
    this._colorScheme = (this._colorScheme + 1) % COLOR_SCHEMES.length;
    // Regenerate propColors for all groups using sorted values
    for (const g of this.groupNames) {
      const values = [...new Set(this.nodes.map(n => getNodePropValue(n, g, this.adjList)))].sort();
      this.propColors[g] = generateGroupColors(values, this._colorScheme);
    }
    this._refreshPropCache();
    this.layoutAll();
    this.render();
  }

  get colorScheme() { return this._colorScheme; }
  set colorScheme(idx) {
    this._colorScheme = idx % COLOR_SCHEMES.length;
    for (const g of this.groupNames) {
      const values = [...new Set(this.nodes.map(n => getNodePropValue(n, g, this.adjList)))].sort();
      this.propColors[g] = generateGroupColors(values, this._colorScheme);
    }
    this._refreshPropCache();
    this.layoutAll();
    this.render();
  }
  get colorSchemeName() { return COLOR_SCHEME_NAMES[this._colorScheme]; }

  get colorBy() { return this._colorBy; }
  set colorBy(val) {
    this._colorBy = val && this.groupNames.includes(val) ? val : null;
    this._refreshPropCache();
    this.layoutAll();
    this.render();
  }

  get lightMode() { return this._lightMode; }
  set lightMode(val) {
    this._lightMode = !!val;
    // Update GL clear color if active
    if (this._gl && this.canvas) {
      const root = this.canvas.ownerDocument?.documentElement;
      if (root) {
        const bg = getComputedStyle(root).getPropertyValue('--canvas-bg').trim();
        const m = bg && bg.match(/#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
        if (m) { this._gl._clearR = parseInt(m[1],16)/255; this._gl._clearG = parseInt(m[2],16)/255; this._gl._clearB = parseInt(m[3],16)/255; }
      }
    }
    this.render();
  }

  // ─── Node property accessors (used by renderer) ───────────────────────────

  _nodeLabel(n) {
    const props = this._cachedLabelProps;
    if (props.length === 1) return getNodePropValue(n, props[0], this.adjList);
    const parts = [];
    for (const p of props) {
      const v = getNodePropValue(n, p, this.adjList);
      if (v && v !== 'unknown') parts.push(v);
    }
    return parts.length > 0 ? parts.join(' · ') : n.label || n.id;
  }

  _supernodeLabel(sn) {
    const props = this._cachedLabelProps;
    if (props.length === 1) return getSupernodeDominantValue(sn, props[0], this.adjList);
    const parts = [];
    for (const p of props) {
      const v = getSupernodeDominantValue(sn, p, this.adjList);
      if (v && v !== 'unknown') parts.push(v);
    }
    return parts.length > 0 ? parts.join(' · ') : sn.repName;
  }

  _nodeColorVal(n) { return getNodePropValue(n, this._cachedDominant, this.adjList); }
  _nodeColor(n) { return this._cachedColorMap[this._nodeColorVal(n)] || '#888888'; }
  _supernodeColor(sn) {
    const counts = {};
    for (const m of sn.members) {
      const val = this._nodeColorVal(m);
      counts[val] = (counts[val] || 0) + 1;
    }
    return (this._cachedColorMap[maxCountKey(counts)]) || '#888888';
  }

  // ─── Level & layout ────────────────────────────────────────────────────────

  getLevel(idx) {
    if (!this.levels[idx]) {
      const colorProp = this._dominantProp;
      const propColors = this.propColors[colorProp];
      // Phase 1: supernodes only (fast). Edges built asynchronously in chunks.
      this.levels[idx] = buildLevelNodes(
        ZOOM_LEVELS[idx], this.nodes,
        n => getNodePropValue(n, colorProp, this.adjList),
        n => this._nodeLabel(n),
        val => (propColors && propColors[val]) || '#888888'
      );
      this.layoutAll();
      this._scheduleEdgeBuild(idx);
    } else if (!this.levels[idx]._edgesReady && !this._edgeBuildRaf) {
      // Edges were cancelled by a competing build — reschedule
      this._scheduleEdgeBuild(idx);
    }
    return this.levels[idx];
  }

  _scheduleEdgeBuild(idx) {
    if (this._edgeBuildRaf) { cancelAnimationFrame(this._edgeBuildRaf); this._edgeBuildRaf = null; }
    const levelObj = this.levels[idx];
    if (!levelObj || levelObj._edgesReady) return;

    const edges = this.edges;
    const nodeIndexFull = this.nodeIndexFull;
    const level = ZOOM_LEVELS[idx];
    const CHUNK = 50000;
    const canPack = level <= 13;
    const PACK_MUL = 0x4000000;
    const snEdgeMap = new Map();
    let offset = 0;

    const processChunk = () => {
      const end = Math.min(offset + CHUNK, edges.length);
      for (let i = offset; i < end; i++) {
        const e = edges[i];
        const srcNode = nodeIndexFull[e.src];
        const dstNode = nodeIndexFull[e.dst];
        if (!srcNode || !dstNode) continue;
        const sbid = cellIdAtLevel(srcNode.gx, srcNode.gy, level);
        const dbid = cellIdAtLevel(dstNode.gx, dstNode.gy, level);
        if (sbid !== dbid) {
          const lo = sbid < dbid ? sbid : dbid;
          const hi = sbid < dbid ? dbid : sbid;
          const key = canPack ? lo * PACK_MUL + hi : lo + ',' + hi;
          snEdgeMap.set(key, (snEdgeMap.get(key) || 0) + 1);
        }
      }
      offset = end;

      if (this.levels[idx] !== levelObj) { this._edgeBuildRaf = null; return; } // level invalidated

      if (offset < edges.length) {
        this._edgeBuildRaf = requestAnimationFrame(processChunk);
      } else {
        // Materialize snEdges array
        const snEdges = new Array(snEdgeMap.size);
        let j = 0;
        if (canPack) {
          for (const [key, weight] of snEdgeMap) snEdges[j++] = { a: key / PACK_MUL | 0, b: key % PACK_MUL, weight };
        } else {
          for (const [key, weight] of snEdgeMap) {
            const comma = key.indexOf(',');
            snEdges[j++] = { a: parseInt(key.slice(0, comma), 10), b: parseInt(key.slice(comma + 1), 10), weight };
          }
        }
        levelObj.snEdges = snEdges;
        levelObj._edgesReady = true;
        this._edgeBuildRaf = null;
        this.render();
      }
    };
    this._edgeBuildRaf = requestAnimationFrame(processChunk);
  }

  layoutAll() { layoutAll(this); }
  render() {
    if (this._renderPending) return;
    this._renderPending = true;
    requestAnimationFrame(() => {
      this._renderPending = false;
      const t0 = performance.now();
      if (this._gl) renderGL(this._gl, this);
      render(this);
      this._lastFrameMs = performance.now() - t0;
      this._frameCount = (this._frameCount || 0) + 1;
      const now = performance.now();
      if (!this._fpsTime) this._fpsTime = now;
      if (now - this._fpsTime >= 1000) {
        this._fps = this._frameCount;
        this._frameCount = 0;
        this._fpsTime = now;
      }
      if (this.showFps) this._drawFps();
      this._postRender();
    });
  }

  _drawFps() {
    const ctx = this.ctx;
    const fps = this._fps || 0;
    const ms = this._lastFrameMs || 0;
    const mode = this._gl ? 'GL' : '2D';
    const text = `${fps} fps · ${ms.toFixed(1)}ms · ${mode}`;
    ctx.font = '10px JetBrains Mono';
    ctx.fillStyle = this._lightMode ? 'rgba(60,60,80,0.6)' : 'rgba(200,200,220,0.6)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, 6, 6);
  }

  /** Hook for post-render actions (e.g., hash state updates, accessibility). */
  _postRender() {
    if (this._onRender) this._onRender();
    this._a11yCheck();
  }

  /** Detect state changes and fire accessibility announcements. */
  _a11yCheck() {
    if (!this._onAnnounce && !this._onSummary) return;
    const prev = this._a11yState;
    const level = this.currentLevel;
    const zoom = this.renderZoom;
    const sel = this._primarySelectedId;
    const hov = this.hoveredId;
    let levelChanged = false;

    if (level !== prev.level) {
      // Skip the initial -1 → real transition (load announcement handles that)
      if (prev.level !== -1) this.announce(this._describeLevel());
      this._emitSummary();
      prev.level = level;
      prev.sel = sel; // suppress "selection cleared" as side effect of level change
      prev.zoom = zoom; // suppress zoom announce on level change
      levelChanged = true;
    }
    const selChanged = sel !== prev.sel;
    if (selChanged) {
      if (sel) {
        const item = this._findById(sel);
        if (item) {
          const type = this.currentLevel === RAW_LEVEL ? 'node' : 'supernode';
          this.announce(`Selected: ${this._describeNode({ type, item })}`);
        }
      } else {
        this.announce('Selection cleared');
      }
      prev.sel = sel;
    }
    if (hov !== prev.hov) {
      clearTimeout(this._hoverAnnounceTimer);
      // Don't announce hover if selection just changed (selection takes priority)
      if (hov && !selChanged) {
        this._hoverAnnounceTimer = setTimeout(() => {
          const item = this._findById(hov);
          if (item) {
            const type = this.currentLevel === RAW_LEVEL ? 'node' : 'supernode';
            this.announce(this._describeNode({ type, item }));
          }
        }, 300);
      }
      prev.hov = hov;
    }
    if (!levelChanged && Math.abs(zoom - prev.zoom) > 0.01) {
      clearTimeout(this._viewAnnounceTimer);
      this._viewAnnounceTimer = setTimeout(() => {
        this.announce(`Zoom ${this.renderZoom.toFixed(1)}x. ${this._describeLevel()}`);
        this._emitSummary();
      }, 400);
      prev.zoom = zoom;
    }
    const labelKey = this._cachedLabelProps.join(',');
    const colorBy = this._cachedDominant;
    if (labelKey !== prev.labelKey || colorBy !== prev.colorBy) {
      // Skip initial empty → real transition (load handles that)
      if (prev.labelKey !== '') this.announce(`Showing ${labelKey.replace(/,/g, ', ')}, colored by ${colorBy}`);
      this._emitSummary();
      prev.labelKey = labelKey;
      prev.colorBy = colorBy;
    }
  }

  /** Show progress overlay on the canvas. Set to null to clear. */
  showProgress(text) {
    this._progressText = text;
    // Render the graph first, then overlay progress on top
    render(this);
    if (text) {
      const ctx = this.canvas.getContext('2d');
      const W = this.W, H = this.H;
      // Semi-transparent bar behind text
      const barH = 28;
      const y = H / 2 - barH / 2;
      ctx.fillStyle = 'rgba(10, 10, 15, 0.8)';
      ctx.fillRect(0, y, W, barH);
      ctx.fillStyle = '#c8c8d8';
      ctx.font = '13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, W / 2, H / 2);
    }
  }

  renderNow() { render(this); this._a11yCheck(); }
  worldToScreen(wx, wy) { return worldToScreen(this, wx, wy); }
  screenToWorld(sx, sy) { return screenToWorld(this, sx, sy); }
  hitTest(sx, sy) { return hitTest(this, sx, sy); }

  resize() {
    // clientWidth/Height = content box (excludes border), matching the canvas drawing area
    this.W = this.canvas.clientWidth || 300;
    this.H = this.canvas.clientHeight || 300;
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    if (this._glCanvas) {
      this._glCanvas.width = this.W;
      this._glCanvas.height = this.H;
    }
    this.layoutAll();
    this.render();
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  zoomForLevel(levelIdx) {
    // Keep zoom at 1 and pan at origin — layoutAll already fits nodes to the canvas with padding.
    // Previous implementation could set zoom>1, pushing edge nodes outside the padded area.
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
  }

  switchLevel(idx) {
    const prevIdx = this.currentLevel;
    const oldRZ = this.renderZoom;
    this.currentLevel = idx;
    this.zoom = oldRZ / Math.pow(2, idx - this.baseLevel);
    this.selectedId = null;
    this.layoutAll();
    this.render();
    if (idx !== prevIdx && this._onLevelChange) this._onLevelChange(idx, prevIdx);
  }

  _checkAutoLevel() {
    const prevIdx = this.currentLevel;
    const maxIdx = LEVEL_LABELS.length - 1;
    if (prevIdx < maxIdx && this.zoom >= 2) {
      this._snapshotForCrossfade();
      this.zoom /= 2;
      this.currentLevel = prevIdx + 1;
      this.layoutAll();
      if (this._onLevelChange) this._onLevelChange(this.currentLevel, prevIdx);
      return;
    }
    if (prevIdx > 0 && this.zoom < 0.5) {
      this._snapshotForCrossfade();
      this.zoom *= 2;
      this.currentLevel = prevIdx - 1;
      this.layoutAll();
      if (this.renderZoom <= 1) this.pan = {x: 0, y: 0};
      if (this._onLevelChange) this._onLevelChange(this.currentLevel, prevIdx);
      return;
    }
    if (this.currentLevel === 0 && this.renderZoom <= 1) {
      this.pan = {x: 0, y: 0};
    }
  }

  /** Capture current canvas into a fading overlay for smooth level transitions. */
  _snapshotForCrossfade() {
    const src = this.canvas;
    // Find the container — GL wrapper or canvas parent
    const container = src.parentElement;
    if (!container) return;
    // Ensure container can anchor absolute children
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    // Reuse or create overlay canvas
    let overlay = this._crossfadeOverlay;
    if (!overlay) {
      overlay = document.createElement('canvas');
      overlay.style.cssText = 'position:absolute;pointer-events:none;z-index:10;transition:opacity 350ms ease-out;';
      this._crossfadeOverlay = overlay;
    }

    overlay.width = src.width;
    overlay.height = src.height;
    overlay.style.width = src.style.width || src.offsetWidth + 'px';
    overlay.style.height = src.style.height || src.offsetHeight + 'px';
    // Position overlay at the canvas's offset within its container
    overlay.style.top = src.offsetTop + 'px';
    overlay.style.left = src.offsetLeft + 'px';

    const ctx = overlay.getContext('2d');
    ctx.drawImage(src, 0, 0);

    overlay.style.opacity = '1';
    container.appendChild(overlay);

    // Force reflow then trigger fade
    overlay.offsetHeight; // eslint-disable-line no-unused-expressions
    overlay.style.opacity = '0';

    // Clean up after transition
    clearTimeout(this._crossfadeTimer);
    this._crossfadeTimer = setTimeout(() => {
      if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
    }, 400);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Whether GPU compute is used for blend operations */
  get useGPU() { return this._useGPU; }
  set useGPU(val) { this._useGPU = !!val; }

  /** Whether WebGL2 is used for rendering */
  get useWebGL() { return !!this._gl; }
  set useWebGL(val) {
    if (val && !this._gl) this._initWebGL(this.canvas);
    else if (!val && this._gl) this._destroyWebGL();
    this.resize();
    this.render();
  }

  /** Initialize WebGL: wrap canvas in a container, add GL canvas behind it */
  _initWebGL(canvas) {
    const parent = canvas.parentElement;
    if (!parent) return;

    // Wrap canvas in a relative container so absolute children don't collapse layout
    const wrapper = document.createElement('div');
    // Copy canvas layout properties to wrapper so it fills the same grid/flex slot
    const cs = getComputedStyle(canvas);
    wrapper.style.cssText = `position:relative;width:${cs.width};height:${cs.height};min-height:0;overflow:hidden;grid-column:${cs.gridColumn};grid-row:${cs.gridRow}`;
    parent.insertBefore(wrapper, canvas);
    wrapper.appendChild(canvas);
    this._glWrapper = wrapper;

    this._glCanvas = document.createElement('canvas');
    // GL canvas behind: copies any CSS background from the original canvas
    this._glCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
    const canvasBg = getComputedStyle(canvas).backgroundColor;
    if (canvasBg && canvasBg !== 'rgba(0, 0, 0, 0)') {
      this._glCanvas.style.background = canvasBg;
      this._origCanvasBg = canvas.style.background;
    }
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    // Original canvas must be transparent so GL canvas shows through
    canvas.style.background = 'transparent';
    // Insert GL canvas BEFORE the original so it's behind (lower z-order)
    wrapper.insertBefore(this._glCanvas, canvas);

    this._gl = initGL(this._glCanvas);
    if (!this._gl) {
      // Unwrap on failure — restore canvas styles
      wrapper.parentElement.insertBefore(canvas, wrapper);
      wrapper.remove();
      canvas.style.position = '';
      canvas.style.top = '';
      canvas.style.left = '';
      canvas.style.width = '';
      canvas.style.height = '';
      if (this._origCanvasBg !== undefined) {
        canvas.style.background = this._origCanvasBg;
        this._origCanvasBg = undefined;
      } else {
        canvas.style.background = '';
      }
      this._glCanvas = null;
      this._glWrapper = null;
      return;
    }
    // Parse CSS background into GL clear color
    if (canvasBg) {
      const m = canvasBg.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) { this._gl._clearR = +m[1] / 255; this._gl._clearG = +m[2] / 255; this._gl._clearB = +m[3] / 255; }
    }
    console.log('[GL] WebGL2 rendering enabled');
  }

  /** Tear down WebGL canvas and unwrap */
  _destroyWebGL() {
    if (this._glCanvas) {
      this._glCanvas.remove();
      this._glCanvas = null;
      this._gl = null;
    }
    if (this._glWrapper) {
      const parent = this._glWrapper.parentElement;
      if (parent) {
        parent.insertBefore(this.canvas, this._glWrapper);
        this._glWrapper.remove();
      }
      this._glWrapper = null;
      this.canvas.style.position = '';
      this.canvas.style.top = '';
      this.canvas.style.left = '';
      this.canvas.style.width = '';
      this.canvas.style.height = '';
      if (this._origCanvasBg !== undefined) {
        this.canvas.style.background = this._origCanvasBg;
        this._origCanvasBg = undefined;
      }
      console.log('[GL] WebGL2 rendering disabled');
    }
  }

  /** Run blend (GPU for large datasets when useGPU, else CPU) */
  async _blend() {
    // Notify listeners that state has changed BEFORE the expensive blend.
    // UI can sync sliders/dials/compass immediately from propStrengths/propBearings.
    this.canvas.dispatchEvent(new Event('statechange'));
    if (this._useGPU && this.nodes.length > 50000) {
      try {
        // NOTE: GPU blend does not yet apply bearings (see Phase 1 GPU work in PLAN-bearings.md).
        // Fall through to CPU path when any bearing is non-zero.
        const hasBearings = this._hasAnyBearing();
        if (!hasBearings) {
          await gpuUnifiedBlend(this.nodes, this.groupNames, this.propStrengths, this.smoothAlpha, this.adjList, this.nodeIndexFull, 5, this.quantMode, this._quantStats);
          this._blendGen++;
          this.canvas.dispatchEvent(new Event('blend'));
          return;
        }
      } catch (e) {
        console.warn('[GPU] Blend failed, falling back to CPU:', e.message);
      }
    }
    unifiedBlend(this.nodes, this.groupNames, this.propStrengths, this.smoothAlpha, this.adjList, this.nodeIndexFull, 5, this.quantMode, this._quantStats, this.propBearings);
    this._blendGen++;
    this.canvas.dispatchEvent(new Event('blend'));
  }

  /** True if any group has a non-zero bearing set. Used to decide whether the
   *  GPU blend path is safe (GPU shader doesn't yet apply rotation). */
  _hasAnyBearing() {
    if (!this.propBearings) return false;
    for (const g in this.propBearings) {
      if (this.propBearings[g]) return true;
    }
    return false;
  }

  /** Update property strengths and re-blend */
  setStrengths(strengths) {
    Object.assign(this.propStrengths, strengths);
    this._refreshPropCache();
    this._blend().then(() => { this.layoutAll(); this.render(); });
  }
  /** @deprecated Use setStrengths() */
  setWeights(w) { this.setStrengths(w); }

  /** Update the bearing (rotation, in radians) for a single group and re-blend.
   *  Triggers the same quantize + level-invalidation path as a strength change. */
  setBearing(group, radians) {
    this.propBearings[group] = radians;
    this._quantStats = {}; // refreeze Gaussian quantization stats on rotation
    this.levels = new Array(ZOOM_LEVELS.length).fill(null); // invalidate cached levels
    this._blend().then(() => { this.layoutAll(); this.render(); });
  }

  /** Bulk-set bearings (e.g. from dataset preset or URL hash restore) without
   *  per-group re-blending. Merges into current state; keys absent from `obj`
   *  are untouched. Caller is responsible for triggering a subsequent blend. */
  bulkSetBearings(obj) {
    if (!obj) return;
    Object.assign(this.propBearings, obj);
    this._quantStats = {};
    this.levels = new Array(ZOOM_LEVELS.length).fill(null);
  }

  /** Update topology alpha and re-blend */
  setAlpha(alpha) {
    this.smoothAlpha = alpha;
    this.levels = new Array(ZOOM_LEVELS.length).fill(null);
    this._blend().then(() => { this.layoutAll(); this.render(); });
  }

  /** Set display options */
  setOptions(opts) {
    if (opts.heatmapMode !== undefined) this.heatmapMode = opts.heatmapMode;
    if (opts.edgeMode !== undefined) this.edgeMode = opts.edgeMode;
    if (opts.sizeBy !== undefined) this.sizeBy = opts.sizeBy;
    if (opts.sizeLog !== undefined) this.sizeLog = opts.sizeLog;
    if (opts.labelProps !== undefined) {
      this.labelProps = new Set(opts.labelProps);
      this._refreshPropCache();
    }
    this.render();
  }

  /** Reset view to initial zoom/pan/level/selection */
  resetView() {
    this.currentLevel = this._initLevel;
    this.baseLevel = this._initLevel;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.selectedId = null;
    this.hoveredId = null;
    if (this._colorScheme !== this._initColorScheme) {
      this.colorScheme = this._initColorScheme;
    }
    this.resize(); // recomputes layout + renders, same as constructor
  }

  /** Export node positions as TSV string: id\tpx\tpy\tgx\tgy */
  exportLayout() {
    const lines = ['# id\tpx\tpy\tgx\tgy'];
    for (const n of this.nodes) {
      lines.push(`${n.id}\t${n.px}\t${n.py}\t${n.gx}\t${n.gy}`);
    }
    return lines.join('\n');
  }

  /** Reset button bounds (top-right corner). Returns {x, y, w, h} or null. */
  _resetBtnRect() {
    if (!this.showResetBtn) return null;
    const s = 24;
    return { x: this.W - s - 8, y: 8, w: s, h: s };
  }

  // ─── Event binding (canvas-only, no external DOM) ──────────────────────────

  _bindEvents() {
    const canvas = this.canvas;
    const sig = { signal: this._abortController.signal };

    // Mouse
    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      canvas.focus();
      this.mouseDown = true; this.mouseMoved = false;
      this.mouseStart = { x: e.clientX, y: e.clientY };
    }, sig);

    canvas.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      this._lastMouseX = mx; this._lastMouseY = my;
      if (!this.mouseDown) {
        const rb = this._resetBtnRect();
        if (rb && mx >= rb.x && mx <= rb.x + rb.w && my >= rb.y && my <= rb.y + rb.h) {
          canvas.style.cursor = 'pointer';
          return;
        }
        const hit = this.hitTest(mx, my);
        const hid = hit ? (hit.type === 'node' ? hit.item.id : hit.item.bid) : null;
        if (hid !== this.hoveredId) {
          this.hoveredId = hid;
          canvas.style.cursor = hid ? 'pointer' : 'grab';
          if (this._onHover) this._onHover(hit);
          this.render();
        }
        return;
      }
      this.pan.x += e.clientX - this.mouseStart.x;
      this.pan.y += e.clientY - this.mouseStart.y;
      this.mouseStart = { x: e.clientX, y: e.clientY };
      if (Math.abs(this.pan.x) > 4 || Math.abs(this.pan.y) > 4) this.mouseMoved = true;
      this.render();
    }, sig);

    canvas.addEventListener('mouseup', e => {
      this.mouseDown = false;
      if (e.button !== 0) return;
      if (!this.mouseMoved) {
        // Click delay: if timer pending, this is the second click — cancel it (dblclick will handle)
        if (this._clickDelay > 0 && this._clickTimer) {
          clearTimeout(this._clickTimer); this._clickTimer = null;
          return;
        }
        const r = canvas.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
        const doClick = () => {
          this._clickTimer = null;
          // Check reset button first
          const rb = this._resetBtnRect();
          if (rb && mx >= rb.x && mx <= rb.x + rb.w && my >= rb.y && my <= rb.y + rb.h) {
            this.resetView();
            return;
          }
          // FPS toggle: click in top-left 40×20 area
          if (mx < 40 && my < 20) {
            this.showFps = !this.showFps;
            this.render();
            return;
          }
          const hit = this.hitTest(mx, my);
          if (hit) {
            const id = hit.type === 'node' ? hit.item.id : hit.item.bid;
            if (isMulti) this.toggleSelection(id); else this.selectedId = id;
            if (this._onSelect) this._onSelect(hit);
          } else if (!isMulti) {
            this.selectedId = null;
            if (this._onDeselect) this._onDeselect();
          }
          this.render();
        };
        if (this._clickDelay > 0) this._clickTimer = setTimeout(doClick, this._clickDelay);
        else doClick();
      }
    }, sig);

    canvas.addEventListener('mouseleave', () => { this.mouseDown = false; }, sig);

    canvas.addEventListener('dblclick', e => {
      e.preventDefault();
      if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (e.shiftKey) {
        this._animateZoom(1/2, mx, my);
      } else {
        const hit = this.hitTest(mx, my);
        if (hit && this._onZoomToHit) this._onZoomToHit(hit);
        else if (hit) this._zoomToHit(hit);
        else this._animateZoom(2, mx, my);
      }
    }, sig);

    // Touch
    const touchPos = t => { const r = canvas.getBoundingClientRect(); return {id: t.identifier, x: t.clientX - r.left, y: t.clientY - r.top}; };
    const touchDist = (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);

    canvas.addEventListener('touchstart', e => {
      e.preventDefault(); this.touchMoved = false;
      if (e.touches.length === 1) { this.t1 = touchPos(e.touches[0]); this.t2 = null; }
      else if (e.touches.length === 2) { this.t1 = touchPos(e.touches[0]); this.t2 = touchPos(e.touches[1]); }
    }, { passive: false, signal: this._abortController.signal });

    canvas.addEventListener('touchmove', e => {
      e.preventDefault(); this.touchMoved = true;
      if (e.touches.length === 1 && !this.t2) {
        const cur = touchPos(e.touches[0]);
        if (this.t1) { this.pan.x += cur.x - this.t1.x; this.pan.y += cur.y - this.t1.y; }
        this.t1 = cur; this.render();
      } else if (e.touches.length === 2) {
        const a = touchPos(e.touches[0]), b = touchPos(e.touches[1]);
        if (this.t1 && this.t2) {
          const factor = touchDist(a, b) / (touchDist(this.t1, this.t2) || 1);
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const oldRZ = this.renderZoom;
          this.zoom = Math.max(0.25, Math.min(10000, this.zoom * factor));
          this._checkAutoLevel();
          const rf = this.renderZoom / oldRZ;
          this.pan.x = mx - (mx - this.pan.x) * rf;
          this.pan.y = my - (my - this.pan.y) * rf;
          const pmx = (this.t1.x + this.t2.x) / 2, pmy = (this.t1.y + this.t2.y) / 2;
          this.pan.x += mx - pmx; this.pan.y += my - pmy;
          this.render();
        }
        this.t1 = a; this.t2 = b;
      }
    }, { passive: false, signal: this._abortController.signal });

    canvas.addEventListener('touchend', e => {
      e.preventDefault();
      if (e.touches.length === 0) {
        if (!this.touchMoved && this.t1) {
          const hit = this.hitTest(this.t1.x, this.t1.y);
          if (hit) {
            this.selectedId = hit.type === 'node' ? hit.item.id : hit.item.bid;
            if (this._onSelect) this._onSelect(hit);
          } else {
            this.selectedId = null;
            if (this._onDeselect) this._onDeselect();
          }
          this.render();
        }
        this.t1 = null; this.t2 = null;
      } else if (e.touches.length === 1) {
        this.t1 = touchPos(e.touches[0]); this.t2 = null; this.touchMoved = true;
      }
    }, { passive: false, signal: this._abortController.signal });
    canvas.addEventListener('touchcancel', () => { this.t1 = null; this.t2 = null; }, sig);

    // Wheel zoom
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      this.wheelZoom(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0);
      this.render();
    }, { passive: false, signal: this._abortController.signal });

    // Accessibility
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-roledescription', 'interactive graph');
    canvas.setAttribute('aria-label', `Graph visualization, ${this.nodes.length} nodes`);
    // Keyboard help — insert adjacent to canvas so it works in both light DOM and shadow DOM
    const helpId = 'bz-keys-help-' + (++BitZoomCanvas._instanceCount);
    const help = document.createElement('div');
    help.id = helpId;
    help.className = 'visually-hidden';
    help.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';
    help.textContent = 'Arrows: jump to nearest node in direction. Shift+Arrows: navigate connected neighbors. N/Shift+N: walk connections by weight. Comma/period: change level. Plus/minus: zoom. Escape: deselect. Home: select largest node. F: FPS. L: legend. C: color scheme. A: accessibility debug.';
    canvas.parentNode.insertBefore(help, canvas.nextSibling);
    canvas.setAttribute('aria-describedby', helpId);
    const kbTarget = this._keyboardTarget || canvas;
    kbTarget.addEventListener('keydown', e => {
      if (this._onKeydown && this._onKeydown(e)) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowLeft' ? 'left' : 'right';
        if (e.shiftKey) this._navByDirection(dir);
        else this._navAnyByDirection(dir);
      }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); this._navStep(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._navNeighbors = null; this._navAnchorId = null; this._buildNavNeighbors(); }
      else if (e.key === 'Home') { e.preventDefault(); this._navSelectLargest(); }
      else if (e.key === ',') {
        if (this.currentLevel > 0) {
          e.preventDefault();
          if (this._onSwitchLevel) this._onSwitchLevel(this.currentLevel - 1);
          else this.switchLevel(this.currentLevel - 1);
        }
      }
      else if (e.key === '.') {
        if (this.currentLevel < LEVEL_LABELS.length - 1) {
          e.preventDefault();
          if (this._onSwitchLevel) this._onSwitchLevel(this.currentLevel + 1);
          else this.switchLevel(this.currentLevel + 1);
        }
      }
      else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        const mx = this._lastMouseX >= 0 ? this._lastMouseX : this.W / 2;
        const my = this._lastMouseY >= 0 ? this._lastMouseY : this.H / 2;
        this.wheelZoom(mx, my, true);
        this.render();
      }
      else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        const mx = this._lastMouseX >= 0 ? this._lastMouseX : this.W / 2;
        const my = this._lastMouseY >= 0 ? this._lastMouseY : this.H / 2;
        this.wheelZoom(mx, my, false);
        this.render();
      }
      else if (e.key === 'Escape') {
        this.selectedId = null;
        if (this._onDeselect) this._onDeselect();
        this.render();
      }
      else if (e.key === 'f') { this.showFps = !this.showFps; this.render(); }
      else if (e.key === 'l') { this.showLegend = (this.showLegend + 1) % 5; this.render(); }
      else if (e.key === 'c') { this.cycleColorScheme(); }
    }, sig);

    // Resize
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(canvas);
    }
  }

  /** Clean up all event listeners and observers */
  destroy() {
    this._abortController.abort();
    if (this._gl) this._destroyWebGL();
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._edgeBuildRaf) { cancelAnimationFrame(this._edgeBuildRaf); this._edgeBuildRaf = null; }
    clearTimeout(this._viewAnnounceTimer);
    clearTimeout(this._hoverAnnounceTimer);
    clearTimeout(this._crossfadeTimer);
    clearTimeout(this._clickTimer);
    if (this._crossfadeOverlay?.parentElement) this._crossfadeOverlay.parentElement.removeChild(this._crossfadeOverlay);
    const helpEl = this.canvas.getAttribute('aria-describedby');
    if (helpEl) { const el = (this.canvas.getRootNode() || document).getElementById?.(helpEl) || document.getElementById(helpEl); if (el) el.remove(); }
  }

  /**
   * Find the nearest node/supernode to a screen point. Uses spatial culling
   * at RAW_LEVEL for large datasets (same 3×3 cell approach as hitTest).
   * @returns {{ x: number, y: number } | null} world coords of nearest item
   */
  _nearestItem(sx, sy, maxScreenDist) {
    if (!this.nodes || this.nodes.length === 0) return null;
    const rz = this.renderZoom;
    const wx = (sx - this.pan.x) / rz;
    const wy = (sy - this.pan.y) / rz;
    const maxWorld = maxScreenDist / rz;
    let bestD2 = maxWorld * maxWorld;
    let bestX = 0, bestY = 0, bestId = null, found = false;

    if (this.currentLevel === RAW_LEVEL) {
      const scale = this._layoutScale;
      // Spatial culling for large datasets
      if (scale && this.nodes.length > 500) {
        const CULL_IDX = 5;
        const cullLevel = ZOOM_LEVELS[CULL_IDX];
        const px = (wx - this._layoutOffX) / scale + this._layoutMinX;
        const py = (wy - this._layoutOffY) / scale + this._layoutMinY;
        const gx = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((px + 1) / 2 * GRID_SIZE)));
        const gy = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((py + 1) / 2 * GRID_SIZE)));
        const shift = GRID_BITS - cullLevel;
        const ccx = gx >> shift, ccy = gy >> shift;
        const k = 1 << cullLevel;
        const level = this.getLevel(CULL_IDX);
        if (!level._snByBid) {
          level._snByBid = new Map();
          for (const sn of level.supernodes) level._snByBid.set(sn.bid, sn);
        }
        // Wider neighborhood (5×5) for attraction radius > cell size
        for (let dy = -2; dy <= 2; dy++) {
          const cy = ccy + dy;
          if (cy < 0 || cy >= k) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const cx = ccx + dx;
            if (cx < 0 || cx >= k) continue;
            const sn = level._snByBid.get((cx << cullLevel) | cy);
            if (!sn) continue;
            for (const n of sn.members) {
              if (n.x === undefined) continue;
              const ddx = n.x - wx, ddy = n.y - wy;
              const d2 = ddx * ddx + ddy * ddy;
              if (d2 < bestD2) { bestD2 = d2; bestX = n.x; bestY = n.y; bestId = n.id; found = true; }
            }
          }
        }
      } else {
        for (let i = 0; i < this.nodes.length; i++) {
          const n = this.nodes[i];
          if (n.x === undefined) continue;
          const ddx = n.x - wx, ddy = n.y - wy;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < bestD2) { bestD2 = d2; bestX = n.x; bestY = n.y; bestId = n.id; found = true; }
        }
      }
    } else {
      const items = this.getLevel(this.currentLevel)?.supernodes || [];
      for (let i = 0; i < items.length; i++) {
        const n = items[i];
        if (n.x === undefined) continue;
        const ddx = n.x - wx, ddy = n.y - wy;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < bestD2) { bestD2 = d2; bestX = n.x; bestY = n.y; bestId = n.bid || n.id; found = true; }
      }
    }
    return found ? { x: bestX, y: bestY, id: bestId } : null;
  }

  // ─── Keyboard node navigation ───────────────────────────────────────────────

  /** Build sorted neighbor list for the currently selected node. */
  _buildNavNeighbors() {
    const id = this._primarySelectedId;
    if (!id) { this._navNeighbors = null; this._navIndex = -1; this._navAnchorId = null; return; }
    if (id === this._navAnchorId && this._navNeighbors) return; // already built

    const isRaw = this.currentLevel === RAW_LEVEL;
    const anchor = this._findById(id);
    if (!anchor) { this._navNeighbors = null; return; }
    const ax = anchor.x, ay = anchor.y;

    // Collect neighbors with weights
    const neighbors = []; // {id, weight, item}
    if (isRaw) {
      const adj = this.adjList[id];
      if (adj) {
        for (const nid of adj) {
          const item = this.nodeIndexFull[nid];
          if (item && item.x !== undefined) neighbors.push({ id: nid, weight: 1, item });
        }
      }
    } else {
      const level = this.getLevel(this.currentLevel);
      if (level && level.snEdges) {
        if (!level._snByBid) {
          level._snByBid = new Map();
          for (const sn of level.supernodes) level._snByBid.set(sn.bid, sn);
        }
        for (const e of level.snEdges) {
          let nid = null;
          if (e.a === id) nid = e.b;
          else if (e.b === id) nid = e.a;
          if (nid !== null) {
            const item = level._snByBid.get(nid);
            if (item && item.x !== undefined) neighbors.push({ id: nid, weight: e.weight, item });
          }
        }
      }
    }

    // Compute angle from anchor to each neighbor (0° = up/12 o'clock, clockwise)
    const rz = this.renderZoom;
    for (const n of neighbors) {
      const dx = n.item.x * rz + this.pan.x - (ax * rz + this.pan.x);
      const dy = n.item.y * rz + this.pan.y - (ay * rz + this.pan.y);
      // atan2 gives angle from positive x-axis; convert to clockwise from 12 o'clock
      n.angle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    }

    // Sort: weight descending, then angle ascending (clockwise from 12)
    neighbors.sort((a, b) => b.weight - a.weight || a.angle - b.angle);

    this._navNeighbors = neighbors;
    this._navIndex = -1;
    this._navAnchorId = id;
  }

  /** Navigate to a node: select, ensure visible within 10% margin, animate if needed. */
  _navTo(item, id) {
    this.selectedId = id;
    const sx = item.x * this.renderZoom + this.pan.x;
    const sy = item.y * this.renderZoom + this.pan.y;
    const margin = 0.1;
    const left = this.W * margin, right = this.W * (1 - margin);
    const top = this.H * margin, bottom = this.H * (1 - margin);
    let dx = 0, dy = 0;
    if (sx < left) dx = left - sx;
    else if (sx > right) dx = right - sx;
    if (sy < top) dy = top - sy;
    else if (sy > bottom) dy = bottom - sy;
    if (dx === 0 && dy === 0) { this.render(); return; }
    const startPanX = this.pan.x, startPanY = this.pan.y;
    const targetPanX = startPanX + dx, targetPanY = startPanY + dy;
    const startTime = performance.now();
    const animate = (now) => {
      const t = Math.min(1, (now - startTime) / 200);
      const e = 1 - Math.pow(1 - t, 3);
      this.pan.x = startPanX + (targetPanX - startPanX) * e;
      this.pan.y = startPanY + (targetPanY - startPanY) * e;
      this.renderNow();
      if (t < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  /** Select the node nearest to the mouse cursor, or fall back to highest-degree. */
  _navSelectNearMouse() {
    if (this._lastMouseX >= 0 && this._lastMouseY >= 0) {
      const hit = this._nearestItem(this._lastMouseX, this._lastMouseY, Infinity);
      if (hit) { this._navTo(hit, hit.id); return; }
    }
    this._navSelectLargest();
  }

  /** Select the highest-degree visible node as nav entry point. */
  _navSelectLargest() {
    const isRaw = this.currentLevel === RAW_LEVEL;
    let best = null, bestScore = -1;
    if (isRaw) {
      for (const n of this.nodes) {
        if (n.x === undefined) continue;
        const sx = n.x * this.renderZoom + this.pan.x;
        const sy = n.y * this.renderZoom + this.pan.y;
        if (sx < 0 || sx > this.W || sy < 0 || sy > this.H) continue;
        if (n.degree > bestScore) { bestScore = n.degree; best = n; }
      }
      if (best) this._navTo(best, best.id);
    } else {
      const level = this.getLevel(this.currentLevel);
      if (!level) return;
      for (const sn of level.supernodes) {
        if (sn.x === undefined) continue;
        const sx = sn.x * this.renderZoom + this.pan.x;
        const sy = sn.y * this.renderZoom + this.pan.y;
        if (sx < 0 || sx > this.W || sy < 0 || sy > this.H) continue;
        const score = sn.members ? sn.members.length : 0;
        if (score > bestScore) { bestScore = score; best = sn; }
      }
      if (best) this._navTo(best, best.bid);
    }
  }

  /** Navigate by arrow direction: pick best neighbor in a ±90° cone. */
  _navByDirection(dir) {
    if (!this._primarySelectedId) { this._navSelectNearMouse(); return; }
    this._buildNavNeighbors();
    if (!this._navNeighbors || this._navNeighbors.length === 0) {
      this.announce('No connections');
      return;
    }
    // Target angles: up=0, right=90, down=180, left=270
    const targetAngle = dir === 'up' ? 0 : dir === 'right' ? 90 : dir === 'down' ? 180 : 270;
    let best = null, bestScore = Infinity;
    for (const n of this._navNeighbors) {
      let diff = Math.abs(n.angle - targetAngle);
      if (diff > 180) diff = 360 - diff;
      if (diff <= 90 && diff < bestScore) { bestScore = diff; best = n; }
    }
    if (best) {
      this._navIndex = this._navNeighbors.indexOf(best);
      this._navTo(best.item, best.id);
    }
  }

  /** Shift+Arrow: jump to nearest node/supernode in direction (any, not just connected). */
  _navAnyByDirection(dir) {
    if (!this._primarySelectedId) { this._navSelectNearMouse(); return; }
    const anchor = this._findById(this._primarySelectedId);
    const rz = this.renderZoom;
    let ax, ay;
    if (anchor && anchor.x !== undefined) {
      ax = anchor.x * rz + this.pan.x;
      ay = anchor.y * rz + this.pan.y;
    } else {
      ax = this.W / 2;
      ay = this.H / 2;
    }
    const targetAngle = dir === 'up' ? 0 : dir === 'right' ? 90 : dir === 'down' ? 180 : 270;
    const isRaw = this.currentLevel === RAW_LEVEL;
    let best = null, bestId = null, bestScore = Infinity;

    const score = (item) => {
      const sx = item.x * rz + this.pan.x;
      const sy = item.y * rz + this.pan.y;
      const dx = sx - ax, dy = sy - ay;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) return; // skip self
      const angle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
      let diff = Math.abs(angle - targetAngle);
      if (diff > 180) diff = 360 - diff;
      if (diff > 90) return; // outside cone
      // Prefer closer nodes, penalize angular offset
      const s = dist + diff * 2;
      if (s < bestScore) { bestScore = s; best = item; bestId = item.bid || item.id; }
    };

    if (isRaw) {
      for (const n of this.nodes) { if (n.x !== undefined) score(n); }
    } else {
      const level = this.getLevel(this.currentLevel);
      if (level) for (const sn of level.supernodes) { if (sn.x !== undefined) score(sn); }
    }
    if (best) {
      this._navTo(best, bestId);
    }
  }

  /** Navigate sequentially: N (step=1) or Shift+N (step=-1).
   *  Freezes the neighbor list on first N press; cycles through it on subsequent presses.
   *  List is invalidated when selection changes via any other means (click, arrow, etc.). */
  _navStep(step) {
    if (!this._primarySelectedId) { this._navSelectNearMouse(); return; }
    // Only build on first N press; subsequent presses cycle the frozen list
    if (!this._navNeighbors) {
      this._buildNavNeighbors();
    }
    if (!this._navNeighbors || this._navNeighbors.length === 0) {
      this.announce('No connections');
      return;
    }
    this._navIndex = (this._navIndex + step + this._navNeighbors.length) % this._navNeighbors.length;
    const n = this._navNeighbors[this._navIndex];
    this._navStepping = true;
    this._navTo(n.item, n.id);
    this._navStepping = false;
  }

  wheelZoom(mx, my, zoomingIn) {
    // Before zoom: prefer exact hit (cursor over circle/label), fall back to nearest
    let nearest = null, targetItem = null;
    if (zoomingIn) {
      const hit = this.hitTest(mx, my);
      if (hit) {
        const id = hit.type === 'node' ? hit.item.id : hit.item.bid;
        nearest = { x: hit.item.x, y: hit.item.y, id };
        targetItem = hit.item;
      } else {
        nearest = this._nearestItem(mx, my, 200);
        targetItem = nearest ? this._findById(nearest.id) : null;
      }
    }
    // Track zoom target so renderer shows its full label
    this.zoomTargetId = nearest ? nearest.id : null;

    // Apply zoom
    const oldRZ = this.renderZoom;
    const prevLevel = this.currentLevel;
    this.zoom = Math.max(0.25, Math.min(10000, this.zoom * (zoomingIn ? 1.03 : 1/1.03)));

    this._checkAutoLevel();

    // After level change, track the dominant (highest-degree) member from the old supernode
    if (nearest && this.currentLevel !== prevLevel && targetItem && targetItem.members) {
      let bestNode = targetItem.members[0], bestDeg = -1;
      for (const m of targetItem.members) {
        if (m.degree > bestDeg) { bestDeg = m.degree; bestNode = m; }
      }
      if (bestNode && bestNode.x !== undefined) {
        if (this.currentLevel === RAW_LEVEL) {
          nearest = { x: bestNode.x, y: bestNode.y, id: bestNode.id };
        } else {
          const level = this.getLevel(this.currentLevel);
          if (level) {
            const zl = ZOOM_LEVELS[this.currentLevel];
            const bid = cellIdAtLevel(bestNode.gx, bestNode.gy, zl);
            if (!level._snByBid) {
              level._snByBid = new Map();
              for (const sn of level.supernodes) level._snByBid.set(sn.bid, sn);
            }
            const sn = level._snByBid.get(bid);
            if (sn && sn.x !== undefined) nearest = { x: sn.x, y: sn.y, id: sn.bid };
          }
        }
        this.zoomTargetId = nearest.id;
      }
    }

    // Pan to keep cursor point fixed
    const newRZ = this.renderZoom;
    const f = newRZ / oldRZ;
    this.pan.x = mx - (mx - this.pan.x) * f;
    this.pan.y = my - (my - this.pan.y) * f;

    // Nudge nearest node toward cursor
    if (nearest) {
      const nsx = nearest.x * newRZ + this.pan.x;
      const nsy = nearest.y * newRZ + this.pan.y;
      this.pan.x += (mx - nsx) * 0.08;
      this.pan.y += (my - nsy) * 0.08;
    }
  }

  // ─── Internal animation helpers ────────────────────────────────────────────

  _animateZoom(factor, anchorX, anchorY) {
    const startPan = { x: this.pan.x, y: this.pan.y };
    const startZoom = this.zoom;
    const targetZoom = Math.max(0.25, startZoom * factor);
    const startRZ = this.renderZoom;
    const targetRZ = Math.max(1, targetZoom * Math.pow(2, this.currentLevel - this.baseLevel));
    const f = targetRZ / startRZ;
    const targetPan = { x: anchorX - (anchorX - startPan.x) * f, y: anchorY - (anchorY - startPan.y) * f };
    const startTime = performance.now();
    const animate = (now) => {
      const t = Math.min(1, (now - startTime) / 300);
      const e = 1 - Math.pow(1 - t, 3);
      this.zoom = startZoom + (targetZoom - startZoom) * e;
      this.pan.x = startPan.x + (targetPan.x - startPan.x) * e;
      this.pan.y = startPan.y + (targetPan.y - startPan.y) * e;
      this.renderNow();
      if (t < 1) requestAnimationFrame(animate);
      else { this._checkAutoLevel(); this.renderNow(); }
    };
    requestAnimationFrame(animate);
  }

  _zoomToHit(hit) {
    const item = hit.item;
    const startPan = { x: this.pan.x, y: this.pan.y };
    const startZoom = this.zoom;
    const targetZoom = startZoom * 2;
    const wp = this.worldToScreen(item.x, item.y);
    const startRZ = this.renderZoom;
    const targetRZ = Math.max(1, targetZoom * Math.pow(2, this.currentLevel - this.baseLevel));
    const f = targetRZ / startRZ;
    const targetPan = {
      x: this.W/2 - (this.W/2 - startPan.x) * f - (wp.x - this.W/2) * f,
      y: this.H/2 - (this.H/2 - startPan.y) * f - (wp.y - this.H/2) * f,
    };
    const startTime = performance.now();
    const animate = (now) => {
      const t = Math.min(1, (now - startTime) / 350);
      const e = 1 - Math.pow(1 - t, 3);
      this.zoom = startZoom + (targetZoom - startZoom) * e;
      this.pan.x = startPan.x + (targetPan.x - startPan.x) * e;
      this.pan.y = startPan.y + (targetPan.y - startPan.y) * e;
      this.renderNow();
      if (t < 1) requestAnimationFrame(animate);
      else { this._checkAutoLevel(); this.renderNow(); }
    };
    requestAnimationFrame(animate);
  }
}

// ─── Factories: create a BitZoomCanvas from data ────────────────────────────

import { runPipeline, computeProjections } from './bitzoom-pipeline.js';
import { initGPU, computeProjectionsGPU, gpuUnifiedBlend } from './bitzoom-gpu.js';

// Shared tail: strengths, colors, blend, construct view.
function _finalize(canvas, nodes, edges, nodeIndexFull, adjList, groupNames, hasEdgeTypes, opts) {
  const propStrengths = {};
  for (const g of groupNames) propStrengths[g] = g === 'group' ? 3 : g === 'label' ? 1 : 0;
  Object.assign(propStrengths, opts.strengths || opts.weights || {});

  const propColors = {};
  const propValues = {};
  for (const g of groupNames) propValues[g] = new Set();
  for (const n of nodes) {
    propValues['group'].add(n.group || 'unknown');
    propValues['label'].add(n.label || n.id);
    propValues['structure'].add(`deg:${n.degree}`);
    propValues['neighbors'].add('_');
    if (n.edgeTypes) {
      const types = Array.isArray(n.edgeTypes) ? n.edgeTypes : [...n.edgeTypes];
      for (const t of types) if (propValues['edgetype']) propValues['edgetype'].add(t);
    }
    if (n.extraProps) {
      for (const [k, v] of Object.entries(n.extraProps)) {
        if (propValues[k]) propValues[k].add(v == null ? 'unknown' : String(v));
      }
    }
  }
  for (const g of groupNames) {
    propColors[g] = generateGroupColors([...propValues[g]].sort(), opts.colorScheme || 0);
  }

  let smoothAlpha = opts.smoothAlpha || 0;
  let quantMode = opts.quantMode;

  const view = new BitZoomCanvas(canvas, {
    nodes, edges, nodeIndexFull, adjList,
    groupNames, propStrengths, propColors,
    groupColors: propColors['group'],
    hasEdgeTypes,
    smoothAlpha,
    quantMode,
    ...opts,
  });

  // Async init: probe GPU → blend → (optional auto-tune) → render.
  // Factory returns immediately; view renders once blend completes.
  const wantGPU = opts.useGPU || (opts.autoGPU !== false && nodes.length * groupNames.length > 2000);
  (async () => {
    // Probe GPU (fast no-op if unavailable or not wanted)
    if (wantGPU) {
      const ok = await initGPU().catch(() => false);
      if (ok) {
        view.useGPU = true;
        console.log(`[GPU] GPU enabled (${nodes.length} nodes, ${groupNames.length} groups)`);
      }
    }

    if (opts.autoTune) {
      // Auto-tune: scan presets + refine, then blend with best params
      view.showProgress('Auto-tuning...');
      const tuneOpts = { ...opts.autoTune };
      tuneOpts.onProgress = (info) => {
        const pct = Math.round(100 * info.step / Math.max(1, info.total));
        const phase = info.phase === 'presets' ? 'scanning presets'
          : info.phase === 'done' ? 'done' : 'refining';
        view.showProgress(`Auto-tuning: ${phase} (${pct}%)`);
      };
      const result = await autoTuneStrengths(view.nodes, view.groupNames, view.adjList, view.nodeIndexFull, tuneOpts);
      if ((tuneOpts.strengths ?? tuneOpts.weights) !== false && !opts.strengths && !opts.weights) {
        for (const g of view.groupNames) view.propStrengths[g] = result.strengths[g] ?? 0;
      }
      if (tuneOpts.alpha !== false && opts.smoothAlpha == null) view.smoothAlpha = result.alpha;
      if (tuneOpts.quant !== false && !opts.quantMode) view.quantMode = result.quantMode;
      if (result.labelProps && !opts.labelProps) {
        view.labelProps = new Set(result.labelProps.filter(p => view.groupNames.includes(p)));
      }
      view._quantStats = {};
    }

    // Blend (GPU if enabled and large enough, else CPU)
    view.levels = new Array(ZOOM_LEVELS.length).fill(null);
    await view._blend();
    view._progressText = null;
    view._refreshPropCache();
    view.layoutAll();
    view.render();
    canvas.setAttribute('aria-label', `Graph visualization, ${nodes.length} nodes, ${edges.length} edges`);
    view.announce(`Graph loaded, ${nodes.length} nodes, ${edges.length} edges. ${view._describeLevel()}`);
  })();

  return view;
}

// Hydrate nodes from projBuf + build adjList
function _hydrateAndLink(nodeArray, projBuf, groupNames, edges) {
  const G = groupNames.length;
  const nodes = nodeArray.map((n, i) => {
    const projections = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[groupNames[g]] = [projBuf[off], projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
  });
  const nodeIndexFull = Object.fromEntries(nodes.map(n => [n.id, n]));
  const adjList = Object.fromEntries(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    if (adjList[e.src] && adjList[e.dst]) {
      adjList[e.src].push(e.dst);
      adjList[e.dst].push(e.src);
    }
  }
  return { nodes, nodeIndexFull, adjList };
}

/**
 * Create a BitZoomCanvas from SNAP .edges/.nodes text.
 * @param {HTMLCanvasElement} canvas
 * @param {string} edgesText
 * @param {string|null} nodesText
 * @param {object} [opts] - additional BitZoomCanvas options
 * @returns {BitZoomCanvas}
 */
export function createBitZoomView(canvas, edgesText, nodesText, opts = {}) {
  const result = runPipeline(edgesText, nodesText);
  const { nodes, nodeIndexFull, adjList } = _hydrateAndLink(result.nodeArray, result.projBuf, result.groupNames, result.edges);
  return _finalize(canvas, nodes, result.edges, nodeIndexFull, adjList, result.groupNames, result.hasEdgeTypes, opts);
}

/**
 * Create a BitZoomCanvas from JS graph objects (no SNAP parsing).
 * Nodes: {id, group?, label?, ...extraProps}. Edges: {src, dst}.
 * @param {HTMLCanvasElement} canvas
 * @param {Array} rawNodes
 * @param {Array} rawEdges
 * @param {object} [opts] - additional BitZoomCanvas options
 * @returns {BitZoomCanvas}
 */
export function createBitZoomFromGraph(canvas, rawNodes, rawEdges, opts = {}) {
  const nodeIndex = {};
  const tempAdj = {};
  const nodeArray = rawNodes.map(rn => {
    const id = rn.id;
    const group = rn.group || 'unknown';
    const label = rn.label || id;
    const extraProps = {};
    for (const k in rn) {
      if (k !== 'id' && k !== 'group' && k !== 'label') extraProps[k] = rn[k];
    }
    const node = { id, group, label, degree: 0, edgeTypes: null, extraProps };
    nodeIndex[id] = node;
    tempAdj[id] = [];
    return node;
  });

  const edges = [];
  for (const e of rawEdges) {
    if (nodeIndex[e.src] && nodeIndex[e.dst]) {
      edges.push(e);
      nodeIndex[e.src].degree++;
      nodeIndex[e.dst].degree++;
      tempAdj[e.src].push(e.dst);
      tempAdj[e.dst].push(e.src);
    }
  }

  const extraPropNames = [];
  if (nodeArray.length > 0) {
    for (const k of Object.keys(nodeArray[0].extraProps)) extraPropNames.push(k);
  }
  const groupNames = ['group', 'label', 'structure', 'neighbors'];
  for (const ep of extraPropNames) groupNames.push(ep);

  const adjGroups = nodeArray.map(n => tempAdj[n.id].map(nid => nodeIndex[nid].group));

  const numericBins = {};
  for (const ep of extraPropNames) {
    let numCount = 0, total = 0, min = Infinity, max = -Infinity;
    for (const n of nodeArray) {
      const v = n.extraProps[ep];
      if (v == null || v === '') continue;
      total++;
      const num = Number(v);
      if (isFinite(num)) { numCount++; if (num < min) min = num; if (num > max) max = num; }
    }
    if (total > 0 && numCount / total >= 0.8 && max > min) {
      numericBins[ep] = { min, max, coarse: 5, medium: 50, fine: 500 };
    }
  }

  const { projBuf } = computeProjections(nodeArray, adjGroups, groupNames, false, extraPropNames, numericBins);
  const { nodes, nodeIndexFull, adjList } = _hydrateAndLink(nodeArray, projBuf, groupNames, edges);
  return _finalize(canvas, nodes, edges, nodeIndexFull, adjList, groupNames, false, opts);
}
