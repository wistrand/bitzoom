// bitzoom-canvas.js — Standalone embeddable BitZoom graph view.
// No sidebar, no header, no detail panel, no workers, no file loading.
// Just a canvas with pan/zoom/select/hover and the full rendering pipeline.
//
// Usage:
//   import { BitZoomCanvas } from './bitzoom-canvas.js';
//   import { runPipeline } from './bitzoom-pipeline.js';
//   import { unifiedBlend, buildLevel, ... } from './bitzoom-algo.js';
//
//   const result = runPipeline(edgesText, labelsText);
//   // ... hydrate nodes with projections, blend ...
//   const view = new BitZoomCanvas(canvasElement, { nodes, edges, ... });

import {
  MINHASH_K, GRID_SIZE, GRID_BITS, ZOOM_LEVELS, RAW_LEVEL, LEVEL_LABELS,
  buildGaussianProjection, generateGroupColors, unifiedBlend, buildLevel,
  buildLevelNodes, buildLevelEdges, cellIdAtLevel,
  getNodePropValue, getSupernodeDominantValue, maxCountKey,
} from './bitzoom-algo.js';

import { layoutAll, render, worldToScreen, screenToWorld, hitTest } from './bitzoom-renderer.js';

export class BitZoomCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {Array} opts.nodes - hydrated node objects with .projections, .px, .py, .gx, .gy, .x, .y
   * @param {Array} opts.edges - [{src, dst}, ...]
   * @param {object} opts.nodeIndexFull - {id: node}
   * @param {object} opts.adjList - {id: [neighborIds]}
   * @param {Array} opts.groupNames - property group names
   * @param {object} opts.propWeights - {groupName: weight}
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
    this.propWeights = { ...opts.propWeights } || {};
    this.propColors = opts.propColors || {};
    this.groupColors = opts.groupColors || this.propColors['group'] || {};
    this.groupRotations = {};
    this.smoothAlpha = opts.smoothAlpha || 0;
    this.maxDegree = 1;
    this.hasEdgeTypes = opts.hasEdgeTypes || false;

    // Build rotation matrices
    for (let i = 0; i < this.groupNames.length; i++) {
      this.groupRotations[this.groupNames[i]] = buildGaussianProjection(2001 + i, MINHASH_K);
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
    this.showLegend = opts.showLegend || false;
    this.showResetBtn = opts.showResetBtn || false;
    this._quantStats = {}; // fixed Gaussian boundaries — computed once, reused
    this.labelProps = new Set(opts.labelProps || []);

    // Store initial state for reset
    this._initLevel = this.currentLevel;

    // Selection
    this.selectedIds = new Set();
    this._primarySelectedId = null;
    this.hoveredId = null;

    // Callbacks
    this._onSelect = opts.onSelect || null;
    this._onHover = opts.onHover || null;

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

    if (!opts.skipEvents) this._bindEvents();
    this.resize();
  }

  // ─── Computed properties ───────────────────────────────────────────────────

  get renderZoom() {
    return Math.max(1, this.zoom * Math.pow(2, this.currentLevel - this.baseLevel));
  }

  get selectedId() { return this._primarySelectedId; }
  set selectedId(id) {
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

  get _dominantProp() { return this._cachedDominant; }
  get _labelProp() { return this._cachedLabelProps[0]; }

  _refreshPropCache() {
    let best = 'label', bestW = 0;
    for (const g of this.groupNames) {
      if ((this.propWeights[g] || 0) > bestW) { bestW = this.propWeights[g]; best = g; }
    }
    this._cachedDominant = best;
    this._cachedLabelProps = this.labelProps.size > 0 ? [...this.labelProps] : [best];
    this._cachedColorMap = this.propColors[best] || {};
    this.levels = new Array(ZOOM_LEVELS.length).fill(null);
    if (this._edgeBuildRaf) { cancelAnimationFrame(this._edgeBuildRaf); this._edgeBuildRaf = null; }
  }

  // ─── Node property accessors (used by renderer) ───────────────────────────

  _nodeLabel(n) {
    const props = this._cachedLabelProps;
    if (props.length === 1) return getNodePropValue(n, props[0], this.adjList);
    const parts = [];
    for (const p of props) {
      const v = getNodePropValue(n, p, this.adjList);
      if (v && v !== 'unknown' && v !== n.id) parts.push(v);
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
      render(this);
      this._postRender();
    });
  }

  /** Hook for post-render actions (e.g., hash state updates). */
  _postRender() { if (this._onRender) this._onRender(); }
  renderNow() { render(this); }
  worldToScreen(wx, wy) { return worldToScreen(this, wx, wy); }
  screenToWorld(sx, sy) { return screenToWorld(this, sx, sy); }
  hitTest(sx, sy) { return hitTest(this, sx, sy); }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.W = Math.floor(rect.width) || this.canvas.offsetWidth || 300;
    this.H = Math.floor(rect.height) || this.canvas.offsetHeight || 300;
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.layoutAll();
    this.render();
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  zoomForLevel(levelIdx) {
    const TARGET_PX = 44;
    const isRaw = levelIdx === RAW_LEVEL;
    const k = isRaw ? 256 : (1 << ZOOM_LEVELS[levelIdx]);
    const pad = Math.min(60, this.W * 0.08, this.H * 0.08);
    const availMin = Math.min(this.W - pad*2, this.H - pad*2);
    const targetZoom = Math.max(1, TARGET_PX / (availMin / k));
    this.pan.x = this.W/2 - (this.W/2) * targetZoom;
    this.pan.y = this.H/2 - (this.H/2) * targetZoom;
    this.zoom = targetZoom;
  }

  switchLevel(idx) {
    const oldRZ = this.renderZoom;
    this.currentLevel = idx;
    this.zoom = oldRZ / Math.pow(2, idx - this.baseLevel);
    this.selectedId = null;
    this.layoutAll();
    this.render();
  }

  _checkAutoLevel() {
    const idx = this.currentLevel;
    const maxIdx = LEVEL_LABELS.length - 1;
    if (idx < maxIdx && this.zoom >= 2) {
      this.zoom /= 2;
      this.currentLevel = idx + 1;
      this.layoutAll();
      return;
    }
    if (idx > 0 && this.zoom < 0.5) {
      this.zoom *= 2;
      this.currentLevel = idx - 1;
      this.layoutAll();
      if (this.renderZoom <= 1) this.pan = {x: 0, y: 0};
      return;
    }
    if (this.currentLevel === 0 && this.renderZoom <= 1) {
      this.pan = {x: 0, y: 0};
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Update property weights and re-blend */
  setWeights(weights) {
    Object.assign(this.propWeights, weights);
    this._refreshPropCache();
    unifiedBlend(this.nodes, this.groupNames, this.propWeights, this.smoothAlpha, this.adjList, this.nodeIndexFull, 5, this.quantMode, this._quantStats);
    this.layoutAll();
    this.render();
  }

  /** Update topology alpha and re-blend */
  setAlpha(alpha) {
    this.smoothAlpha = alpha;
    this.levels = new Array(ZOOM_LEVELS.length).fill(null);
    unifiedBlend(this.nodes, this.groupNames, this.propWeights, this.smoothAlpha, this.adjList, this.nodeIndexFull, 5, this.quantMode, this._quantStats);
    this.layoutAll();
    this.render();
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
    this.resize(); // recomputes layout + renders, same as constructor
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
      this.mouseDown = true; this.mouseMoved = false;
      this.mouseStart = { x: e.clientX, y: e.clientY };
    }, sig);

    canvas.addEventListener('mousemove', e => {
      if (!this.mouseDown) {
        const r = canvas.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
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
      if (!this.mouseMoved) {
        const r = canvas.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        // Check reset button first
        const rb = this._resetBtnRect();
        if (rb && mx >= rb.x && mx <= rb.x + rb.w && my >= rb.y && my <= rb.y + rb.h) {
          this.resetView();
          return;
        }
        const hit = this.hitTest(mx, my);
        const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
        if (hit) {
          const id = hit.type === 'node' ? hit.item.id : hit.item.bid;
          if (isMulti) this.toggleSelection(id); else this.selectedId = id;
          if (this._onSelect) this._onSelect(hit);
        } else if (!isMulti) {
          this.selectedId = null;
        }
        this.render();
      }
    }, sig);

    canvas.addEventListener('mouseleave', () => { this.mouseDown = false; }, sig);

    canvas.addEventListener('dblclick', e => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (e.shiftKey) {
        this._animateZoom(1/2, mx, my);
      } else {
        const hit = this.hitTest(mx, my);
        if (hit) this._zoomToHit(hit);
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
          if (hit) { this.selectedId = hit.type === 'node' ? hit.item.id : hit.item.bid; if (this._onSelect) this._onSelect(hit); }
          else this.selectedId = null;
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
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const factor = e.deltaY < 0 ? 1.05 : 1/1.05;
      const oldRZ = this.renderZoom;
      this.zoom = Math.max(0.25, Math.min(10000, this.zoom * factor));
      this._checkAutoLevel();
      const f = this.renderZoom / oldRZ;
      this.pan.x = mx - (mx - this.pan.x) * f;
      this.pan.y = my - (my - this.pan.y) * f;
      this.render();
    }, { passive: false, signal: this._abortController.signal });

    // Keyboard
    canvas.setAttribute('tabindex', '0'); // make focusable
    canvas.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' && this.currentLevel > 0) { e.preventDefault(); this.switchLevel(this.currentLevel - 1); }
      else if (e.key === 'ArrowRight' && this.currentLevel < LEVEL_LABELS.length - 1) { e.preventDefault(); this.switchLevel(this.currentLevel + 1); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); this._zoomBy(1.15); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); this._zoomBy(1/1.15); }
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
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._edgeBuildRaf) { cancelAnimationFrame(this._edgeBuildRaf); this._edgeBuildRaf = null; }
  }

  // ─── Internal animation helpers ────────────────────────────────────────────

  _zoomBy(factor) {
    const oldRZ = this.renderZoom;
    this.zoom = Math.max(0.25, Math.min(10000, this.zoom * factor));
    this._checkAutoLevel();
    const f = this.renderZoom / oldRZ;
    this.pan.x = this.W/2 - (this.W/2 - this.pan.x) * f;
    this.pan.y = this.H/2 - (this.H/2 - this.pan.y) * f;
    this.render();
  }

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

// ─── Helper: create a BitZoomCanvas from raw SNAP text ───────────────────────

import { runPipeline } from './bitzoom-pipeline.js';

/**
 * Convenience factory: parse SNAP data and create a ready-to-use canvas view.
 * @param {HTMLCanvasElement} canvas
 * @param {string} edgesText
 * @param {string|null} labelsText
 * @param {object} [opts] - additional BitZoomCanvas options
 * @returns {BitZoomCanvas}
 */
export function createBitZoomView(canvas, edgesText, labelsText, opts = {}) {
  const result = runPipeline(edgesText, labelsText);
  const G = result.groupNames.length;

  // Hydrate nodes with projections (signatures computed on demand, not stored)
  const nodes = result.nodeArray.map((n, i) => {
    const projections = {};
    for (let g = 0; g < G; g++) {
      const off = (i * G + g) * 2;
      projections[result.groupNames[g]] = [result.projBuf[off], result.projBuf[off + 1]];
    }
    return { ...n, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
  });

  const nodeIndexFull = Object.fromEntries(nodes.map(n => [n.id, n]));
  const adjList = Object.fromEntries(nodes.map(n => [n.id, []]));
  for (const e of result.edges) {
    if (adjList[e.src] && adjList[e.dst]) {
      adjList[e.src].push(e.dst);
      adjList[e.dst].push(e.src);
    }
  }

  // Default weights
  const propWeights = {};
  for (const g of result.groupNames) propWeights[g] = g === 'group' ? 3 : 1;
  Object.assign(propWeights, opts.weights || {});

  // Build colors
  const propColors = {};
  const propValues = {};
  for (const g of result.groupNames) propValues[g] = new Set();
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
        if (propValues[k]) propValues[k].add(v || 'unknown');
      }
    }
  }
  for (const g of result.groupNames) {
    propColors[g] = generateGroupColors([...propValues[g]].sort());
  }

  // Blend — pass a fresh stats object so the canvas gets fixed boundaries
  const quantStats = {};
  unifiedBlend(nodes, result.groupNames, propWeights, opts.smoothAlpha || 0, adjList, nodeIndexFull, 5, opts.quantMode, quantStats);

  const view = new BitZoomCanvas(canvas, {
    nodes, edges: result.edges, nodeIndexFull, adjList,
    groupNames: result.groupNames, propWeights, propColors,
    groupColors: propColors['group'],
    hasEdgeTypes: result.hasEdgeTypes,
    ...opts,
  });
  view._quantStats = quantStats;
  return view;
}
