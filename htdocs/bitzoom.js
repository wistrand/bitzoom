// bitzoom.js — BitZoom application class. State, navigation, UI, events, data loading.

import {
  MINHASH_K, GRID_SIZE, GRID_BITS, ZOOM_LEVELS, RAW_LEVEL, LEVEL_LABELS,
  buildGaussianRotation, generateGroupColors, unifiedBlend, buildLevel,
  getNodePropValue, getSupernodeDominantValue, maxCountKey,
} from './bitzoom-algo.js';

import { layoutAll, render, worldToScreen, screenToWorld, hitTest } from './bitzoom-renderer.js';

const DATASETS = [
  { name: 'Karate Club',     edges: 'data/data-graph-file.edges', labels: 'data/data-graph-file.labels', desc: '34 nodes' },
  { name: 'Epstein',         edges: 'data/epstein.edges',         labels: 'data/epstein.labels',         desc: '~100 nodes, edge types' },
  { name: 'Melker src',      edges: 'data/melker-src.edges',      labels: 'data/melker-src.labels',      desc: '305 modules' },
  { name: 'Amazon',          edges: 'data/amazon-copurchase.edges',labels: 'data/amazon-copurchase.labels',desc: '367K nodes' },
  { name: 'CERT Polska STIX',edges: 'data/cert-polska-stix.edges',labels: 'data/cert-polska-stix.labels',desc: '93 nodes, edge types' },
  { name: 'Synth Packages',  edges: 'data/synth-packages.edges',  labels: 'data/synth-packages.labels',  desc: '2K nodes' },
  { name: 'OpenCTI PAP',    edges: 'data/opencti-pap-clear.edges',labels: 'data/opencti-pap-clear.labels',desc: '107 nodes' },
  { name: 'BitZoom Source', edges: 'data/bitzoom-source.edges',  labels: 'data/bitzoom-source.labels',  desc: '147 nodes, call graph' },
  { name: 'MITRE ATT&CK',  edges: 'data/mitre-attack.edges',   labels: 'data/mitre-attack.labels',   desc: '9K nodes, kill chains' },
];

class BitZoom {
  constructor() {
    // Graph state
    this.nodes = [];
    this.edges = [];
    this.nodeIndexFull = {};
    this.adjList = {};
    this.propWeights = {};
    this.presets = {};
    this.groupNames = [];
    this.groupRotations = {};
    this.groupColors = {};
    this.propColors = {};
    this.smoothAlpha = 0;
    this.levels = [];
    this.maxDegree = 1;
    this.dataLoaded = false;
    this.hasEdgeTypes = false;

    // View state
    this.W = 0;
    this.H = 0;
    this.currentLevel = 0;
    this.pan = {x: 0, y: 0};
    this.zoom = 1;
    this.baseLevel = 0;
    this.sizeBy = 'edges';
    this.labelProp = 'auto';
    this.heatmapMode = 'density';
    this.selectedIds = new Set();  // multi-select via ctrl+click
    this._primarySelectedId = null;
    this.hoveredId = null;

    // Timers & workers
    this.rebuildTimer = null;
    this.smoothDebounceTimer = null;
    this.activeWorker = null;

    // File loader
    this.pendingEdgesText = null;
    this.pendingLabelsText = null;

    // DOM
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');

    // Input state
    this.mouseDown = false;
    this.mouseMoved = false;
    this.mouseStart = null;
    this.t1 = null;
    this.t2 = null;
    this.touchMoved = false;

    // Zoom animation target
    this._zoomTargetMembers = null;
    this._zoomTargetLabel = null;

    this._hashUpdateTimer = null;
    this._currentDatasetName = null;

    this._bindEvents();
    this._buildDatasetButtons();
  }

  // Primary selection — last clicked node. Setting clears multi-select to just this one.
  get selectedId() { return this._primarySelectedId; }
  set selectedId(id) {
    this._primarySelectedId = id;
    if (id === null) { this.selectedIds.clear(); }
    else if (!this.selectedIds.has(id)) { this.selectedIds.clear(); this.selectedIds.add(id); }
  }

  // Check if a node is in the selection set
  isSelected(id) { return this.selectedIds.has(id); }

  // Toggle selection (for ctrl+click)
  toggleSelection(id) {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      this._primarySelectedId = this.selectedIds.size > 0 ? [...this.selectedIds].pop() : null;
    } else {
      this.selectedIds.add(id);
      this._primarySelectedId = id;
    }
  }

  // ─── URL hash state ────────────────────────────────────────────────────────

  _serializeHash() {
    const parts = [];
    if (this._currentDatasetName) parts.push(`d=${encodeURIComponent(this._currentDatasetName)}`);
    parts.push(`l=${this.currentLevel}`);
    parts.push(`z=${this.zoom.toFixed(3)}`);
    parts.push(`x=${this.pan.x.toFixed(0)}`);
    parts.push(`y=${this.pan.y.toFixed(0)}`);
    parts.push(`bl=${this.baseLevel}`);
    if (this.selectedId) parts.push(`s=${encodeURIComponent(this.selectedId)}`);
    return parts.join('&');
  }

  _scheduleHashUpdate() {
    if (this._hashUpdateTimer) return;
    this._hashUpdateTimer = requestAnimationFrame(() => {
      this._hashUpdateTimer = null;
      const hash = this._serializeHash();
      if (location.hash.slice(1) !== hash) {
        history.replaceState(null, '', '#' + hash);
      }
    });
  }

  _restoreFromHash() {
    const hash = location.hash.slice(1);
    if (!hash) return null;
    const params = {};
    for (const part of hash.split('&')) {
      const [k, v] = part.split('=');
      if (k && v !== undefined) params[k] = decodeURIComponent(v);
    }
    return params;
  }

  _applyHashState(params) {
    if (!params || !this.dataLoaded) return;
    if (params.l !== undefined) this.currentLevel = parseInt(params.l) || 0;
    if (params.bl !== undefined) this.baseLevel = parseInt(params.bl) || 0;
    if (params.z !== undefined) this.zoom = parseFloat(params.z) || 1;
    if (params.x !== undefined) this.pan.x = parseFloat(params.x) || 0;
    if (params.y !== undefined) this.pan.y = parseFloat(params.y) || 0;
    if (params.s) {
      this.selectedId = params.s;
      // Show detail if node exists
      const n = this.nodeIndexFull[params.s];
      if (n) this._showDetail({ type: 'node', item: n });
    }
    this._updateStepperUI();
    this.layoutAll();
    this._updateAlgoInfo();
    this._updateOverview();
    this.render();
  }

  // ─── Computed properties ───────────────────────────────────────────────────

  get renderZoom() {
    const levelOffset = this.currentLevel - this.baseLevel;
    return Math.max(1, this.zoom * Math.pow(2, levelOffset));
  }

  // Cached dominant prop — recalculated only when weights change
  _cachedDominant = 'label';
  _cachedLabelProp = 'label';
  _cachedColorMap = null;

  _refreshPropCache() {
    let best = 'label', bestW = 0;
    for (const g of this.groupNames) {
      if ((this.propWeights[g] || 0) > bestW) {
        bestW = this.propWeights[g];
        best = g;
      }
    }
    this._cachedDominant = best;
    this._cachedLabelProp = this.labelProp === 'auto' ? best : this.labelProp;
    this._cachedColorMap = this.propColors[best] || {};
    // Invalidate level cache since colors/labels changed
    this.levels = new Array(ZOOM_LEVELS.length).fill(null);
  }

  get _dominantProp() { return this._cachedDominant; }
  get _labelProp() { return this._cachedLabelProp; }

  // ─── Node property accessors (used by renderer) ───────────────────────────

  _nodeLabel(n) { return getNodePropValue(n, this._cachedLabelProp, this.adjList); }
  _supernodeLabel(sn) { return getSupernodeDominantValue(sn, this._cachedLabelProp, this.adjList); }

  _nodeColorVal(n) { return getNodePropValue(n, this._cachedDominant, this.adjList); }
  _nodeColor(n) {
    const val = this._nodeColorVal(n);
    return this._cachedColorMap[val] || '#888888';
  }
  _supernodeColor(sn) {
    const prop = this._dominantProp;
    const counts = {};
    for (const m of sn.members) {
      const val = this._nodeColorVal(m);
      counts[val] = (counts[val] || 0) + 1;
    }
    const topVal = maxCountKey(counts);
    return (this.propColors[prop] && this.propColors[prop][topVal]) || '#888888';
  }

  // ─── Algorithm wrappers ────────────────────────────────────────────────────

  rebuildProjections() {
    this._refreshPropCache();
    unifiedBlend(this.nodes, this.groupNames, this.propWeights, this.smoothAlpha, this.adjList, this.nodeIndexFull, 5);
    this.layoutAll();
    this.render();
  }

  getLevel(idx) {
    if (!this.levels[idx]) {
      const colorProp = this._dominantProp;
      const labelProp = this._labelProp;
      const propColors = this.propColors[colorProp];
      this.levels[idx] = buildLevel(
        ZOOM_LEVELS[idx], this.nodes, this.edges, this.nodeIndexFull,
        n => getNodePropValue(n, colorProp, this.adjList),
        n => getNodePropValue(n, labelProp, this.adjList),
        val => (propColors && propColors[val]) || '#888888'
      );
      // New supernodes need screen positions computed
      this.layoutAll();
    }
    return this.levels[idx];
  }

  // ─── Layout & render delegates ─────────────────────────────────────────────

  layoutAll() { layoutAll(this); }
  render() { render(this); this._scheduleHashUpdate(); }
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
    const isRaw = levelIdx === RAW_LEVEL - 1;
    const k = isRaw ? 256 : (1 << ZOOM_LEVELS[levelIdx]);
    const pad = Math.min(60, this.W * 0.08, this.H * 0.08);
    const availMin = Math.min(this.W - pad*2, this.H - pad*2);
    const cellSizePx = availMin / k;
    const targetZoom = Math.max(1, TARGET_PX / cellSizePx);
    this.pan.x = this.W/2 - (this.W/2) * targetZoom;
    this.pan.y = this.H/2 - (this.H/2) * targetZoom;
    this.zoom = targetZoom;
  }

  switchLevel(idx) {
    // Adjust zoom so renderZoom stays the same across the level change
    const oldRZ = this.renderZoom;
    this.currentLevel = idx;
    // Solve: oldRZ = max(1, newZoom * 2^(idx - baseLevel))
    // → newZoom = oldRZ / 2^(idx - baseLevel)
    const newZoom = oldRZ / Math.pow(2, idx - this.baseLevel);
    this.zoom = newZoom;
    this._updateStepperUI();
    this.selectedId = null;
    document.getElementById('node-panel').classList.remove('open');
    this.layoutAll();
    this._updateAlgoInfo();
    this._updateOverview();
    this.render();
  }

  _animateZoom(factor, anchorX, anchorY) {
    const startPan = { x: this.pan.x, y: this.pan.y };
    const startZoom = this.zoom;
    const targetZoom = Math.max(0.25, startZoom * factor);
    const startRZ = this.renderZoom;
    const targetRZ = Math.max(1, targetZoom * Math.pow(2, this.currentLevel - this.baseLevel));
    const f = targetRZ / startRZ;
    const targetPan = {
      x: anchorX - (anchorX - startPan.x) * f,
      y: anchorY - (anchorY - startPan.y) * f,
    };
    const startTime = performance.now();
    const duration = 300;
    const animate = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      this.zoom = startZoom + (targetZoom - startZoom) * e;
      this.pan.x = startPan.x + (targetPan.x - startPan.x) * e;
      this.pan.y = startPan.y + (targetPan.y - startPan.y) * e;
      this.render();
      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        this._checkAutoLevel();
        this.render();
      }
    };
    requestAnimationFrame(animate);
  }

  zoomToNode(hit) {
    const isNode = hit.type === 'node';
    const item = hit.item;

    this._zoomTargetMembers = isNode ? [item] : item.members;
    this._zoomTargetLabel = isNode ? this._nodeLabel(item) : this._supernodeLabel(item);
    this.selectedId = isNode ? item.id : item.bid;
    // Don't open detail panel — just zoom

    const startPan = { x: this.pan.x, y: this.pan.y };
    const startZoom = this.zoom;
    const targetZoom = startZoom * 2;

    const wp = this.worldToScreen(item.x, item.y);
    const startRZ = this.renderZoom;
    const targetRZ = Math.max(1, targetZoom * Math.pow(2, this.currentLevel - this.baseLevel));
    const f = targetRZ / startRZ;
    const targetPan = {
      x: this.W / 2 - (this.W / 2 - startPan.x) * f - (wp.x - this.W / 2) * f,
      y: this.H / 2 - (this.H / 2 - startPan.y) * f - (wp.y - this.H / 2) * f,
    };

    const startTime = performance.now();
    const duration = 350;
    const animate = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      this.zoom = startZoom + (targetZoom - startZoom) * e;
      this.pan.x = startPan.x + (targetPan.x - startPan.x) * e;
      this.pan.y = startPan.y + (targetPan.y - startPan.y) * e;
      this.render();
      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        const prevLevel = this.currentLevel;
        this._checkAutoLevel();
        if (this.currentLevel !== prevLevel && this._zoomTargetMembers) {
          this._reselectAfterLevelChange();
        }
        this.render();
      }
    };
    requestAnimationFrame(animate);
  }

  _reselectAfterLevelChange() {
    if (!this._zoomTargetMembers || this._zoomTargetMembers.length === 0) return;
    const targetLabel = this._zoomTargetLabel || '';

    if (this.currentLevel === RAW_LEVEL - 1) {
      let best = this.nodeIndexFull[this._zoomTargetMembers[0].id];
      if (targetLabel) {
        for (const m of this._zoomTargetMembers) {
          const n = this.nodeIndexFull[m.id];
          if (n && this._nodeLabel(n) === targetLabel) { best = n; break; }
        }
      }
      if (best) {
        this.selectedId = best.id;
        this.layoutAll();
        this._showDetail({ type: 'node', item: best });
        this._centerOnNode(best);
      }
      return;
    }

    const level = this.getLevel(this.currentLevel);
    const memberIds = new Set(this._zoomTargetMembers.map(m => m.id));

    let bestSn = null;
    let bestScore = -1;
    for (const sn of level.supernodes) {
      let overlap = 0;
      for (const m of sn.members) {
        if (memberIds.has(m.id)) overlap++;
      }
      const snLabel = this._supernodeLabel(sn);
      const labelBonus = (targetLabel && snLabel === targetLabel) ? 10000 : 0;
      const score = labelBonus + overlap;
      if (score > bestScore) {
        bestScore = score;
        bestSn = sn;
      }
    }

    if (bestSn) {
      this.selectedId = bestSn.bid;
      this._zoomTargetMembers = bestSn.members;
      this._zoomTargetLabel = this._supernodeLabel(bestSn);
      this.layoutAll();
      this._showDetail({ type: 'supernode', item: bestSn });
      this._centerOnNode(bestSn);
    }
  }

  _centerOnNode(item) {
    const p = this.worldToScreen(item.x, item.y);
    this.pan.x += this.W / 2 - p.x;
    this.pan.y += this.H / 2 - p.y;
  }

  selectNode(id) {
    const n = this.nodeIndexFull[id];
    if (!n) return;
    this.selectedId = id;
    this.switchLevel(RAW_LEVEL - 1);
    const p = this.worldToScreen(n.x, n.y);
    this.pan.x += this.W/2 - p.x;
    this.pan.y += this.H/2 - p.y;
    this._showDetail({type:'node', item:n});
    this.render();
  }

  _checkAutoLevel() {
    const idx = this.currentLevel;
    const maxIdx = LEVEL_LABELS.length - 1;

    if (idx < maxIdx && this.zoom >= 2) {
      this.zoom /= 2;
      this.currentLevel = idx + 1;
      this._updateStepperUI();
      this.layoutAll();
      this._deferUIUpdate();
      return;
    }

    if (idx > 0 && this.zoom < 0.5) {
      this.zoom *= 2;
      this.currentLevel = idx - 1;
      this._updateStepperUI();
      this.layoutAll();
      this._deferUIUpdate();
      if (this.renderZoom <= 1) {
        this.pan = {x: 0, y: 0};
      }
      return;
    }

    if (this.currentLevel === 0 && this.renderZoom <= 1) {
      this.pan = {x: 0, y: 0};
    }
  }

  // Debounce heavy DOM updates (overview/algoInfo) to avoid thrashing during rapid zoom
  _deferUIUpdate() {
    if (this._uiUpdatePending) return;
    this._uiUpdatePending = true;
    requestAnimationFrame(() => {
      this._uiUpdatePending = false;
      this._updateAlgoInfo();
      this._updateOverview();
    });
  }

  // ─── UI updates ────────────────────────────────────────────────────────────

  _updateStepperUI() {
    const label = LEVEL_LABELS[this.currentLevel];
    const el = document.getElementById('zoomCurrent');
    if (el.textContent !== label) el.textContent = label;
    document.getElementById('zoomPrev').disabled = this.currentLevel === 0;
    document.getElementById('zoomNext').disabled = this.currentLevel === LEVEL_LABELS.length - 1;
  }

  _updateOverview() {
    const stats = document.getElementById('overview-stats');
    const isRaw = this.currentLevel === RAW_LEVEL - 1;
    if (isRaw) {
      stats.innerHTML = `
        <div class="stat-row"><span class="stat-label">Nodes</span><span class="stat-value">${this.nodes.length}</span></div>
        <div class="stat-row"><span class="stat-label">Edges</span><span class="stat-value">${this.edges.length}</span></div>
        <div class="stat-row"><span class="stat-label">MinHash k</span><span class="stat-value">${MINHASH_K}</span></div>
        <div class="stat-row"><span class="stat-label">Grid</span><span class="stat-value">${GRID_SIZE}×${GRID_SIZE}</span></div>
        <div class="stat-row"><span class="stat-label">Level</span><span class="stat-value">RAW</span></div>`;
    } else {
      const lv = this.getLevel(this.currentLevel);
      const k = 1 << ZOOM_LEVELS[this.currentLevel];
      stats.innerHTML = `
        <div class="stat-row"><span class="stat-label">Nodes</span><span class="stat-value">${this.nodes.length}</span></div>
        <div class="stat-row"><span class="stat-label">Supernodes</span><span class="stat-value">${lv.supernodes.length}</span></div>
        <div class="stat-row"><span class="stat-label">Super-edges</span><span class="stat-value">${lv.snEdges.length}</span></div>
        <div class="stat-row"><span class="stat-label">Grid k</span><span class="stat-value">${k}×${k}</span></div>
        <div class="stat-row"><span class="stat-label">Cells used</span><span class="stat-value">${lv.supernodes.length} / ${k*k}</span></div>
        <div class="stat-row"><span class="stat-label">Avg bucket</span><span class="stat-value">${(this.nodes.length/lv.supernodes.length).toFixed(1)} nodes</span></div>`;
    }
  }

  _updateAlgoInfo() {
    const isRaw = this.currentLevel === RAW_LEVEL - 1;
    const lvNum = ZOOM_LEVELS[this.currentLevel];
    const k = isRaw ? GRID_SIZE : (1 << lvNum);
    const desc = isRaw
      ? `RAW: individual nodes. MinHash(k=128) → Gaussian rotation → 2D. Grid (gx,gy) uint16.`
      : `L${lvNum}: k=${k}/axis → ${k*k} cells. Shift uint16 gx,gy right by ${GRID_BITS-lvNum} bits.`;
    document.getElementById('algo-info').textContent = desc;
  }

  _showDetail(hit) {
    const panel = document.getElementById('node-panel');
    const detail = document.getElementById('node-detail');
    panel.classList.add('open');

    if (hit.type === 'node') {
      const n = hit.item;
      const col = this._nodeColor(n);
      const nbrCount = (this.adjList[n.id] || []).length;
      let propsHtml = `
        <div class="prop-row"><div class="prop-key">Group</div><div class="prop-val">${n.group}</div></div>
        <div class="prop-row"><div class="prop-key">Label</div><div class="prop-val">${n.label}</div></div>
        <div class="prop-row"><div class="prop-key">Degree</div><div class="prop-val">${n.degree} (${nbrCount} neighbors)</div></div>`;
      if (n.edgeTypes && n.edgeTypes.size > 0) {
        propsHtml += `<div class="prop-row"><div class="prop-key">Edge types</div><div class="prop-val">${[...n.edgeTypes].join(', ')}</div></div>`;
      }
      if (n.extraProps) {
        for (const [key, val] of Object.entries(n.extraProps)) {
          if (val && val !== 'unknown') {
            propsHtml += `<div class="prop-row"><div class="prop-key">${key}</div><div class="prop-val">${val}</div></div>`;
          }
        }
      }
      const nbrIds = this.adjList[n.id] || [];
      if (nbrIds.length > 0) {
        // Group neighbors by type, sort each group by degree, show top entries
        const nbrByGroup = {};
        for (const nid of nbrIds) {
          const nb = this.nodeIndexFull[nid];
          const g = nb ? nb.group : 'unknown';
          if (!nbrByGroup[g]) nbrByGroup[g] = [];
          nbrByGroup[g].push(nb || { id: nid, group: 'unknown', degree: 0, label: nid });
        }
        // Sort groups by size descending, within each group sort by degree
        const groups = Object.entries(nbrByGroup).sort((a, b) => b[1].length - a[1].length);
        let nbrHtml = '';
        const MAX_PER_GROUP = 5;
        const MAX_GROUPS = 6;
        for (let gi = 0; gi < Math.min(groups.length, MAX_GROUPS); gi++) {
          const [gName, members] = groups[gi];
          members.sort((a, b) => b.degree - a.degree);
          const gc = this.groupColors[gName] || '#888888';
          nbrHtml += `<div style="margin-top:4px"><span class="prop-key" style="color:${gc}">${gName} (${members.length})</span></div>`;
          for (let mi = 0; mi < Math.min(members.length, MAX_PER_GROUP); mi++) {
            const nb = members[mi];
            const nc = this._nodeColor(nb);
            const label = nb.label || nb.id;
            const shortLabel = label.length > 40 ? label.slice(0, 37) + '…' : label;
            nbrHtml += `<div class="neighbor-item" onclick="bz.selectNode('${nb.id}')" style="cursor:pointer">
              <span>${shortLabel}</span>
              <span style="color:${nc};font-size:9px">deg:${nb.degree}</span>
            </div>`;
          }
          if (members.length > MAX_PER_GROUP) {
            nbrHtml += `<div class="hint">+${members.length - MAX_PER_GROUP} more</div>`;
          }
        }
        if (groups.length > MAX_GROUPS) {
          nbrHtml += `<div class="hint">+${groups.length - MAX_GROUPS} more groups</div>`;
        }
        propsHtml += `<div class="prop-row"><div class="prop-key">Linked nodes (${nbrIds.length})</div><div class="neighbor-list">${nbrHtml}</div></div>`;
      }
      detail.innerHTML = `
        <div class="node-title">${n.id}</div>
        <div class="node-badge" style="background:${col}33;color:${col};border:1px solid ${col}55">${n.group}</div>
        <div style="height:10px"></div>
        ${propsHtml}
        <div class="prop-row">
          <div class="prop-key">Grid coords</div>
          <div class="bucket-id">gx=${n.gx} gy=${n.gy} · px=${n.px.toFixed(3)} py=${n.py.toFixed(3)}</div>
        </div>
        <div class="prop-row">
          <div class="prop-key">MinHash sig (32 bits)</div>
          <div class="minhash-display">
            ${n.sig.slice(0,32).map((v,i) => {
              const bit = v % 2;
              const col2 = bit ? '#7c6af7' : '#1e1e2e';
              return `<div class="mh-bit" title="h${i}=${v}" style="background:${col2}"></div>`;
            }).join('')}
          </div>
        </div>`;
    } else {
      const sn = hit.item;
      const col = sn.cachedColor;
      const lvNum = ZOOM_LEVELS[this.currentLevel];
      const groupBreakdown = {};
      for (const m of sn.members) groupBreakdown[m.group] = (groupBreakdown[m.group]||0)+1;
      const groupRows = Object.entries(groupBreakdown).sort((a,b)=>b[1]-a[1])
        .map(([g,n]) => `<div class="neighbor-item"><span>${g}</span><span style="color:${this.groupColors[g]||'#888888'}">${n}</span></div>`).join('');

      let extraHtml = '';
      if (sn.members.length > 0 && sn.members[0].extraProps) {
        const propKeys = Object.keys(sn.members[0].extraProps);
        for (const key of propKeys) {
          const counts = {};
          for (const m of sn.members) {
            const v = m.extraProps?.[key] || 'unknown';
            counts[v] = (counts[v] || 0) + 1;
          }
          const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
          const top = sorted.slice(0, 3).map(([v, c]) => `${v} (${c})`).join(', ');
          extraHtml += `<div class="prop-row"><div class="prop-key">${key}</div><div class="prop-val">${top}</div></div>`;
        }
      }

      // Top linked supernodes from cross-cell edges
      const level = this.getLevel(this.currentLevel);
      const linkedSns = [];
      for (const e of level.snEdges) {
        if (e.a === sn.bid) linkedSns.push({ bid: e.b, weight: e.weight });
        else if (e.b === sn.bid) linkedSns.push({ bid: e.a, weight: e.weight });
      }
      linkedSns.sort((a, b) => b.weight - a.weight);
      const snMap = {};
      for (const s of level.supernodes) snMap[s.bid] = s;

      let linkedHtml = '';
      const MAX_LINKED = 8;
      for (let i = 0; i < Math.min(linkedSns.length, MAX_LINKED); i++) {
        const linked = snMap[linkedSns[i].bid];
        if (!linked) continue;
        const lc = linked.cachedColor;
        const lbl = linked.cachedLabel || linked.repName;
        const shortLbl = lbl.length > 35 ? lbl.slice(0, 32) + '…' : lbl;
        linkedHtml += `<div class="neighbor-item"><span>${shortLbl}</span><span style="color:${lc};font-size:9px">${linkedSns[i].weight} edges</span></div>`;
      }
      if (linkedSns.length > MAX_LINKED) {
        linkedHtml += `<div class="hint">+${linkedSns.length - MAX_LINKED} more</div>`;
      }

      // Top members by degree
      const topMembers = sn.members.slice().sort((a, b) => b.degree - a.degree);
      const memberList = topMembers.slice(0, 8).map(m => {
        const ml = m.label || m.id;
        const shortMl = ml.length > 35 ? ml.slice(0, 32) + '…' : ml;
        return `<div class="neighbor-item" onclick="bz.selectNode('${m.id}')" style="cursor:pointer">
          <span>${shortMl}</span>
          <span style="color:${this.groupColors[m.group]||'#888888'};font-size:9px">deg:${m.degree}</span>
        </div>`;
      }).join('') + (sn.members.length > 8 ? `<div class="hint">+${sn.members.length-8} more…</div>` : '');

      detail.innerHTML = `
        <div class="node-title" style="font-size:12px">Cell (${sn.cx}, ${sn.cy})</div>
        <div class="node-badge" style="background:${col}33;color:${col};border:1px solid ${col}55">L${lvNum} · k=${1<<lvNum}</div>
        <div style="height:10px"></div>
        <div class="prop-row"><div class="prop-key">Members</div><div class="prop-val">${sn.members.length} nodes</div></div>
        <div class="prop-row"><div class="prop-key">Avg Degree</div><div class="prop-val">${sn.avgDegree.toFixed(1)}</div></div>
        ${extraHtml}
        <div class="prop-row">
          <div class="prop-key">Group mix</div>
          <div class="neighbor-list">${groupRows}</div>
        </div>
        ${linkedSns.length > 0 ? `<div class="prop-row">
          <div class="prop-key">Linked cells (${linkedSns.length})</div>
          <div class="neighbor-list">${linkedHtml}</div>
        </div>` : ''}
        <div class="prop-row">
          <div class="prop-key">Top members</div>
          <div class="neighbor-list">${memberList}</div>
        </div>`;
    }
  }

  _buildDynamicUI() {
    const presetRow = document.getElementById('presetRow');
    presetRow.innerHTML = '';
    for (const name of Object.keys(this.presets)) {
      const btn = document.createElement('button');
      btn.className = 'preset-btn' + (name === 'balanced' ? ' active' : '');
      btn.dataset.preset = name;
      btn.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      btn.addEventListener('click', () => this._applyPreset(name));
      presetRow.appendChild(btn);
    }

    const sliderContainer = document.getElementById('weightSliders');
    sliderContainer.innerHTML = '';
    for (const key of this.groupNames) {
      const row = document.createElement('div');
      row.className = 'weight-row';
      row.innerHTML = `
        <span class="weight-label">${key}</span>
        <input class="weight-slider" type="range" id="w-${key}" min="1" max="10" step="1" value="${this.propWeights[key]}">
        <span class="weight-val" id="wv-${key}">${this.propWeights[key]}</span>`;
      sliderContainer.appendChild(row);
      row.querySelector('input').addEventListener('input', e => {
        this.propWeights[key] = parseInt(e.target.value);
        document.getElementById(`wv-${key}`).textContent = this.propWeights[key];
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        this._scheduleRebuild();
      });
    }

    // Label source selector
    const sel = document.getElementById('labelSource');
    sel.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'auto';
    sel.appendChild(autoOpt);
    for (const g of this.groupNames) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      sel.appendChild(opt);
    }
    sel.value = this.labelProp;
  }

  _scheduleRebuild() {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => { this.rebuildProjections(); this.rebuildTimer = null; }, 150);
  }

  _syncWeightUI() {
    for (const [key, val] of Object.entries(this.propWeights)) {
      const sl = document.getElementById(`w-${key}`);
      const vl = document.getElementById(`wv-${key}`);
      if (sl) { sl.value = val; vl.textContent = val; }
    }
  }

  _applyPreset(name) {
    const p = this.presets[name];
    if (!p) return;
    Object.assign(this.propWeights, p);
    this._syncWeightUI();
    document.querySelectorAll('.preset-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === name);
    });
    this._scheduleRebuild();
  }

  // ─── Data loading ──────────────────────────────────────────────────────────

  loadGraph(edgesText, labelsText) {
    return new Promise((resolve, reject) => {
      if (this.activeWorker) { this.activeWorker.terminate(); this.activeWorker = null; }
      const status = document.getElementById('loadStatus');
      const progressBar = document.getElementById('loadProgress');
      status.classList.remove('error');

      const worker = new Worker('bitzoom-worker.js', { type: 'module' });
      this.activeWorker = worker;

      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          status.textContent = msg.message;
          if (progressBar) progressBar.value = msg.pct;
          return;
        }
        if (msg.type === 'error') {
          status.textContent = 'Error: ' + msg.message;
          status.classList.add('error');
          if (progressBar) progressBar.value = 0;
          worker.terminate();
          this.activeWorker = null;
          document.querySelectorAll('.dataset-btn').forEach(b => b.disabled = false);
          reject(new Error(msg.message));
          return;
        }
        if (msg.type === 'done') {
          worker.terminate();
          this.activeWorker = null;
          try {
            this._applyWorkerResult(msg.result);
            if (progressBar) progressBar.value = 100;
            resolve();
          } catch (err) {
            status.textContent = 'Error: ' + err.message;
            status.classList.add('error');
            document.querySelectorAll('.dataset-btn').forEach(b => b.disabled = false);
            reject(err);
          }
        }
      };

      worker.onerror = (err) => {
        status.textContent = 'Worker error: ' + (err.message || 'unknown');
        status.classList.add('error');
        if (progressBar) progressBar.value = 0;
        worker.terminate();
        this.activeWorker = null;
        document.querySelectorAll('.dataset-btn').forEach(b => b.disabled = false);
        reject(err);
      };

      status.textContent = 'Starting worker...';
      if (progressBar) progressBar.value = 0;
      worker.postMessage({ edgesText, labelsText });
    });
  }

  _applyWorkerResult(result) {
    const { nodeMeta, projBuf, sigBuf, edges: workerEdges, groupNames, uniqueGroups, hasEdgeTypes: het } = result;

    this.groupNames = groupNames;
    this.hasEdgeTypes = het;

    // Build color maps for every property group
    this.propColors = {};
    const propValues = {};
    for (const g of groupNames) propValues[g] = new Set();
    for (const meta of nodeMeta) {
      propValues['group'].add(meta.group || 'unknown');
      propValues['label'].add(meta.label || meta.id);
      propValues['structure'].add(`deg:${meta.degree}`);
      propValues['neighbors'].add('_');
      if (meta.extraProps) {
        for (const [k, v] of Object.entries(meta.extraProps)) {
          if (propValues[k]) propValues[k].add(v || 'unknown');
        }
      }
      if (meta.edgeTypes) {
        const types = Array.isArray(meta.edgeTypes) ? meta.edgeTypes : [];
        for (const t of types) propValues['edgetype']?.add(t);
      }
    }
    for (const g of groupNames) {
      this.propColors[g] = generateGroupColors([...propValues[g]].sort());
    }
    this.groupColors = this.propColors['group'];

    this.groupRotations = {};
    for (let i = 0; i < this.groupNames.length; i++) {
      this.groupRotations[this.groupNames[i]] = buildGaussianRotation(2001 + i, 2, MINHASH_K);
    }

    const N = nodeMeta.length;
    const G = groupNames.length;
    this.nodes = nodeMeta.map((meta, i) => {
      const projections = {};
      for (let g = 0; g < G; g++) {
        const off = (i * G + g) * 2;
        projections[groupNames[g]] = [projBuf[off], projBuf[off + 1]];
      }
      const sigOff = i * MINHASH_K;
      const sig = Array.from(sigBuf.subarray(sigOff, sigOff + MINHASH_K));
      return { ...meta, projections, sig, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
    });

    this.nodeIndexFull = Object.fromEntries(this.nodes.map(n => [n.id, n]));
    this.edges = workerEdges;
    let md = 1;
    for (let i = 0; i < this.nodes.length; i++) { if (this.nodes[i].degree > md) md = this.nodes[i].degree; }
    this.maxDegree = md;

    this.adjList = Object.fromEntries(this.nodes.map(n => [n.id, []]));
    for (const e of this.edges) {
      if (this.adjList[e.src] && this.adjList[e.dst]) {
        this.adjList[e.src].push(e.dst);
        this.adjList[e.dst].push(e.src);
      }
    }

    this.propWeights = {};
    this.presets = { balanced: {} };
    for (const g of this.groupNames) {
      this.propWeights[g] = (g === 'group') ? 3 : 1;
      this.presets.balanced[g] = (g === 'group') ? 3 : 1;
    }
    for (const g of this.groupNames) {
      const preset = {};
      for (const g2 of this.groupNames) preset[g2] = (g2 === g) ? 8 : 1;
      this.presets[g] = preset;
    }

    this._buildDynamicUI();

    this._refreshPropCache();
    this.smoothAlpha = 0;
    document.getElementById('nudgeSlider').value = 0;
    document.getElementById('nudgeVal').textContent = '0';
    unifiedBlend(this.nodes, this.groupNames, this.propWeights, this.smoothAlpha, this.adjList, this.nodeIndexFull, 5);

    this.dataLoaded = true;
    this.selectedId = null;
    document.getElementById('node-panel').classList.remove('open');
    document.getElementById('loader-screen').classList.add('hidden');
    document.getElementById('canvas').style.display = 'block';
    document.getElementById('loadNewBtn').style.display = '';
    history.replaceState(null, '', location.pathname);

    this.currentLevel = 3; // L4
    this.baseLevel = 3;
    requestAnimationFrame(() => {
      this.resize();
      this.zoomForLevel(this.currentLevel);
      this._updateStepperUI();
      this._updateOverview();
      this._updateAlgoInfo();
    });
  }

  async loadDataset(dataset) {
    const status = document.getElementById('loadStatus');
    const progressBar = document.getElementById('loadProgress');
    status.textContent = `Fetching ${dataset.name}...`;
    status.classList.remove('error');
    progressBar.style.display = 'block';
    progressBar.value = 0;
    document.querySelectorAll('.dataset-btn').forEach(b => b.disabled = true);

    try {
      const edgesResp = await fetch(dataset.edges);
      if (!edgesResp.ok) throw new Error(`Failed to fetch ${dataset.edges}: ${edgesResp.status}`);
      const edgesText = await edgesResp.text();
      let labelsText = null;
      if (dataset.labels) {
        const labelsResp = await fetch(dataset.labels);
        if (labelsResp.ok) labelsText = await labelsResp.text();
      }
      await this.loadGraph(edgesText, labelsText);
      this._currentDatasetName = dataset.name;
      // Restore view state from hash if dataset matches
      const params = this._restoreFromHash();
      if (params && params.d === dataset.name) {
        this._applyHashState(params);
      }
      this._scheduleHashUpdate();
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
      status.classList.add('error');
      progressBar.style.display = 'none';
      document.querySelectorAll('.dataset-btn').forEach(b => b.disabled = false);
    }
  }

  showLoaderScreen() {
    if (this.activeWorker) { this.activeWorker.terminate(); this.activeWorker = null; }
    this.dataLoaded = false;
    this.pendingEdgesText = null;
    this.pendingLabelsText = null;
    document.getElementById('edgesFile').value = '';
    document.getElementById('labelsFile').value = '';
    document.getElementById('loadBtn').disabled = true;
    document.getElementById('loadStatus').textContent = '';
    document.getElementById('loadStatus').classList.remove('error');
    document.getElementById('loadProgress').style.display = 'none';
    document.getElementById('loadProgress').value = 0;
    document.getElementById('canvas').style.display = 'none';
    document.getElementById('loader-screen').classList.remove('hidden');
    document.getElementById('loadNewBtn').style.display = 'none';
    document.querySelectorAll('.dataset-btn').forEach(b => b.disabled = false);
  }

  // ─── Event binding ─────────────────────────────────────────────────────────

  _bindEvents() {
    const canvas = this.canvas;

    // Size-by toggle
    const sizeMemBtn = document.getElementById('sizeByMembers');
    const sizeEdgBtn = document.getElementById('sizeByEdges');
    const updateSizeButtons = () => {
      sizeMemBtn.style.background = this.sizeBy === 'members' ? 'var(--accent)' : '';
      sizeMemBtn.style.color = this.sizeBy === 'members' ? '#fff' : '';
      sizeEdgBtn.style.background = this.sizeBy === 'edges' ? 'var(--accent)' : '';
      sizeEdgBtn.style.color = this.sizeBy === 'edges' ? '#fff' : '';
    };
    updateSizeButtons();
    sizeMemBtn.addEventListener('click', () => { this.sizeBy = 'members'; updateSizeButtons(); this.render(); });
    sizeEdgBtn.addEventListener('click', () => { this.sizeBy = 'edges'; updateSizeButtons(); this.render(); });

    // Label source selector
    document.getElementById('labelSource').addEventListener('change', (e) => {
      this.labelProp = e.target.value;
      this._refreshPropCache();
      this.render();
    });

    // Heatmap toggle
    const heatBtn = document.getElementById('heatmapBtn');
    const HEAT_MODES = ['off', 'splat', 'density'];
    const HEAT_LABELS = { off: 'H', splat: 'H:S', density: 'H:D' };
    const updateHeatBtn = () => {
      heatBtn.textContent = HEAT_LABELS[this.heatmapMode];
      heatBtn.style.background = this.heatmapMode !== 'off' ? 'var(--accent)' : '';
      heatBtn.style.color = this.heatmapMode !== 'off' ? '#fff' : '';
    };
    updateHeatBtn();
    heatBtn.addEventListener('click', () => {
      const idx = HEAT_MODES.indexOf(this.heatmapMode);
      this.heatmapMode = HEAT_MODES[(idx + 1) % HEAT_MODES.length];
      updateHeatBtn();
      this.render();
    });

    // Sidebar
    document.getElementById('sidebarToggle').addEventListener('click', () => this._toggleSidebar());
    document.getElementById('sidebarBackdrop')?.addEventListener('click', () => this._toggleSidebar(false));
    document.getElementById('nodePanelClose').addEventListener('click', () => {
      this.selectedId = null;
      document.getElementById('node-panel').classList.remove('open');
      this.render();
    });

    // Mouse
    canvas.addEventListener('mousedown', e => {
      this.mouseDown = true; this.mouseMoved = false;
      this.mouseStart = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('mousemove', e => {
      if (!this.mouseDown) {
        const r = canvas.getBoundingClientRect();
        const p = { x: e.clientX - r.left, y: e.clientY - r.top };
        const hit = this.hitTest(p.x, p.y);
        const hid = hit ? (hit.type === 'node' ? hit.item.id : hit.item.bid) : null;
        if (hid !== this.hoveredId) { this.hoveredId = hid; canvas.style.cursor = hid ? 'pointer' : 'grab'; this.render(); }
        return;
      }
      this.pan.x += e.clientX - this.mouseStart.x;
      this.pan.y += e.clientY - this.mouseStart.y;
      this.mouseStart = { x: e.clientX, y: e.clientY };
      if (Math.abs(this.pan.x) > 4 || Math.abs(this.pan.y) > 4) this.mouseMoved = true;
      this.render();
    });
    let clickTimer = null;
    let clickCtrl = false;
    canvas.addEventListener('mouseup', e => {
      this.mouseDown = false;
      if (!this.mouseMoved) {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
        const r = canvas.getBoundingClientRect();
        const p = { x: e.clientX - r.left, y: e.clientY - r.top };
        clickCtrl = e.ctrlKey || e.metaKey;
        clickTimer = setTimeout(() => {
          clickTimer = null;
          const hit = this.hitTest(p.x, p.y);
          if (hit) {
            const id = hit.type === 'node' ? hit.item.id : hit.item.bid;
            if (clickCtrl) { this.toggleSelection(id); } else { this.selectedId = id; }
            this._showDetail(hit);
          } else if (!clickCtrl) {
            this.selectedId = null;
            document.getElementById('node-panel').classList.remove('open');
          }
          this.render();
        }, 250);
      }
    });
    canvas.addEventListener('mouseleave', () => { this.mouseDown = false; });
    canvas.addEventListener('dblclick', e => {
      e.preventDefault();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (e.shiftKey) {
        this._animateZoom(1 / 2, mx, my);
      } else {
        const hit = this.hitTest(mx, my);
        if (hit) {
          this.zoomToNode(hit);
        } else {
          this._animateZoom(2, mx, my);
        }
      }
    });

    // Touch — hoisted helpers to avoid closure allocation per event
    const _tp = {id: 0, x: 0, y: 0};
    const _tp2 = {id: 0, x: 0, y: 0};
    const touchPos = (t) => {
      const r = canvas.getBoundingClientRect();
      return {id: t.identifier, x: t.clientX - r.left, y: t.clientY - r.top};
    };
    const touchDist = (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);

    canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      this.touchMoved = false;
      if (e.touches.length === 1) { this.t1 = touchPos(e.touches[0]); this.t2 = null; }
      else if (e.touches.length === 2) { this.t1 = touchPos(e.touches[0]); this.t2 = touchPos(e.touches[1]); }
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      this.touchMoved = true;

      if (e.touches.length === 1 && !this.t2) {
        const cur = touchPos(e.touches[0]);
        if (this.t1) { this.pan.x += cur.x - this.t1.x; this.pan.y += cur.y - this.t1.y; }
        this.t1 = cur;
        this.render();
      } else if (e.touches.length === 2) {
        const a = touchPos(e.touches[0]), b = touchPos(e.touches[1]);
        if (this.t1 && this.t2) {
          const prevDist = touchDist(this.t1, this.t2);
          const curDist = touchDist(a, b);
          const factor = curDist / (prevDist || 1);
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const oldRZ = this.renderZoom;
          this.zoom = Math.max(0.25, Math.min(10000, this.zoom * factor));
          this._checkAutoLevel();
          const rf = this.renderZoom / oldRZ;
          this.pan.x = mx - (mx - this.pan.x) * rf;
          this.pan.y = my - (my - this.pan.y) * rf;
          const pmx = (this.t1.x + this.t2.x) / 2, pmy = (this.t1.y + this.t2.y) / 2;
          this.pan.x += mx - pmx;
          this.pan.y += my - pmy;
          this.render();
        }
        this.t1 = a; this.t2 = b;
      }
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
      e.preventDefault();
      if (e.touches.length === 0) {
        if (!this.touchMoved && this.t1) {
          const hit = this.hitTest(this.t1.x, this.t1.y);
          if (hit) { this.selectedId = hit.type==='node'?hit.item.id:hit.item.bid; this._showDetail(hit); }
          else { this.selectedId = null; document.getElementById('node-panel').classList.remove('open'); }
          this.render();
        }
        this.t1 = null; this.t2 = null;
      } else if (e.touches.length === 1) {
        this.t1 = touchPos(e.touches[0]); this.t2 = null; this.touchMoved = true;
      }
    }, { passive: false });
    canvas.addEventListener('touchcancel', () => { this.t1 = null; this.t2 = null; });

    // Wheel zoom
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.05 : 1/1.05;
      const oldRZ = this.renderZoom;
      this.zoom = Math.max(0.25, Math.min(10000, this.zoom * factor));
      this._checkAutoLevel();
      const newRZ = this.renderZoom;
      const f = newRZ / oldRZ;
      this.pan.x = mx - (mx - this.pan.x) * f;
      this.pan.y = my - (my - this.pan.y) * f;
      this.render();
    }, {passive: false});

    // Level stepper + keyboard
    document.getElementById('zoomPrev').addEventListener('click', () => {
      if (this.currentLevel > 0) this.switchLevel(this.currentLevel - 1);
    });
    document.getElementById('zoomNext').addEventListener('click', () => {
      if (this.currentLevel < LEVEL_LABELS.length - 1) this.switchLevel(this.currentLevel + 1);
    });
    document.getElementById('resetBtn').addEventListener('click', () => {
      this.pan = {x: 0, y: 0};
      this.zoom = 1;
      this.baseLevel = this.currentLevel;
      this.zoomForLevel(this.currentLevel);
      this.render();
    });

    window.addEventListener('keydown', e => {
      if (!this.dataLoaded) return;
      if (e.key === 'ArrowLeft' && this.currentLevel > 0) {
        e.preventDefault(); this.switchLevel(this.currentLevel - 1);
      } else if (e.key === 'ArrowRight' && this.currentLevel < LEVEL_LABELS.length - 1) {
        e.preventDefault(); this.switchLevel(this.currentLevel + 1);
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        const oldRZ = this.renderZoom;
        this.zoom = Math.min(10000, this.zoom * 1.15);
        this._checkAutoLevel();
        const f = this.renderZoom / oldRZ;
        this.pan.x = this.W/2 - (this.W/2 - this.pan.x) * f;
        this.pan.y = this.H/2 - (this.H/2 - this.pan.y) * f;
        this.render();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        const oldRZ = this.renderZoom;
        this.zoom = Math.max(0.25, this.zoom / 1.15);
        this._checkAutoLevel();
        const f = this.renderZoom / oldRZ;
        this.pan.x = this.W/2 - (this.W/2 - this.pan.x) * f;
        this.pan.y = this.H/2 - (this.H/2 - this.pan.y) * f;
        this.render();
      }
    });

    // Topology alpha slider
    document.getElementById('nudgeSlider').addEventListener('input', e => {
      if (!this.dataLoaded) return;
      this.smoothAlpha = parseFloat(e.target.value);
      document.getElementById('nudgeVal').textContent = this.smoothAlpha.toFixed(2);
      if (this.smoothDebounceTimer) clearTimeout(this.smoothDebounceTimer);
      this.smoothDebounceTimer = setTimeout(() => {
        this.levels = new Array(ZOOM_LEVELS.length).fill(null);
        unifiedBlend(this.nodes, this.groupNames, this.propWeights, this.smoothAlpha, this.adjList, this.nodeIndexFull, 5);
        this.layoutAll();
        this.render();
        this.smoothDebounceTimer = null;
      }, 120);
    });

    window.addEventListener('resize', () => { if (this.dataLoaded) this.resize(); });

    // Load button + file inputs + drop zone
    document.getElementById('loadNewBtn').addEventListener('click', () => this.showLoaderScreen());
    document.getElementById('edgesFile').addEventListener('change', e => {
      if (e.target.files[0]) this._handleFileSelect(e.target.files[0], 'edges');
    });
    document.getElementById('labelsFile').addEventListener('change', e => {
      if (e.target.files[0]) this._handleFileSelect(e.target.files[0], 'labels');
    });

    const dropZone = document.getElementById('dropZone');
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      for (const f of e.dataTransfer.files) {
        if (f.name.endsWith('.edges')) this._handleFileSelect(f, 'edges');
        else if (f.name.endsWith('.labels')) this._handleFileSelect(f, 'labels');
      }
    });

    document.getElementById('loadBtn').addEventListener('click', async () => {
      const progressBar = document.getElementById('loadProgress');
      progressBar.style.display = 'block';
      progressBar.value = 0;
      document.getElementById('loadBtn').disabled = true;
      try { await this.loadGraph(this.pendingEdgesText, this.pendingLabelsText); }
      catch (_err) { /* shown by worker handler */ }
    });
  }

  _toggleSidebar(open) {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    const isOpen = open !== undefined ? open : !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', isOpen);
    if (backdrop) backdrop.classList.toggle('open', isOpen);
  }

  _handleFileSelect(file, type) {
    const reader = new FileReader();
    reader.onload = (e) => {
      if (type === 'edges') this.pendingEdgesText = e.target.result;
      else this.pendingLabelsText = e.target.result;
      this._updateLoadStatus();
    };
    reader.readAsText(file);
  }

  _updateLoadStatus() {
    const status = document.getElementById('loadStatus');
    const parts = [];
    if (this.pendingEdgesText) parts.push('edges file ready');
    if (this.pendingLabelsText) parts.push('labels file ready');
    status.textContent = parts.length > 0 ? parts.join(' · ') : '';
    status.classList.remove('error');
    document.getElementById('loadBtn').disabled = !this.pendingEdgesText;
  }

  _buildDatasetButtons() {
    const list = document.getElementById('datasetList');
    for (const ds of DATASETS) {
      const btn = document.createElement('button');
      btn.className = 'dataset-btn';
      btn.innerHTML = `${ds.name} <span style="opacity:0.5;font-size:8px;margin-left:3px">${ds.desc}</span>`;
      btn.addEventListener('click', () => this.loadDataset(ds));
      list.appendChild(btn);
    }
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const bz = new BitZoom();
window.bz = bz; // expose for onclick handlers in dynamic HTML

// Load dataset from hash, or default
const hashParams = bz._restoreFromHash();
const hashDataset = hashParams?.d ? DATASETS.find(d => d.name === hashParams.d) : null;
const startDataset = hashDataset || DATASETS.find(d => d.name === 'Melker src');
if (startDataset) bz.loadDataset(startDataset);

// Handle browser back/forward
window.addEventListener('hashchange', () => {
  const params = bz._restoreFromHash();
  if (params && params.d === bz._currentDatasetName) {
    bz._applyHashState(params);
  } else if (params?.d) {
    const ds = DATASETS.find(d => d.name === params.d);
    if (ds) bz.loadDataset(ds);
  }
});
