// bitzoom-renderer.js — Canvas rendering, heatmaps, edge drawing, hit testing.
// Optimized to minimize GC pressure: reusable point objects, cached strings.

import { RAW_LEVEL, ZOOM_LEVELS, GRID_SIZE, GRID_BITS, cellIdAtLevel } from './bitzoom-algo.js';

// Theme-aware colors — dark vs light mode
const THEME = {
  dark: {
    grid: 'rgba(60,60,100,0.6)',
    labelBright: '#fff',
    labelHover: 'rgba(230,230,255,0.95)',
    labelNeighbor: 'rgba(210,210,245,0.8)',
    labelDim: 'rgba(220,220,255,0.85)',
    labelRawDim: 'rgba(200,200,220,0.75)',
    countFill: '#ffffffcc',
    shadowColor: 'rgba(0,0,0,0.9)',
    shadowNeighbor: 'rgba(0,0,0,0.85)',
    legendBg: 'rgba(10, 10, 15, 0.75)',
    legendText: '#c8c8d8',
    legendOverflow: '#8888a0',
    resetBg: 'rgba(10, 10, 15, 0.65)',
    resetText: '#8888a0',
    fpsFill: 'rgba(200,200,220,0.6)',
  },
  light: {
    grid: 'rgba(100,100,140,0.25)',
    labelBright: '#111',
    labelHover: 'rgba(30,30,60,0.9)',
    labelNeighbor: 'rgba(40,40,80,0.75)',
    labelDim: 'rgba(50,50,80,0.8)',
    labelRawDim: 'rgba(60,60,90,0.7)',
    countFill: 'rgba(20,20,40,0.85)',
    shadowColor: 'rgba(255,255,255,0.9)',
    shadowNeighbor: 'rgba(255,255,255,0.85)',
    legendBg: 'rgba(255, 255, 255, 0.85)',
    legendText: '#333340',
    legendOverflow: '#6a6a80',
    resetBg: 'rgba(255, 255, 255, 0.75)',
    resetText: '#6a6a80',
    fpsFill: 'rgba(60,60,80,0.6)',
  },
};
function _t(bz) { return bz._lightMode ? THEME.light : THEME.dark; }

// Adaptive edge cap: scales with visible node count to avoid clutter on dense graphs
function maxEdgesToDraw(nodeCount) {
  return Math.min(5000, Math.max(200, nodeCount * 3));
}

// ─── Reusable scratch objects (avoid per-frame allocations) ──────────────────
const _pa = {x: 0, y: 0};
const _pb = {x: 0, y: 0};
const _pt = {x: 0, y: 0};

// Hex→RGB cache to avoid parseInt in render loops
const _rgbCache = {};
function hexToRgb(hex) {
  if (_rgbCache[hex]) return _rgbCache[hex];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const result = {r, g, b};
  _rgbCache[hex] = result;
  return result;
}

// Pre-built font string cache
const _fontCache = {};
function fontStr(size, bold) {
  const key = bold ? -size : size;
  if (_fontCache[key]) return _fontCache[key];
  const s = bold ? `bold ${size}px JetBrains Mono` : `${size}px JetBrains Mono`;
  _fontCache[key] = s;
  return s;
}

// Pre-built hex alpha lookup: _hexAlpha[i] = two-char hex string for i in [0,255]
const _hexAlpha = new Array(256);
for (let i = 0; i < 256; i++) _hexAlpha[i] = i.toString(16).padStart(2, '0');

// Pre-built RGBA string cache (for common alpha values)
const _rgbaCache = {};
function rgba(r, g, b, a) {
  const key = (r << 24 | g << 16 | b << 8 | (a * 255) | 0) >>> 0;
  if (_rgbaCache[key]) return _rgbaCache[key];
  const s = `rgba(${r},${g},${b},${a})`;
  _rgbaCache[key] = s;
  return s;
}

// ─── Deterministic edge sampling ─────────────────────────────────────────────
// Hash edge index to [0,1) — stable across renders for the same edge set
function edgeHash(i) {
  let h = (i * 2654435761) >>> 0; // Knuth multiplicative hash
  return (h & 0x7fffffff) / 0x80000000;
}

// ─── Size scaling ────────────────────────────────────────────────────────────

function scaleSize(val, bz) {
  return bz.sizeLog ? Math.log2(val + 1) : val;
}

// ─── Edge drawing ────────────────────────────────────────────────────────────

let _edgeMode = 'curves';

function setEdgeMode(mode) { _edgeMode = mode; }

function drawEdge(ctx, ax, ay, bx, by) {
  if (_edgeMode === 'lines') {
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    return;
  }
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) { ctx.moveTo(ax, ay); ctx.lineTo(bx, by); return; }
  const px = -dy / len, py = dx / len;
  const c1x = ax + dx * 0.3 + px * len * 0.15;
  const c1y = ay + dy * 0.3 + py * len * 0.15;
  const c2x = ax + dx * 0.7 + px * len * 0.05;
  const c2y = ay + dy * 0.7 + py * len * 0.05;
  ctx.moveTo(ax, ay);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, bx, by);
}

// ─── Coordinate transforms (write into reusable objects) ─────────────────────

function wts(bz, wx, wy, out) {
  out.x = wx * bz.renderZoom + bz.pan.x;
  out.y = wy * bz.renderZoom + bz.pan.y;
}

// Public versions that return objects (for non-hot paths)
export function worldToScreen(bz, wx, wy) {
  return { x: wx * bz.renderZoom + bz.pan.x, y: wy * bz.renderZoom + bz.pan.y };
}

export function screenToWorld(bz, sx, sy) {
  return { x: (sx - bz.pan.x) / bz.renderZoom, y: (sy - bz.pan.y) / bz.renderZoom };
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export function layoutAll(bz) {
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;
  if (allNodes.length === 0) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const vx = n.ax !== undefined ? n.ax : n.px;
    const vy = n.ay !== undefined ? n.ay : n.py;
    if (vx < minX) minX = vx;
    if (vx > maxX) maxX = vx;
    if (vy < minY) minY = vy;
    if (vy > maxY) maxY = vy;
  }

  // Clip to ±3σ
  if (minX < -3) minX = -3;
  if (maxX > 3) maxX = 3;
  if (minY < -3) minY = -3;
  if (maxY > 3) maxY = 3;
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  // Padding: percentage of shorter dimension, capped. Heatmap glow may extend beyond (acceptable).
  const pad = Math.max(40, Math.min(100, Math.min(bz.W, bz.H) * 0.08));
  const availW = bz.W - pad * 2;
  const availH = bz.H - pad * 2;
  const scale = Math.min(availW / rangeX, availH / rangeY);
  const offsetX = pad + (availW - rangeX * scale) / 2;
  const offsetY = pad + (availH - rangeY * scale) / 2;

  // Store layout transform for inverse mapping in hitTest
  bz._layoutScale = scale;
  bz._layoutOffX = offsetX;
  bz._layoutOffY = offsetY;
  bz._layoutMinX = minX;
  bz._layoutMinY = minY;

  if (isRaw) {
    for (let i = 0; i < bz.nodes.length; i++) {
      const n = bz.nodes[i];
      const ax = Math.max(minX, Math.min(maxX, n.px));
      const ay = Math.max(minY, Math.min(maxY, n.py));
      n.x = offsetX + (ax - minX) * scale;
      n.y = offsetY + (ay - minY) * scale;
    }
  } else {
    const sns = bz.getLevel(bz.currentLevel).supernodes;
    for (let i = 0; i < sns.length; i++) {
      const sn = sns[i];
      const ax = Math.max(minX, Math.min(maxX, sn.ax));
      const ay = Math.max(minY, Math.min(maxY, sn.ay));
      sn.x = offsetX + (ax - minX) * scale;
      sn.y = offsetY + (ay - minY) * scale;
    }
  }
}

// ─── Main render ─────────────────────────────────────────────────────────────

export function render(bz) {
  const ctx = bz.ctx;
  const W = bz.W, H = bz.H;
  ctx.clearRect(0, 0, W, H);

  const glActive = !!bz._gl;
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const renderFn = isRaw ? renderNodes : renderSupernodes;

  if (!glActive) {
    // Background grid
    ctx.strokeStyle = _t(bz).grid;
    ctx.lineWidth = 0.5;
    const gridSize = 40 * bz.renderZoom;
    if (gridSize >= 4) {
      const ox = bz.pan.x % gridSize;
      const oy = bz.pan.y % gridSize;
      ctx.beginPath();
      for (let x = ox; x < W; x += gridSize) { ctx.moveTo(x,0); ctx.lineTo(x,H); }
      for (let y = oy; y < H; y += gridSize) { ctx.moveTo(0,y); ctx.lineTo(W,y); }
      ctx.stroke();
    }

    // Layer order: edges → heatmap → hilited edges → circles → labels/counts
    setEdgeMode(bz.edgeMode);
    if (bz.edgeMode !== 'none') renderFn(bz, 'edges');
    if (bz.heatmapMode === 'splat') renderHeatmapSplat(bz);
    else if (bz.heatmapMode === 'density') renderHeatmapDensity(bz);
    const savedMode = _edgeMode;
    if (_edgeMode === 'none') setEdgeMode('lines');
    renderFn(bz, 'hilite');
    setEdgeMode(savedMode);
    renderFn(bz, 'circles');
  }

  // Text overlay: labels, legend, reset — always drawn (on Canvas 2D overlay in GL mode)
  renderFn(bz, 'labels');
  if (bz.showLegend) renderLegend(bz);
  if (bz.showResetBtn) renderResetBtn(bz);
}

// ─── Supernode rendering ─────────────────────────────────────────────────────

function renderSupernodes(bz, pass) {
  const ctx = bz.ctx;
  const level = bz.getLevel(bz.currentLevel);
  const { supernodes, snEdges } = level;

  // Cached bid→supernode lookup — built once per level, reused across passes and frames
  if (!level._snByBid) {
    level._snByBid = new Map();
    for (const sn of supernodes) level._snByBid.set(sn.bid, sn);
  }
  const snMap = level._snByBid;

  const diag = Math.sqrt(bz.W * bz.W + bz.H * bz.H);
  const maxEdgeLen = diag * 1.2;
  const maxEdgeLenSq = maxEdgeLen * maxEdgeLen;
  const fadeStart = diag * 0.25;
  const fadeRange = maxEdgeLen - fadeStart;
  const rz = bz.renderZoom;

  const selIds = bz.selectedIds;
  const hasSel = selIds.size > 0;
  const hov = bz.hoveredId;
  const zoomTgt = bz.zoomTargetId;

  if (pass === 'edges') {
    // Normal edges — batched by alpha bucket to minimize beginPath/stroke calls
    const maxEdges = maxEdgesToDraw(supernodes.length);
    const snSampleRate = snEdges.length > maxEdges ? maxEdges / snEdges.length : 1;
    let snDrawn = 0;

    const ALPHA_BUCKETS = 10;
    const edgeBuckets = new Array(ALPHA_BUCKETS);
    for (let b = 0; b < ALPHA_BUCKETS; b++) edgeBuckets[b] = [];

    const fadeStartSq = fadeStart * fadeStart;
    for (let i = 0; i < snEdges.length; i++) {
      const e = snEdges[i];
      const a = snMap.get(e.a), b = snMap.get(e.b);
      if (!a || !b) continue;
      const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
      const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
      const dx = pax - pbx, dy = pay - pby;
      const distSq = dx * dx + dy * dy;
      if (distSq > maxEdgeLenSq) continue;
      if (snSampleRate < 1) {
        // Sampling bias: prefer short edges. Use distSq ratio to avoid sqrt.
        if (edgeHash(i) > snSampleRate * (2 - distSq / maxEdgeLenSq)) continue;
      }
      if (++snDrawn > maxEdges) break;
      const distFade = distSq <= fadeStartSq ? 1 : Math.max(0, 1 - (Math.sqrt(distSq) - fadeStart) / fadeRange);
      const alpha = Math.min(0.4, 0.05 + e.weight * 0.05) * distFade;
      if (alpha < 0.01) continue;
      const bucket = Math.min(ALPHA_BUCKETS - 1, (alpha / 0.4 * ALPHA_BUCKETS) | 0);
      edgeBuckets[bucket].push(pax, pay, pbx, pby);
    }

    for (let b = 0; b < ALPHA_BUCKETS; b++) {
      const coords = edgeBuckets[b];
      if (coords.length === 0) continue;
      const a = ((b + 0.5) / ALPHA_BUCKETS * 40 | 0) / 100;
      ctx.strokeStyle = rgba(124, 106, 247, a);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let j = 0; j < coords.length; j += 4) {
        drawEdge(ctx, coords[j], coords[j+1], coords[j+2], coords[j+3]);
      }
      ctx.stroke();
    }
    return;
  }

  // Shared setup for circles/labels passes
  const k = 1 << ZOOM_LEVELS[bz.currentLevel];
  const cellPx = (Math.min(bz.W, bz.H) * rz) / k;

  if (pass === 'hilite') {
    // Highlighted edges for selected + hovered nodes
    if (hasSel || hov !== null) {
      for (let i = 0; i < snEdges.length; i++) {
        const e = snEdges[i];
        const aHit = selIds.has(e.a) || e.a === hov;
        const bHit = selIds.has(e.b) || e.b === hov;
        if (!aHit && !bHit) continue;
        const a = snMap.get(e.a), b = snMap.get(e.b);
        if (!a || !b) continue;
        const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
        const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
        ctx.strokeStyle = (selIds.has(e.a) || selIds.has(e.b)) ? 'rgba(180,180,220,0.3)' : 'rgba(180,180,220,0.15)';
        ctx.lineWidth = Math.min(4, 1 + e.weight * 0.4);
        ctx.beginPath();
        drawEdge(ctx, pax, pay, pbx, pby);
        ctx.stroke();
      }
    }
    return;
  }

  // Compute visible count + max size once per frame, cache on level object.
  // Keyed by pan+zoom so it recomputes on viewport change but not across passes.
  const visKey = bz.pan.x + '|' + bz.pan.y + '|' + rz + '|' + bz.sizeBy + '|' + bz.sizeLog;
  if (level._visKey !== visKey) {
    let vc = 0, ms = 1;
    const margin = cellPx * 0.5;
    for (let i = 0; i < supernodes.length; i++) {
      const sn = supernodes[i];
      const sx = sn.x * rz + bz.pan.x, sy = sn.y * rz + bz.pan.y;
      if (sx >= -margin && sx <= bz.W + margin && sy >= -margin && sy <= bz.H + margin) {
        vc++;
        const sv = scaleSize(bz.sizeBy === 'edges' ? sn.totalDegree : sn.members.length, bz);
        if (sv > ms) ms = sv;
      }
    }
    level._visKey = visKey;
    level._visibleCount = vc;
    level._maxSizeVal = ms;
  }
  const visibleCount = level._visibleCount;
  const maxSizeVal = level._maxSizeVal;

  for (let i = 0; i < supernodes.length; i++) {
    const sn = supernodes[i];
    const px = sn.x * rz + bz.pan.x, py = sn.y * rz + bz.pan.y;
    const rMax = Math.max(1.5, Math.min(cellPx * 0.42, 40));
    if (px < -rMax || px > bz.W + rMax || py < -rMax || py > bz.H + rMax) continue;

    const rawSizeVal = bz.sizeBy === 'edges' ? sn.totalDegree : sn.members.length;
    const sizeVal = scaleSize(rawSizeVal, bz);
    const r = Math.max(1.5, Math.min(rMax, 1.5 + Math.sqrt(sizeVal) * 1.2));
    const col = sn.cachedColor;
    const isSelected = selIds.has(sn.bid);
    const isHovered = hov === sn.bid || zoomTgt === sn.bid;
    const importance = visibleCount > 50 ? 0.3 + 0.7 * Math.sqrt(sizeVal / maxSizeVal) : 1;

    if (pass === 'circles') {
      if (isSelected || isHovered) {
        const grad = ctx.createRadialGradient(px, py, 0, px, py, r * 2.5);
        grad.addColorStop(0, col + '44');
        grad.addColorStop(1, col + '00');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, r * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = col + (isSelected ? 'ff' : isHovered ? 'cc' : _hexAlpha[Math.round(importance * 0x99)]);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#fff' : col;
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.globalAlpha = isSelected || isHovered ? 1 : importance;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (pass === 'labels') {
      // Build neighbor set for highlighted nodes (once per frame, cached on level)
      // Cap to top neighbors by edge weight to avoid clutter
      if (!level._hlNeighbors || level._hlKey !== ('' + [...selIds] + '|' + hov)) {
        const maxNbr = Math.max(5, Math.min(20, Math.floor(Math.min(bz.W, bz.H) / 40)));
        const candidates = [];
        if (hasSel || hov !== null) {
          for (let j = 0; j < snEdges.length; j++) {
            const e = snEdges[j];
            if (selIds.has(e.a) || e.a === hov) candidates.push({ id: e.b, w: e.weight });
            if (selIds.has(e.b) || e.b === hov) candidates.push({ id: e.a, w: e.weight });
          }
        }
        candidates.sort((a, b) => b.w - a.w);
        const ns = new Set();
        for (let j = 0; j < Math.min(candidates.length, maxNbr); j++) ns.add(candidates[j].id);
        level._hlNeighbors = ns;
        level._hlKey = '' + [...selIds] + '|' + hov;
      }
      const isNeighbor = level._hlNeighbors.has(sn.bid);
      const isMajorNeighbor = isNeighbor && importance > 0.5;

      // Count inside node — only for highlighted nodes
      const showCount = isSelected || isHovered;
      if (showCount && cellPx >= 10 && r >= 3) {
        const fs = Math.max(7, Math.min(13, r * 1.0)) | 0;
        ctx.fillStyle = _t(bz).countFill;
        ctx.font = fontStr(fs, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(rawSizeVal, px, py);
      }

      // Label above node
      const showLabel = isSelected || isHovered || isMajorNeighbor
        || (visibleCount <= 50 && cellPx >= 20)
        || (visibleCount <= 150 && importance > 0.7 && cellPx >= 20);
      if (showLabel) {
        const rawLabel = sn.cachedLabel;
        const labelParts = rawLabel.split(' · ');
        const hasMulti = labelParts.length > 1 && bz.labelProps.has('label');
        if (isSelected || isHovered) {
          const fs = Math.max(11, Math.min(12, cellPx * 0.18)) | 0;
          ctx.font = fontStr(fs, true);
          ctx.textAlign = 'center';
          ctx.shadowColor = _t(bz).shadowColor;
          ctx.shadowBlur = 10;
          ctx.fillStyle = isSelected ? _t(bz).labelBright : _t(bz).labelHover;
          if (hasMulti) {
            ctx.textBaseline = 'bottom';
            ctx.fillText(labelParts[0], px, py - r - 3);
            ctx.textBaseline = 'top';
            ctx.fillText(labelParts.slice(1).join(' · '), px, py + r + 3);
          } else {
            ctx.textBaseline = 'bottom';
            ctx.fillText(rawLabel, px, py - r - 3);
          }
          ctx.shadowBlur = 0;
        } else if (isMajorNeighbor) {
          const fs = Math.max(10, Math.min(12, cellPx * 0.18)) | 0;
          const maxChars = 20;
          ctx.font = fontStr(fs, false);
          ctx.textAlign = 'center';
          ctx.shadowColor = _t(bz).shadowNeighbor;
          ctx.shadowBlur = 10;
          ctx.fillStyle = _t(bz).labelNeighbor;
          if (hasMulti) {
            const name = labelParts[0].length > maxChars ? labelParts[0].slice(0, maxChars - 1) + '…' : labelParts[0];
            ctx.textBaseline = 'bottom';
            ctx.fillText(name, px, py - r - 3);
            const rest = labelParts.slice(1).join(' · ');
            const restTrunc = rest.length > maxChars ? rest.slice(0, maxChars - 1) + '…' : rest;
            ctx.textBaseline = 'top';
            ctx.fillText(restTrunc, px, py + r + 3);
          } else {
            const label = rawLabel.length > maxChars ? rawLabel.slice(0, maxChars - 1) + '…' : rawLabel;
            ctx.textBaseline = 'bottom';
            ctx.fillText(label, px, py - r - 3);
          }
          ctx.shadowBlur = 0;
        } else {
          const fs = Math.max(10, Math.min(13, cellPx * 0.18)) | 0;
          const charW = fs * 0.6;
          const snappedCellPx = Math.round(cellPx / 4) * 4;
          const maxChars = Math.max(3, (snappedCellPx / charW) | 0);
          ctx.fillStyle = _t(bz).labelDim;
          ctx.font = fontStr(fs, false);
          ctx.textAlign = 'center';
          if (hasMulti) {
            const name = labelParts[0].length > maxChars ? labelParts[0].slice(0, maxChars - 1) + '…' : labelParts[0];
            ctx.textBaseline = 'bottom';
            ctx.fillText(name, px, py - r - 3);
            const rest = labelParts.slice(1).join(' · ');
            const restTrunc = rest.length > maxChars ? rest.slice(0, maxChars - 1) + '…' : rest;
            ctx.textBaseline = 'top';
            ctx.fillText(restTrunc, px, py + r + 3);
          } else {
            const label = rawLabel.length > maxChars ? rawLabel.slice(0, maxChars - 1) + '…' : rawLabel;
            ctx.textBaseline = 'bottom';
            ctx.fillText(label, px, py - r - 3);
          }
        }
      }
    }
  }
}

// ─── Raw node rendering ──────────────────────────────────────────────────────

function renderNodes(bz, pass) {
  const ctx = bz.ctx;
  const rz = bz.renderZoom;
  const cellPxRaw = (Math.min(bz.W, bz.H) * rz) / 256;

  const diag = Math.sqrt(bz.W * bz.W + bz.H * bz.H);
  const maxEdgeLen = diag * 1.2;
  const maxEdgeLenSq = maxEdgeLen * maxEdgeLen;
  const fadeStart = diag * 0.25;
  const fadeRange = maxEdgeLen - fadeStart;

  const selIds = bz.selectedIds;
  const hasSel = selIds.size > 0;
  const hov = bz.hoveredId;
  const zoomTgt = bz.zoomTargetId;

  if (pass === 'edges') {
    // Normal edges — drawn behind heatmap
    const maxEdges = maxEdgesToDraw(bz.nodes.length);
    const rawSampleRate = bz.edges.length > maxEdges ? maxEdges / bz.edges.length : 1;
    let rawDrawn = 0;

    const ALPHA_BUCKETS = 10;
    const edgeBuckets = new Array(ALPHA_BUCKETS);
    for (let b = 0; b < ALPHA_BUCKETS; b++) edgeBuckets[b] = [];

    const fadeStartSq = fadeStart * fadeStart;
    for (let i = 0; i < bz.edges.length; i++) {
      const e = bz.edges[i];
      const a = bz.nodeIndexFull[e.src], b = bz.nodeIndexFull[e.dst];
      if (!a || !b) continue;
      const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
      const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
      const dx = pax - pbx, dy = pay - pby;
      const distSq = dx * dx + dy * dy;
      if (distSq > maxEdgeLenSq) continue;
      if (rawSampleRate < 1) {
        if (edgeHash(i) > rawSampleRate * (2 - distSq / maxEdgeLenSq)) continue;
      }
      if (++rawDrawn > maxEdges) break;
      const distFade = distSq <= fadeStartSq ? 1 : Math.max(0, 1 - (Math.sqrt(distSq) - fadeStart) / fadeRange);
      const alpha = 0.25 * distFade;
      if (alpha < 0.01) continue;
      const bucket = Math.min(ALPHA_BUCKETS - 1, (alpha / 0.25 * ALPHA_BUCKETS) | 0);
      edgeBuckets[bucket].push(pax, pay, pbx, pby);
    }

    ctx.lineWidth = 0.8;
    for (let b = 0; b < ALPHA_BUCKETS; b++) {
      const coords = edgeBuckets[b];
      if (coords.length === 0) continue;
      const a = ((b + 0.5) / ALPHA_BUCKETS * 25 | 0) / 100;
      ctx.strokeStyle = rgba(100, 100, 140, a);
      ctx.beginPath();
      for (let j = 0; j < coords.length; j += 4) {
        drawEdge(ctx, coords[j], coords[j+1], coords[j+2], coords[j+3]);
      }
      ctx.stroke();
    }
    return;
  }

  if (pass === 'hilite') {
    // Highlighted edges for selected + hovered nodes
    if (hasSel || hov !== null) {
      for (let i = 0; i < bz.edges.length; i++) {
        const e = bz.edges[i];
        const aHit = selIds.has(e.src) || e.src === hov;
        const bHit = selIds.has(e.dst) || e.dst === hov;
        if (!aHit && !bHit) continue;
        const a = bz.nodeIndexFull[e.src], b = bz.nodeIndexFull[e.dst];
        if (!a || !b) continue;
        const pax = a.x * rz + bz.pan.x, pay = a.y * rz + bz.pan.y;
        const pbx = b.x * rz + bz.pan.x, pby = b.y * rz + bz.pan.y;
        ctx.strokeStyle = (selIds.has(e.src) || selIds.has(e.dst)) ? 'rgba(180,180,220,0.3)' : 'rgba(180,180,220,0.15)';
        ctx.lineWidth = (selIds.has(e.src) || selIds.has(e.dst)) ? 1.5 : 1;
        ctx.beginPath();
        drawEdge(ctx, pax, pay, pbx, pby);
        ctx.stroke();
      }
    }
    return;
  }

  // Shared node loop for 'circles' and 'labels' passes
  for (let i = 0; i < bz.nodes.length; i++) {
    const n = bz.nodes[i];
    const px = n.x * rz + bz.pan.x, py = n.y * rz + bz.pan.y;
    const rMaxRaw = Math.max(1, Math.min(cellPxRaw * 0.40, 20));
    if (px < -rMaxRaw || px > bz.W + rMaxRaw || py < -rMaxRaw || py > bz.H + rMaxRaw) continue;

    const sizeVal = scaleSize(bz.sizeBy === 'edges' ? n.degree : 1, bz);
    const r = Math.max(1, Math.min(rMaxRaw, 1 + Math.sqrt(sizeVal) * 1.0));
    const col = bz._nodeColor(n);
    const isSelected = selIds.has(n.id);
    const isHovered = hov === n.id || zoomTgt === n.id;

    if (pass === 'circles') {
      if (isSelected || isHovered) {
        const grad = ctx.createRadialGradient(px, py, 0, px, py, r*3);
        grad.addColorStop(0, col+'66');
        grad.addColorStop(1, col+'00');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, r*3, 0, Math.PI*2);
        ctx.fill();
      }

      ctx.fillStyle = col + (isSelected ? 'ff' : 'bb');
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI*2);
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    if (pass === 'labels') {
      // Build neighbor set for highlighted raw nodes (once per frame, capped)
      if (!bz._rawHlNeighbors || bz._rawHlKey !== ('' + [...selIds] + '|' + hov)) {
        const maxNbr = Math.max(5, Math.min(20, Math.floor(Math.min(bz.W, bz.H) / 40)));
        const seen = {};
        if (hasSel || hov !== null) {
          for (let j = 0; j < bz.edges.length; j++) {
            const e = bz.edges[j];
            if (selIds.has(e.src) || e.src === hov) seen[e.dst] = (seen[e.dst] || 0) + 1;
            if (selIds.has(e.dst) || e.dst === hov) seen[e.src] = (seen[e.src] || 0) + 1;
          }
        }
        const sorted = Object.keys(seen).sort((a, b) => seen[b] - seen[a]);
        const ns = new Set(sorted.slice(0, maxNbr));
        bz._rawHlNeighbors = ns;
        bz._rawHlKey = '' + [...selIds] + '|' + hov;
      }
      const isNeighbor = bz._rawHlNeighbors.has(n.id);
      const isMajorNeighbor = isNeighbor && n.degree >= 3;

      if (isSelected || isHovered || isMajorNeighbor || cellPxRaw >= 14) {
        const rawLabel = bz._nodeLabel(n);
        if (isSelected || isHovered) {
          const fs = Math.max(11, Math.min(12, cellPxRaw * 0.22)) | 0;
          ctx.fillStyle = isSelected ? '#fff' : 'rgba(230,230,255,0.95)';
          ctx.font = fontStr(fs, true);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(rawLabel, px + r + 3, py);
        } else {
          const fs = Math.max(10, Math.min(13, cellPxRaw * 0.22)) | 0;
          const charW = fs * 0.6;
          const maxChars = Math.max(4, ((cellPxRaw * 0.8) / charW) | 0);
          const text = rawLabel.length > maxChars ? rawLabel.slice(0, maxChars - 1) + '…' : rawLabel;
          ctx.fillStyle = _t(bz).labelRawDim;
          ctx.font = fontStr(fs, false);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, px + r + 3, py);
        }
      }
    }
  }
}

// ─── Heatmap: Gaussian splat ─────────────────────────────────────────────────

function renderHeatmapSplat(bz) {
  const ctx = bz.ctx;
  const W = bz.W, H = bz.H;
  const rz = bz.renderZoom;
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;

  const light = bz._lightMode;
  ctx.save();
  if (light) {
    // Light mode: source-over with higher alpha — splats colorize the light background
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.5;
  } else {
    // Dark mode: additive blending — splats brighten the dark background
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6;
  }

  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const px = n.x * rz + bz.pan.x, py = n.y * rz + bz.pan.y;
    const maxR = isRaw ? 200 : 400;
    if (px < -maxR || px > W + maxR || py < -maxR || py > H + maxR) continue;

    let weight;
    if (isRaw) {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.degree + 1) : 1, bz);
    } else {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.totalDegree + 1) : n.members.length, bz);
    }
    const r = Math.max(50, Math.min(maxR, 50 + Math.sqrt(weight) * 25));

    const hexCol = isRaw ? bz._nodeColor(n) : n.cachedColor;
    const rgb = hexToRgb(hexCol);

    const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
    if (light) {
      // Stronger center alpha, saturated color on light background
      grad.addColorStop(0, rgba(rgb.r, rgb.g, rgb.b, 0.4));
      grad.addColorStop(0.5, rgba(rgb.r, rgb.g, rgb.b, 0.15));
      grad.addColorStop(1, rgba(rgb.r, rgb.g, rgb.b, 0));
    } else {
      grad.addColorStop(0, rgba(rgb.r, rgb.g, rgb.b, 0.25));
      grad.addColorStop(0.5, rgba(rgb.r, rgb.g, rgb.b, 0.08));
      grad.addColorStop(1, rgba(rgb.r, rgb.g, rgb.b, 0));
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ─── Heatmap: Kernel density ─────────────────────────────────────────────────

// Persistent buffers — reused across frames to avoid GC
let _densityGw = 0, _densityGh = 0;
let _densityR = null, _densityG = null, _densityB = null, _densityW = null;
let _densityImgData = null;
let _densityCanvas = null;

// Cached maxW — recomputed when level/zoom/sizeBy/sizeLog or instance change, stable across pan.
// Lerped toward target over ~500ms to avoid jarring jumps on level change.
let _densityMaxW = 0;
let _densityMaxWTarget = 0;
let _densityMaxWKey = '';
let _densityMaxWTime = 0;
let _densityNextId = 0; // monotonic counter for assigning instance IDs
let _densityLastId = 0; // last-seen instance ID for snap detection

function _densityCacheKey(bz) {
  if (!bz._densityId) bz._densityId = ++_densityNextId;
  return bz._densityId + '|' + bz.currentLevel + '|' + bz.renderZoom.toFixed(1) + '|' + bz.sizeBy + '|' + bz.sizeLog + '|' + bz.W + '|' + bz.H;
}

function renderHeatmapDensity(bz) {
  const W = bz.W, H = bz.H;
  const rz = bz.renderZoom;
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;

  const scale = 4;
  const gw = Math.ceil(W / scale);
  const gh = Math.ceil(H / scale);
  const totalCells = gw * gh;

  // Reallocate buffers only when grid size changes
  if (gw !== _densityGw || gh !== _densityGh) {
    _densityGw = gw;
    _densityGh = gh;
    _densityR = new Float32Array(totalCells);
    _densityG = new Float32Array(totalCells);
    _densityB = new Float32Array(totalCells);
    _densityW = new Float32Array(totalCells);
    _densityImgData = new ImageData(gw, gh);
    _densityCanvas = new OffscreenCanvas(gw, gh);
  }

  // Clear buffers
  _densityR.fill(0);
  _densityG.fill(0);
  _densityB.fill(0);
  _densityW.fill(0);

  const kernelR = Math.max(8, Math.min(40, Math.min(gw, gh) / 8));
  const kernelRSq = kernelR * kernelR;

  // Check if maxW needs recomputing (level, zoom, size config, or viewport size changed)
  const cacheKey = _densityCacheKey(bz);
  const needMaxW = cacheKey !== _densityMaxWKey;

  for (let i = 0; i < allNodes.length; i++) {
    const n = allNodes[i];
    const gx = (n.x * rz + bz.pan.x) / scale;
    const gy = (n.y * rz + bz.pan.y) / scale;

    if (gx < -kernelR || gx > gw + kernelR || gy < -kernelR || gy > gh + kernelR) continue;

    let weight;
    if (isRaw) {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.degree + 1) : 1, bz);
    } else {
      weight = scaleSize(bz.sizeBy === 'edges' ? (n.totalDegree + 1) : n.members.length, bz);
    }

    const hexCol = isRaw ? bz._nodeColor(n) : n.cachedColor;
    const rgb = hexToRgb(hexCol);

    const x0 = Math.max(0, gx - kernelR | 0);
    const x1 = Math.min(gw - 1, gx + kernelR + 1 | 0);
    const y0 = Math.max(0, gy - kernelR | 0);
    const y1 = Math.min(gh - 1, gy + kernelR + 1 | 0);

    for (let cy = y0; cy <= y1; cy++) {
      const dy = cy - gy;
      const dySq = dy * dy;
      const rowOff = cy * gw;
      for (let cx = x0; cx <= x1; cx++) {
        const dx = cx - gx;
        const distSq = dx * dx + dySq;
        if (distSq > kernelRSq) continue;
        const t = 1 - distSq / kernelRSq;
        const k = t * t * weight;
        const idx = rowOff + cx;
        _densityR[idx] += rgb.r * k;
        _densityG[idx] += rgb.g * k;
        _densityB[idx] += rgb.b * k;
        _densityW[idx] += k;
      }
    }
  }

  // Compute maxW from current frame when config changes; lerp toward it for smooth transitions
  if (needMaxW) {
    let maxW = 0;
    for (let i = 0; i < totalCells; i++) if (_densityW[i] > maxW) maxW = _densityW[i];
    _densityMaxWTarget = maxW;
    _densityMaxWKey = cacheKey;
    _densityMaxWTime = performance.now();
    const newInstance = bz._densityId !== _densityLastId;
    _densityLastId = bz._densityId;
    if (_densityMaxW === 0 || newInstance) _densityMaxW = maxW; // new instance or first frame: snap
  }

  // Exponential lerp toward target (~500ms to 90% convergence)
  const dt = performance.now() - _densityMaxWTime;
  const alpha = 1 - Math.exp(-dt / 200); // time constant 200ms
  _densityMaxW += (_densityMaxWTarget - _densityMaxW) * alpha;
  _densityMaxWTime = performance.now();

  if (_densityMaxW < 0.001) return;

  const px = _densityImgData.data;
  const invThreshold = 1 / (_densityMaxW * 0.3);
  const light = bz._lightMode;
  for (let i = 0; i < totalCells; i++) {
    const w = _densityW[i];
    if (w < 0.001) { px[i*4+3] = 0; continue; }
    const intensity = Math.min(1, w * invThreshold);
    const invW = intensity / w;
    const off = i * 4;
    // Average color weighted by intensity
    const cr = Math.min(255, _densityR[i] * invW + 0.5 | 0);
    const cg = Math.min(255, _densityG[i] * invW + 0.5 | 0);
    const cb = Math.min(255, _densityB[i] * invW + 0.5 | 0);
    if (light) {
      // Light mode: lerp from white (bg) toward color. Dense = saturated color.
      px[off]     = 255 - (255 - cr) * intensity + 0.5 | 0;
      px[off + 1] = 255 - (255 - cg) * intensity + 0.5 | 0;
      px[off + 2] = 255 - (255 - cb) * intensity + 0.5 | 0;
      px[off + 3] = Math.min(255, intensity * 220 + 0.5 | 0);
    } else {
      // Dark mode: color scaled by intensity
      px[off]     = cr;
      px[off + 1] = cg;
      px[off + 2] = cb;
      px[off + 3] = Math.min(255, intensity * 180 + 0.5 | 0);
    }
  }

  const octx = _densityCanvas.getContext('2d');
  octx.putImageData(_densityImgData, 0, 0);
  bz.ctx.save();
  bz.ctx.imageSmoothingEnabled = true;
  bz.ctx.imageSmoothingQuality = 'high';
  bz.ctx.drawImage(_densityCanvas, 0, 0, W, H);
  bz.ctx.restore();

  // Keep rendering while lerp hasn't converged (>1% difference)
  if (Math.abs(_densityMaxW - _densityMaxWTarget) > _densityMaxWTarget * 0.01) {
    bz.render();
  }
}

// ─── Legend (compact, canvas-drawn) ──────────────────────────────────────────

function renderLegend(bz) {
  const colorMap = bz._cachedColorMap;
  if (!colorMap) return;
  const allEntries = Object.entries(colorMap);
  if (allEntries.length === 0) return;

  // Sort by frequency in current data
  const isRaw = bz.currentLevel === RAW_LEVEL;
  const allNodes = isRaw ? bz.nodes : bz.getLevel(bz.currentLevel).supernodes;
  const counts = {};
  for (const n of allNodes) {
    const val = isRaw ? bz._nodeColorVal(n) : (n.cachedColorVal || '');
    counts[val] = (counts[val] || 0) + 1;
  }
  allEntries.sort((a, b) => (counts[b[0]] || 0) - (counts[a[0]] || 0));

  const MAX_ENTRIES = 12;
  const entries = allEntries.slice(0, MAX_ENTRIES);
  const overflow = allEntries.length - entries.length;

  const ctx = bz.ctx;
  const fontSize = 10;
  const dotR = 4;
  const lineH = 16;
  const pad = 8;
  const maxLabelW = 90;

  // Measure label widths
  ctx.font = `${fontSize}px JetBrains Mono, monospace`;
  let maxW = 0;
  for (const [label] of entries) {
    const w = ctx.measureText(label.length > 14 ? label.slice(0, 13) + '…' : label).width;
    if (w > maxW) maxW = w;
  }
  maxW = Math.min(maxW, maxLabelW);

  const headerText = bz._cachedDominant.toUpperCase();
  ctx.font = `bold 8px JetBrains Mono, monospace`;
  const headerW = ctx.measureText(headerText).width;
  const headerH = 14;

  const lines = entries.length + (overflow > 0 ? 1 : 0);
  const boxW = Math.max(dotR * 2 + 6 + maxW, headerW) + pad * 2;
  const boxH = headerH + lines * lineH + pad * 2;
  const margin = 8;
  const pos = bz.showLegend || 1; // 1=BR, 2=BL, 3=TL, 4=TR
  const x = (pos === 2 || pos === 3) ? margin : bz.W - boxW - margin;
  const y = (pos === 3 || pos === 4) ? margin : bz.H - boxH - margin;

  // Background
  ctx.fillStyle = _t(bz).legendBg;
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 4);
  ctx.fill();

  // Header
  ctx.fillStyle = _t(bz).legendOverflow;
  ctx.font = 'bold 8px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(headerText, x + pad, y + pad);

  // Entries
  for (let i = 0; i < entries.length; i++) {
    const [label, color] = entries[i];
    const ey = y + pad + headerH + i * lineH + lineH / 2;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + pad + dotR, ey, dotR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = _t(bz).legendText;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const truncated = label.length > 14 ? label.slice(0, 13) + '…' : label;
    ctx.fillText(truncated, x + pad + dotR * 2 + 6, ey);
  }

  // Overflow indicator
  if (overflow > 0) {
    const ey = y + pad + headerH + entries.length * lineH + lineH / 2;
    ctx.fillStyle = _t(bz).legendOverflow;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${overflow} more`, x + pad, ey);
  }
}

// ─── Reset button (canvas-drawn) ─────────────────────────────────────────────

function renderResetBtn(bz) {
  const rb = bz._resetBtnRect();
  if (!rb) return;
  const ctx = bz.ctx;
  ctx.fillStyle = _t(bz).resetBg;
  ctx.beginPath();
  ctx.roundRect(rb.x, rb.y, rb.w, rb.h, 4);
  ctx.fill();
  ctx.fillStyle = _t(bz).resetText;
  ctx.font = '14px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('↺', rb.x + rb.w / 2, rb.y + rb.h / 2);
}

// ─── Hit testing ─────────────────────────────────────────────────────────────

export function hitTest(bz, sx, sy) {
  const rz = bz.renderZoom;
  const wx = (sx - bz.pan.x) / rz;
  const wy = (sy - bz.pan.y) / rz;

  if (bz.currentLevel === RAW_LEVEL) {
    const cellPxRaw = (Math.min(bz.W, bz.H) * rz) / 256;
    const rScreen = Math.max(8, Math.min(10, cellPxRaw * 0.42));
    const rWorld = (rScreen + 4) / rz;
    const rWorldSq = rWorld * rWorld;

    // Spatial culling via supernode hierarchy: convert world coords to grid
    // coords, find the cell at a coarse level, scan only nearby members.
    // CULL_IDX is an index into the levels array; the actual zoom level
    // value is ZOOM_LEVELS[CULL_IDX] (used for cellIdAtLevel / bid encoding).
    const CULL_IDX = 5;
    const cullLevel = ZOOM_LEVELS[CULL_IDX]; // actual level value (e.g., 6 → 64×64)
    const scale = bz._layoutScale;
    if (scale && bz.nodes.length > 500) {
      const px = (wx - bz._layoutOffX) / scale + bz._layoutMinX;
      const py = (wy - bz._layoutOffY) / scale + bz._layoutMinY;
      const gx = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((px + 1) / 2 * GRID_SIZE)));
      const gy = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((py + 1) / 2 * GRID_SIZE)));
      const shift = GRID_BITS - cullLevel;
      const ccx = gx >> shift, ccy = gy >> shift;
      const k = 1 << cullLevel;

      // Build cell→supernode index on first use, cache on level object
      const level = bz.getLevel(CULL_IDX);
      if (!level._snByBid) {
        level._snByBid = new Map();
        for (const sn of level.supernodes) level._snByBid.set(sn.bid, sn);
      }

      // Scan 3×3 neighborhood of cells
      for (let dy = -1; dy <= 1; dy++) {
        const cy = ccy + dy;
        if (cy < 0 || cy >= k) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ccx + dx;
          if (cx < 0 || cx >= k) continue;
          const bid = (cx << cullLevel) | cy;
          const sn = level._snByBid.get(bid);
          if (!sn) continue;
          for (const n of sn.members) {
            const ddx = n.x - wx, ddy = n.y - wy;
            if (ddx*ddx + ddy*ddy < rWorldSq) return {type:'node', item:n};
          }
        }
      }
    } else {
      // Small dataset or no layout yet: linear scan
      for (let i = 0; i < bz.nodes.length; i++) {
        const n = bz.nodes[i];
        const dx = n.x - wx, dy = n.y - wy;
        if (dx*dx + dy*dy < rWorldSq) return {type:'node', item:n};
      }
    }
  } else {
    const lvlVal = ZOOM_LEVELS[bz.currentLevel];
    const k = 1 << lvlVal;
    const cellPx = (Math.min(bz.W, bz.H) * rz) / k;
    const rScreen = Math.max(6, Math.min(22, cellPx * 0.42));
    const rWorld = (rScreen + 6) / rz;
    const rWorldSq = rWorld * rWorld;
    const level = bz.getLevel(bz.currentLevel);

    // Spatial lookup via grid cell — O(9) instead of O(supernodes)
    const scale = bz._layoutScale;
    if (scale && level.supernodes.length > 100) {
      if (!level._snByBid) {
        level._snByBid = new Map();
        for (const sn of level.supernodes) level._snByBid.set(sn.bid, sn);
      }
      const ax = (wx - bz._layoutOffX) / scale + bz._layoutMinX;
      const ay = (wy - bz._layoutOffY) / scale + bz._layoutMinY;
      const gx = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((ax + 1) / 2 * GRID_SIZE)));
      const gy = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((ay + 1) / 2 * GRID_SIZE)));
      const shift = GRID_BITS - lvlVal;
      const ccx = gx >> shift, ccy = gy >> shift;
      for (let dy = -1; dy <= 1; dy++) {
        const cy = ccy + dy;
        if (cy < 0 || cy >= k) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ccx + dx;
          if (cx < 0 || cx >= k) continue;
          const sn = level._snByBid.get((cx << lvlVal) | cy);
          if (!sn) continue;
          const ddx = sn.x - wx, ddy = sn.y - wy;
          if (ddx*ddx + ddy*ddy < rWorldSq) return {type:'supernode', item:sn};
        }
      }
    } else {
      // Small level or no layout yet: linear scan
      for (let i = 0; i < level.supernodes.length; i++) {
        const sn = level.supernodes[i];
        const dx = sn.x - wx, dy = sn.y - wy;
        if (dx*dx + dy*dy < rWorldSq) return {type:'supernode', item:sn};
      }
    }
  }
  return null;
}
