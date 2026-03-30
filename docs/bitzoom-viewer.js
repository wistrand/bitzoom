// bitzoom-viewer.js — BitZoom viewer application. Composes BitZoomCanvas with UI, workers, data loading.

import {
    MINHASH_K, GRID_SIZE, GRID_BITS, ZOOM_LEVELS, RAW_LEVEL, LEVEL_LABELS,
    buildGaussianProjection, generateGroupColors, unifiedBlend, cellIdAtLevel,
} from './bitzoom-algo.js';
import { autoTuneWeights } from './bitzoom-utils.js';
import { convertStixToSnap } from './stix2snap.js';
import { initGPU, computeProjectionsGPU } from './bitzoom-gpu.js';
import { isWebGL2Available } from './bitzoom-gl-renderer.js';

import { BitZoomCanvas } from './bitzoom-canvas.js';
import { computeNodeSig, runPipelineGPU, runPipeline, parseEdgesFile, parseNodesFile, buildGraph, computeProjections } from './bitzoom-pipeline.js';

// HTML-escape user-derived strings to prevent XSS from crafted SNAP files.
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Dataset definitions. Optional `settings` configures initial weights and label checkboxes.
const DATASETS = [
    { id: 'karate',     name: 'Karate Club',     edges: 'data/karate.edges',          nodes: 'data/karate.nodes',          desc: '34 nodes, Zachary 1977' },
    { id: 'epstein',    name: 'Epstein',         edges: 'data/epstein.edges',         nodes: 'data/epstein.nodes',         desc: '364 nodes, edge types',
        settings: { weights: { group: 5, edgetype: 8 }, labelProps: ['label'] } },
    { id: 'bz-source',  name: 'BitZoom Source', edges: 'data/bitzoom-source.edges',  nodes: 'data/bitzoom-source.nodes',  desc: '145 nodes, call graph',
        settings: { weights: { kind: 8, group: 3 }, labelProps: ['file', 'kind'] } },
    { id: 'synth-pkg',  name: 'Synth Packages',  edges: 'data/synth-packages.edges',  nodes: 'data/synth-packages.nodes',  desc: '1.9K nodes',
        settings: { weights: { group: 5, downloads: 3, license: 2 }, labelProps: ['label', 'group'] } },
    { id: 'mitre',      name: 'MITRE ATT&CK',  edges: 'data/mitre-attack.edges',   nodes: 'data/mitre-attack.nodes',   desc: '4.7K nodes, kill chains',
        settings: { weights: { group: 5, platforms: 6, killchain: 4 }, labelProps: ['label'] } },
    { id: 'email-eu',   name: 'Email EU',        edges: 'data/email-eu.edges',                                                    desc: '1K nodes, communication',
        settings: { weights: {}, quantMode: 'rank', smoothAlpha: 1.0 } },
    { id: 'facebook',   name: 'Facebook',        edges: 'data/facebook.edges',                                                    desc: '4K nodes, social',
        settings: { weights: {}, initialLevel: 4, quantMode: 'rank', smoothAlpha: 1.0 } },
    { id: 'amazon',     name: 'Amazon',          edges: 'data/amazon-copurchase.edges.gz',nodes: 'data/amazon-copurchase.nodes.gz',desc: '367K nodes' },
    { id: 'mitre-ics',  name: 'ATT&CK ICS',
        stix: 'data/ics-attack.json.gz',
        desc: 'STIX 2.1, ~1.8K objects',
        settings: { weights: { group: 5, platforms: 6, killchain: 4 }, labelProps: ['label'] } },
    { id: 'mitre-mobile', name: 'ATT&CK Mobile',
        stix: 'data/mobile-attack.json.gz',
        desc: 'STIX 2.1, ~2.5K objects',
        settings: { weights: { group: 5, platforms: 6, killchain: 4 }, labelProps: ['label'] } },
];

class BitZoom {
    constructor() {
        const canvas = document.getElementById('canvas');

        // The canvas view handles all graph state, rendering, interaction primitives
        this.view = new BitZoomCanvas(canvas, {
            skipEvents: true,
            heatmapMode: 'density',
            initialLevel: 0,
            onRender: () => this._scheduleHashUpdate(),
        });

        // App-specific state
        this.dataLoaded = false;
        this.presets = {};
        this.activeWorker = null;
        this.pendingEdgesText = null;
        this.pendingNodesText = null;
        this.rebuildTimer = null;
        this.smoothDebounceTimer = null;
        this._zoomTargetMembers = null;
        this._zoomTargetLabel = null;
        this._hashUpdateTimer = null;
        this._currentDatasetId = null;
        this._uiUpdatePending = false;

        // Own event state
        this.mouseDown = false;
        this.mouseMoved = false;
        this.mouseStart = null;
        this.t1 = null;
        this.t2 = null;
        this.touchMoved = false;
        this._abortController = new AbortController();

        this._bindEvents();
        this._buildDatasetButtons();
    }

    // ─── URL hash state ────────────────────────────────────────────────────────

    _serializeHash() {
        const v = this.view;
        const parts = [];
        if (this._currentDatasetId) parts.push(`d=${encodeURIComponent(this._currentDatasetId)}`);
        parts.push(`l=${v.currentLevel}`);
        parts.push(`z=${v.zoom.toFixed(3)}`);
        parts.push(`x=${v.pan.x.toFixed(0)}`);
        parts.push(`y=${v.pan.y.toFixed(0)}`);
        parts.push(`bl=${v.baseLevel}`);
        if (v.selectedId) parts.push(`s=${encodeURIComponent(v.selectedId)}`);
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
            const [k, val] = part.split('=');
            if (k && val !== undefined) params[k] = decodeURIComponent(val);
        }
        return params;
    }

    _applyHashState(params) {
        if (!params || !this.dataLoaded) return;
        const v = this.view;
        if (params.l !== undefined) v.currentLevel = parseInt(params.l) || 0;
        if (params.bl !== undefined) v.baseLevel = parseInt(params.bl) || 0;
        if (params.z !== undefined) v.zoom = parseFloat(params.z) || 1;
        if (params.x !== undefined) v.pan.x = parseFloat(params.x) || 0;
        if (params.y !== undefined) v.pan.y = parseFloat(params.y) || 0;
        if (params.s) {
            v.selectedId = params.s;
            const n = v.nodeIndexFull[params.s];
            if (n) this._showDetail({ type: 'node', item: n });
        }
        this._updateStepperUI();
        v.layoutAll();
        this._updateAlgoInfo();
        this._updateOverview();
        v.render();
    }

    // ─── Algorithm wrappers ────────────────────────────────────────────────────

    async rebuildProjections() {
        const v = this.view;
        v._refreshPropCache();
        v.levels = new Array(ZOOM_LEVELS.length).fill(null);
        await v._blend();
        v.layoutAll();
        v.render();
    }

    // ─── Navigation ─────────────────────────────────────────────────────────────

    switchLevel(idx) {
        const v = this.view;
        const oldIdx = v.currentLevel;
        const oldIsRaw = oldIdx === RAW_LEVEL;
        const newIsRaw = idx === RAW_LEVEL;

        // Capture old supernode screen positions for animation
        const oldSns = !oldIsRaw ? v.getLevel(oldIdx).supernodes : null;
        const oldLevel = oldIsRaw ? null : ZOOM_LEVELS[oldIdx];
        const oldPosByBid = {};
        if (oldSns) {
            for (const sn of oldSns) oldPosByBid[sn.bid] = { x: sn.x, y: sn.y };
        }

        // Switch
        const oldRZ = v.renderZoom;
        v.currentLevel = idx;
        v.zoom = oldRZ / Math.pow(2, idx - v.baseLevel);
        this._updateStepperUI();
        v.selectedId = null;
        document.getElementById('node-panel').classList.remove('open');
        v.layoutAll();
        this._updateAlgoInfo();
        this._updateOverview();

        // Animate if few nodes on screen and not switching to/from RAW
        const newSns = !newIsRaw ? v.getLevel(idx).supernodes : null;
        const shouldAnimate = oldSns && newSns && newSns.length < 80 && oldSns.length < 80;

        if (!shouldAnimate) { v.render(); return; }

        const newLevel = ZOOM_LEVELS[idx];
        const zoomingIn = idx > oldIdx;

        // Build animation map: newBid → {startX, startY, endX, endY}
        const anims = [];
        if (zoomingIn) {
            // Each new sub-supernode animates FROM its parent supernode position
            for (const sn of newSns) {
                // Find parent bid at old level using first member's grid coords
                const m0 = sn.members[0];
                const parentBid = cellIdAtLevel(m0.gx, m0.gy, oldLevel);
                const from = oldPosByBid[parentBid];
                if (from) {
                    anims.push({ sn, sx: from.x, sy: from.y, ex: sn.x, ey: sn.y });
                }
            }
        } else {
            // Each old supernode animates TO its new parent supernode position
            // We animate the NEW supernodes from the centroid of their old children
            const newPosByBid = {};
            for (const sn of newSns) newPosByBid[sn.bid] = { x: sn.x, y: sn.y };

            for (const sn of newSns) {
                // Find old children that map to this new supernode
                let cx = 0, cy = 0, count = 0;
                for (const old of oldSns) {
                    const m0 = old.members[0];
                    const parentBid = cellIdAtLevel(m0.gx, m0.gy, newLevel);
                    if (parentBid === sn.bid) {
                        cx += oldPosByBid[old.bid].x;
                        cy += oldPosByBid[old.bid].y;
                        count++;
                    }
                }
                if (count > 0) {
                    anims.push({ sn, sx: cx / count, sy: cy / count, ex: sn.x, ey: sn.y });
                }
            }
        }

        if (anims.length === 0) { v.render(); return; }

        const duration = 300;
        const startTime = performance.now();
        const animate = (now) => {
            const t = Math.min(1, (now - startTime) / duration);
            const e = 1 - Math.pow(1 - t, 3); // ease-out cubic

            for (const a of anims) {
                a.sn.x = a.sx + (a.ex - a.sx) * e;
                a.sn.y = a.sy + (a.ey - a.sy) * e;
            }

            v.renderNow();

            if (t < 1) {
                requestAnimationFrame(animate);
            } else {
                // Restore final positions
                for (const a of anims) { a.sn.x = a.ex; a.sn.y = a.ey; }
                v.renderNow();
            }
        };
        requestAnimationFrame(animate);
    }

    _checkAutoLevel() {
        const v = this.view;
        const prev = v.currentLevel;
        v._checkAutoLevel();
        if (v.currentLevel !== prev) {
            this._updateStepperUI();
            this._deferUIUpdate();
        }
    }

    _animateZoom(factor, anchorX, anchorY) {
        const v = this.view;
        const startPan = { x: v.pan.x, y: v.pan.y };
        const startZoom = v.zoom;
        const targetZoom = Math.max(0.25, startZoom * factor);
        const startRZ = v.renderZoom;
        const targetRZ = Math.max(1, targetZoom * Math.pow(2, v.currentLevel - v.baseLevel));
        const f = targetRZ / startRZ;
        const targetPan = {
            x: anchorX - (anchorX - startPan.x) * f,
            y: anchorY - (anchorY - startPan.y) * f,
        };
        const startTime = performance.now();
        const animate = (now) => {
            const t = Math.min(1, (now - startTime) / 300);
            const e = 1 - Math.pow(1 - t, 3);
            v.zoom = startZoom + (targetZoom - startZoom) * e;
            v.pan.x = startPan.x + (targetPan.x - startPan.x) * e;
            v.pan.y = startPan.y + (targetPan.y - startPan.y) * e;
            v.renderNow();
            if (t < 1) {
                requestAnimationFrame(animate);
            } else {
                this._checkAutoLevel();
                v.renderNow();
            }
        };
        requestAnimationFrame(animate);
    }

    zoomToNode(hit) {
        const v = this.view;
        const isNode = hit.type === 'node';
        const item = hit.item;

        this._zoomTargetMembers = isNode ? [item] : item.members;
        this._zoomTargetLabel = isNode ? v._nodeLabel(item) : v._supernodeLabel(item);
        v.selectedId = isNode ? item.id : item.bid;

        const startPan = { x: v.pan.x, y: v.pan.y };
        const startZoom = v.zoom;
        const targetZoom = startZoom * 2;

        const wp = v.worldToScreen(item.x, item.y);
        const startRZ = v.renderZoom;
        const targetRZ = Math.max(1, targetZoom * Math.pow(2, v.currentLevel - v.baseLevel));
        const f = targetRZ / startRZ;
        const targetPan = {
            x: v.W / 2 - (v.W / 2 - startPan.x) * f - (wp.x - v.W / 2) * f,
            y: v.H / 2 - (v.H / 2 - startPan.y) * f - (wp.y - v.H / 2) * f,
        };

        const startTime = performance.now();
        const animate = (now) => {
            const t = Math.min(1, (now - startTime) / 350);
            const e = 1 - Math.pow(1 - t, 3);
            v.zoom = startZoom + (targetZoom - startZoom) * e;
            v.pan.x = startPan.x + (targetPan.x - startPan.x) * e;
            v.pan.y = startPan.y + (targetPan.y - startPan.y) * e;
            v.renderNow();
            if (t < 1) {
                requestAnimationFrame(animate);
            } else {
                const prevLevel = v.currentLevel;
                this._checkAutoLevel();
                if (v.currentLevel !== prevLevel && this._zoomTargetMembers) {
                    this._reselectAfterLevelChange();
                }
                v.renderNow();
            }
        };
        requestAnimationFrame(animate);
    }

    _reselectAfterLevelChange() {
        const v = this.view;
        if (!this._zoomTargetMembers || this._zoomTargetMembers.length === 0) return;
        const targetLabel = this._zoomTargetLabel || '';

        if (v.currentLevel === RAW_LEVEL) {
            let best = v.nodeIndexFull[this._zoomTargetMembers[0].id];
            if (targetLabel) {
                for (const m of this._zoomTargetMembers) {
                    const n = v.nodeIndexFull[m.id];
                    if (n && v._nodeLabel(n) === targetLabel) { best = n; break; }
                }
            }
            if (best) {
                v.selectedId = best.id;
                v.layoutAll();
                this._showDetail({ type: 'node', item: best });
                this._centerOnNode(best);
            }
            return;
        }

        const level = v.getLevel(v.currentLevel);
        const memberIds = new Set(this._zoomTargetMembers.map(m => m.id));

        let bestSn = null;
        let bestScore = -1;
        for (const sn of level.supernodes) {
            let overlap = 0;
            for (const m of sn.members) {
                if (memberIds.has(m.id)) overlap++;
            }
            const snLabel = v._supernodeLabel(sn);
            const labelBonus = (targetLabel && snLabel === targetLabel) ? 10000 : 0;
            const score = labelBonus + overlap;
            if (score > bestScore) {
                bestScore = score;
                bestSn = sn;
            }
        }

        if (bestSn) {
            v.selectedId = bestSn.bid;
            this._zoomTargetMembers = bestSn.members;
            this._zoomTargetLabel = v._supernodeLabel(bestSn);
            v.layoutAll();
            this._showDetail({ type: 'supernode', item: bestSn });
            this._centerOnNode(bestSn);
        }
    }

    _centerOnNode(item) {
        const v = this.view;
        const p = v.worldToScreen(item.x, item.y);
        v.pan.x += v.W / 2 - p.x;
        v.pan.y += v.H / 2 - p.y;
    }

    selectNode(id) {
        const v = this.view;
        const n = v.nodeIndexFull[id];
        if (!n) return;
        v.selectedId = id;
        this.switchLevel(RAW_LEVEL);
        const p = v.worldToScreen(n.x, n.y);
        v.pan.x += v.W / 2 - p.x;
        v.pan.y += v.H / 2 - p.y;
        this._showDetail({ type: 'node', item: n });
        v.render();
    }

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
        const v = this.view;
        const label = LEVEL_LABELS[v.currentLevel];
        const el = document.getElementById('zoomCurrent');
        if (el.textContent !== label) el.textContent = label;
        document.getElementById('zoomPrev').disabled = v.currentLevel === 0;
        document.getElementById('zoomNext').disabled = v.currentLevel === LEVEL_LABELS.length - 1;
    }

    _updateOverview() {
        const v = this.view;
        const stats = document.getElementById('overview-stats');
        const isRaw = v.currentLevel === RAW_LEVEL;
        if (isRaw) {
            stats.innerHTML = `
        <div class="stat-row"><span class="stat-label">Nodes</span><span class="stat-value">${v.nodes.length}</span></div>
        <div class="stat-row"><span class="stat-label">Edges</span><span class="stat-value">${v.edges.length}</span></div>
        <div class="stat-row"><span class="stat-label">MinHash k</span><span class="stat-value">${MINHASH_K}</span></div>
        <div class="stat-row"><span class="stat-label">Grid</span><span class="stat-value">${GRID_SIZE}×${GRID_SIZE}</span></div>
        <div class="stat-row"><span class="stat-label">Level</span><span class="stat-value">RAW</span></div>`;
        } else {
            const lv = v.getLevel(v.currentLevel);
            const k = 1 << ZOOM_LEVELS[v.currentLevel];
            stats.innerHTML = `
        <div class="stat-row"><span class="stat-label">Nodes</span><span class="stat-value">${v.nodes.length}</span></div>
        <div class="stat-row"><span class="stat-label">Supernodes</span><span class="stat-value">${lv.supernodes.length}</span></div>
        <div class="stat-row"><span class="stat-label">Super-edges</span><span class="stat-value">${lv.snEdges.length}</span></div>
        <div class="stat-row"><span class="stat-label">Grid k</span><span class="stat-value">${k}×${k}</span></div>
        <div class="stat-row"><span class="stat-label">Cells used</span><span class="stat-value">${lv.supernodes.length} / ${k*k}</span></div>
        <div class="stat-row"><span class="stat-label">Avg bucket</span><span class="stat-value">${(v.nodes.length/lv.supernodes.length).toFixed(1)} nodes</span></div>`;
        }
    }

    _updateAlgoInfo() {
        const v = this.view;
        const isRaw = v.currentLevel === RAW_LEVEL;
        const lvNum = ZOOM_LEVELS[v.currentLevel];
        const k = isRaw ? GRID_SIZE : (1 << lvNum);
        const desc = isRaw
            ? `RAW: individual nodes. MinHash(k=128) → Gaussian projection → 2D. Grid (gx,gy) uint16.`
            : `L${lvNum}: k=${k}/axis → ${k*k} cells. Shift uint16 gx,gy right by ${GRID_BITS-lvNum} bits.`;
        document.getElementById('algo-info').textContent = desc;
    }

    _showDetail(hit) {
        const v = this.view;
        const panel = document.getElementById('node-panel');
        const detail = document.getElementById('node-detail');
        panel.classList.add('open');

        if (hit.type === 'node') {
            const n = hit.item;
            const col = v._nodeColor(n);
            const nbrCount = (v.adjList[n.id] || []).length;
            let propsHtml = `
        <div class="prop-row"><div class="prop-key">Group</div><div class="prop-val">${esc(n.group)}</div></div>
        <div class="prop-row"><div class="prop-key">Label</div><div class="prop-val">${esc(n.label)}</div></div>
        <div class="prop-row"><div class="prop-key">Degree</div><div class="prop-val">${n.degree} (${nbrCount} neighbors)</div></div>`;
            if (n.edgeTypes && n.edgeTypes.size > 0) {
                propsHtml += `<div class="prop-row"><div class="prop-key">Edge types</div><div class="prop-val">${[...n.edgeTypes].map(esc).join(', ')}</div></div>`;
            }
            if (n.extraProps) {
                for (const [key, val] of Object.entries(n.extraProps)) {
                    if (val && val !== 'unknown') {
                        propsHtml += `<div class="prop-row"><div class="prop-key">${esc(key)}</div><div class="prop-val">${esc(val)}</div></div>`;
                    }
                }
            }
            const nbrIds = v.adjList[n.id] || [];
            if (nbrIds.length > 0) {
                const nbrByGroup = {};
                for (const nid of nbrIds) {
                    const nb = v.nodeIndexFull[nid];
                    const g = nb ? nb.group : 'unknown';
                    if (!nbrByGroup[g]) nbrByGroup[g] = [];
                    nbrByGroup[g].push(nb || { id: nid, group: 'unknown', degree: 0, label: nid });
                }
                const groups = Object.entries(nbrByGroup).sort((a, b) => b[1].length - a[1].length);
                let nbrHtml = '';
                const MAX_PER_GROUP = 5;
                const MAX_GROUPS = 6;
                for (let gi = 0; gi < Math.min(groups.length, MAX_GROUPS); gi++) {
                    const [gName, members] = groups[gi];
                    members.sort((a, b) => b.degree - a.degree);
                    const gc = v.groupColors[gName] || '#888888';
                    nbrHtml += `<div style="margin-top:4px"><span class="prop-key" style="color:${gc}">${esc(gName)} (${members.length})</span></div>`;
                    for (let mi = 0; mi < Math.min(members.length, MAX_PER_GROUP); mi++) {
                        const nb = members[mi];
                        const nc = v._nodeColor(nb);
                        const label = nb.label || nb.id;
                        const shortLabel = label.length > 40 ? label.slice(0, 37) + '…' : label;
                        nbrHtml += `<div class="neighbor-item" onclick="bz.selectNode('${esc(nb.id)}')" style="cursor:pointer">
              <span>${esc(shortLabel)}</span>
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
        <div class="node-title">${esc(n.id)}</div>
        <div class="node-badge" style="background:${col}33;color:${col};border:1px solid ${col}55">${esc(n.group)}</div>
        <div style="height:10px"></div>
        ${propsHtml}
        <div class="prop-row">
          <div class="prop-key">Grid coords</div>
          <div class="bucket-id">gx=${n.gx} gy=${n.gy} · px=${n.px.toFixed(3)} py=${n.py.toFixed(3)}</div>
        </div>
        <div class="prop-row">
          <div class="prop-key">MinHash sig (32 bits)</div>
          <div class="minhash-display">
            ${Array.from(computeNodeSig(n).subarray(0,32)).map((val,i) => {
                const bit = val % 2;
                const col2 = bit ? '#7c6af7' : '#1e1e2e';
                return `<div class="mh-bit" title="h${i}=${val}" style="background:${col2}"></div>`;
            }).join('')}
          </div>
        </div>`;
        } else {
            const sn = hit.item;
            const col = sn.cachedColor;
            const lvNum = ZOOM_LEVELS[v.currentLevel];
            const groupBreakdown = {};
            for (const m of sn.members) groupBreakdown[m.group] = (groupBreakdown[m.group]||0)+1;
            const groupRows = Object.entries(groupBreakdown).sort((a,b)=>b[1]-a[1])
                .map(([g,cnt]) => `<div class="neighbor-item"><span>${esc(g)}</span><span style="color:${v.groupColors[g]||'#888888'}">${cnt}</span></div>`).join('');

            let extraHtml = '';
            if (sn.members.length > 0 && sn.members[0].extraProps) {
                const propKeys = Object.keys(sn.members[0].extraProps);
                for (const key of propKeys) {
                    const counts = {};
                    for (const m of sn.members) {
                        const val = m.extraProps?.[key] || 'unknown';
                        counts[val] = (counts[val] || 0) + 1;
                    }
                    const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
                    const top = sorted.slice(0, 3).map(([val, c]) => `${esc(val)} (${c})`).join(', ');
                    extraHtml += `<div class="prop-row"><div class="prop-key">${esc(key)}</div><div class="prop-val">${top}</div></div>`;
                }
            }

            const level = v.getLevel(v.currentLevel);
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
                linkedHtml += `<div class="neighbor-item"><span>${esc(shortLbl)}</span><span style="color:${lc};font-size:9px">${linkedSns[i].weight} edges</span></div>`;
            }
            if (linkedSns.length > MAX_LINKED) {
                linkedHtml += `<div class="hint">+${linkedSns.length - MAX_LINKED} more</div>`;
            }

            const topMembers = sn.members.slice().sort((a, b) => b.degree - a.degree);
            const memberList = topMembers.slice(0, 8).map(m => {
                const ml = m.label || m.id;
                const shortMl = ml.length > 35 ? ml.slice(0, 32) + '…' : ml;
                return `<div class="neighbor-item" onclick="bz.selectNode('${esc(m.id)}')" style="cursor:pointer">
          <span>${esc(shortMl)}</span>
          <span style="color:${v.groupColors[m.group]||'#888888'};font-size:9px">deg:${m.degree}</span>
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

    async _applyDatasetSettings(settings) {
        const v = this.view;
        if ('weights' in settings) {
            // Zero all weights first, then apply specified values
            for (const g of v.groupNames) v.propWeights[g] = 0;
            for (const [prop, val] of Object.entries(settings.weights)) {
                if (prop in v.propWeights) v.propWeights[prop] = val;
            }
        }
        v.labelProps.clear();
        if (settings.labelProps) {
            for (const prop of settings.labelProps) {
                if (v.groupNames.includes(prop)) v.labelProps.add(prop);
            }
        }
        if (settings.quantMode) {
            v.quantMode = settings.quantMode;
            this._updateQuantBtn();
        }
        if (settings.smoothAlpha != null) {
            v.smoothAlpha = settings.smoothAlpha;
            document.getElementById('nudgeSlider').value = v.smoothAlpha;
            document.getElementById('nudgeVal').textContent = v.smoothAlpha.toFixed(2);
        }
        this._syncWeightUI();
        this._syncLabelCheckboxes();
        v._quantStats = {}; // re-snapshot boundaries from dataset-tuned weights
        v._refreshPropCache();
        await this.rebuildProjections();
        if (settings.initialLevel != null) {
            v.currentLevel = settings.initialLevel;
            v.baseLevel = settings.initialLevel;
        }
    }

    _syncLabelCheckboxes() {
        const v = this.view;
        for (const key of v.groupNames) {
            const cb = document.getElementById(`lbl-${key}`);
            if (cb) cb.checked = v.labelProps.has(key);
        }
    }

    _buildDynamicUI() {
        const v = this.view;
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
        for (const key of v.groupNames) {
            const row = document.createElement('div');
            row.className = 'weight-row';
            row.innerHTML = `
        <input type="checkbox" id="lbl-${esc(key)}" title="Include in label">
        <span class="weight-label">${esc(key)}</span>
        <input class="weight-slider" type="range" id="w-${key}" min="0" max="10" step="0.5" value="${v.propWeights[key]}">
        <span class="weight-val" id="wv-${key}">${v.propWeights[key]}</span>`;
            sliderContainer.appendChild(row);
            row.querySelector('.weight-slider').addEventListener('input', e => {
                v.propWeights[key] = parseFloat(e.target.value);
                document.getElementById(`wv-${key}`).textContent = v.propWeights[key];
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                this._scheduleRebuild();
            });
            row.querySelector('input[type=checkbox]').addEventListener('change', e => {
                if (e.target.checked) v.labelProps.add(key);
                else v.labelProps.delete(key);
                v._refreshPropCache();
                v.render();
            });
        }
    }

    _scheduleRebuild() {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(async () => { await this.rebuildProjections(); this.rebuildTimer = null; }, 150);
    }

    _syncWeightUI() {
        const v = this.view;
        for (const [key, val] of Object.entries(v.propWeights)) {
            const sl = document.getElementById(`w-${key}`);
            const vl = document.getElementById(`wv-${key}`);
            if (sl) { sl.value = val; vl.textContent = val; }
        }
    }

    _applyPreset(name) {
        const v = this.view;
        const p = this.presets[name];
        if (!p) return;
        Object.assign(v.propWeights, p);
        this._syncWeightUI();
        document.querySelectorAll('.preset-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.preset === name);
        });
        this._scheduleRebuild();
    }

    // ─── Data loading ──────────────────────────────────────────────────────────

    loadGraph(edgesText, nodesText) {
        this._lastEdgesText = edgesText;
        this._lastNodesText = nodesText;
        console.log('[CPU] Loading graph via worker pipeline...');
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
            worker.postMessage({ edgesText, nodesText });
        });
    }

    /** Load graph on main thread with GPU blend. Uses GPU projections when quantMode
     *  is gaussian (default), CPU projections when rank (float32 precision causes rank
     *  sort instability). Yields between pipeline stages for browser responsiveness. */
    async loadGraphGPU(edgesText, nodesText, dataset) {
        this._lastEdgesText = edgesText;
        this._lastNodesText = nodesText;
        const status = document.getElementById('loadStatus');
        const progressBar = document.getElementById('loadProgress');
        status.classList.remove('error');

        const t0 = performance.now();
        const yield_ = () => new Promise(r => requestAnimationFrame(r));

        status.textContent = 'Parsing edges...';
        if (progressBar) progressBar.value = 10;
        await yield_();
        const parsed = parseEdgesFile(edgesText);

        let nodesResult = null;
        if (nodesText) {
            status.textContent = 'Parsing nodes...';
            if (progressBar) progressBar.value = 25;
            await yield_();
            nodesResult = parseNodesFile(nodesText);
        }

        status.textContent = 'Building graph...';
        if (progressBar) progressBar.value = 40;
        await yield_();
        const nodesMap = nodesResult ? nodesResult.nodes : null;
        const extraPropNames = nodesResult ? nodesResult.extraPropNames : [];
        const graph = buildGraph(parsed, nodesMap, extraPropNames);

        // Adaptive GPU/CPU projection: GPU when N×G > 2000 and gaussian quant
        const N = graph.nodeArray.length;
        const G = graph.groupNames.length;
        const qm = dataset?.settings?.quantMode || 'gaussian';
        const useGPUProj = qm !== 'rank' && N * G > 2000;

        if (useGPUProj) {
            status.textContent = 'Computing projections (GPU)...';
        } else {
            status.textContent = 'Computing projections...';
        }
        if (progressBar) progressBar.value = 60;
        await yield_();
        console.log(`[GPU] Pipeline: N=${N}, G=${G}, proj=${useGPUProj ? 'GPU' : 'CPU'}, blend=${N > 50000 ? 'GPU' : 'CPU'}`);

        let projBuf;
        if (useGPUProj) {
            projBuf = (await computeProjectionsGPU(
                graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, extraPropNames, graph.numericBins
            )).projBuf;
        } else {
            projBuf = computeProjections(
                graph.nodeArray, graph.adjGroups, graph.groupNames, graph.hasEdgeTypes, extraPropNames, graph.numericBins
            ).projBuf;
        }

        status.textContent = 'Applying...';
        if (progressBar) progressBar.value = 85;
        await yield_();

        console.log(`[GPU] Pipeline done: ${graph.nodeArray.length} nodes, ${graph.edges.length} edges in ${Math.round(performance.now() - t0)}ms`);

        this._applyWorkerResult({
            nodeMeta: graph.nodeArray,
            projBuf,
            edges: graph.edges,
            groupNames: graph.groupNames,
            hasEdgeTypes: graph.hasEdgeTypes,
        });
        if (progressBar) progressBar.value = 100;
    }

    _applyWorkerResult(result) {
        const v = this.view;
        const { nodeMeta, projBuf, edges: workerEdges, groupNames, hasEdgeTypes: het } = result;

        v.groupNames = groupNames;
        v.hasEdgeTypes = het;

        // Build color maps for every property group
        v.propColors = {};
        const propValues = {};
        for (const g of groupNames) propValues[g] = new Set();
        for (const meta of nodeMeta) {
            propValues['group'].add(meta.group || 'unknown');
            propValues['label'].add(meta.label || meta.id);
            propValues['structure'].add(`deg:${meta.degree}`);
            propValues['neighbors'].add('_');
            if (meta.extraProps) {
                for (const [k, val] of Object.entries(meta.extraProps)) {
                    if (propValues[k]) propValues[k].add(val || 'unknown');
                }
            }
            if (meta.edgeTypes) {
                const types = Array.isArray(meta.edgeTypes) ? meta.edgeTypes : [];
                for (const t of types) propValues['edgetype']?.add(t);
            }
        }
        for (const g of groupNames) {
            v.propColors[g] = generateGroupColors([...propValues[g]].sort());
        }
        v.groupColors = v.propColors['group'];

        v.groupProjections = {};
        for (let i = 0; i < v.groupNames.length; i++) {
            v.groupProjections[v.groupNames[i]] = buildGaussianProjection(2001 + i, MINHASH_K);
        }

        const G = groupNames.length;
        v.nodes = nodeMeta.map((meta, i) => {
            const projections = {};
            for (let g = 0; g < G; g++) {
                const off = (i * G + g) * 2;
                projections[groupNames[g]] = [projBuf[off], projBuf[off + 1]];
            }
            return { ...meta, projections, px: 0, py: 0, gx: 0, gy: 0, x: 0, y: 0 };
        });

        v.nodeIndexFull = Object.fromEntries(v.nodes.map(n => [n.id, n]));
        v.edges = workerEdges;
        let md = 1;
        for (let i = 0; i < v.nodes.length; i++) { if (v.nodes[i].degree > md) md = v.nodes[i].degree; }
        v.maxDegree = md;

        v.adjList = Object.fromEntries(v.nodes.map(n => [n.id, []]));
        for (const e of v.edges) {
            if (v.adjList[e.src] && v.adjList[e.dst]) {
                v.adjList[e.src].push(e.dst);
                v.adjList[e.dst].push(e.src);
            }
        }

        v.propWeights = {};
        this.presets = { balanced: {} };
        for (const g of v.groupNames) {
            v.propWeights[g] = (g === 'group') ? 3 : (g === 'label') ? 1 : 0;
            this.presets.balanced[g] = v.propWeights[g];
        }
        for (const g of v.groupNames) {
            const preset = {};
            for (const g2 of v.groupNames) preset[g2] = (g2 === g) ? 8 : 0;
            this.presets[g] = preset;
        }

        this._buildDynamicUI();

        // Reset all view settings to defaults for new data
        v.smoothAlpha = 0;
        v.edgeMode = 'curves';
        v.heatmapMode = 'density';
        v.sizeBy = 'edges';
        v.sizeLog = false;
        v.quantMode = 'gaussian';
        v.labelProps.clear();
        v._quantStats = {};
        v._densityId = null; // force heatmap maxW recalculation
        v._refreshPropCache();
        document.getElementById('nudgeSlider').value = 0;
        document.getElementById('nudgeVal').textContent = '0';
        this._updateSizeButtons();
        this._updateLogBtn();
        this._updateQuantBtn();
        this._updateEdgeBtn();
        this._updateHeatBtn();
        // Blend is deferred to _finalizeLoad which calls v._blend() (GPU or CPU)

        this.dataLoaded = true;
        v.selectedId = null;
        document.getElementById('node-panel').classList.remove('open');
        document.getElementById('loader-screen').classList.add('hidden');
        const canvasEl = document.getElementById('canvas');
        canvasEl.style.display = 'block';
        if (canvasEl.parentElement && canvasEl.parentElement !== document.body) {
            canvasEl.parentElement.style.display = ''; // show GL wrapper
        }
        document.getElementById('loadNewBtn').style.display = '';
        history.replaceState(null, '', location.pathname);

        v.currentLevel = 3; // L4
        v.baseLevel = 3;
        this._pendingSettings = null;
    }

    /** Apply settings + initial render in a single rAF after loadGraph */
    _finalizeLoad(dataset) {
        const v = this.view;
        requestAnimationFrame(async () => {
            // _applyDatasetSettings calls rebuildProjections which blends.
            // If no settings, we need an explicit blend (especially for GPU mode
            // where _applyWorkerResult skips the blend).
            if (dataset?.settings) {
                await this._applyDatasetSettings(dataset.settings);
            } else {
                await v._blend();
            }
            const params = this._restoreFromHash();
            if (params && params.d === dataset?.id) {
                this._applyHashState(params);
            }
            v.resize();
            v.zoomForLevel(v.currentLevel);
            this._updateStepperUI();
            this._updateOverview();
            this._updateAlgoInfo();
            this._scheduleHashUpdate();
        });
    }

    /** Apply GPU projection to already-loaded data. No re-parse, no re-load. */
    async _applyGPUToCurrentData() {
        if (!this._lastEdgesText) return;
        const v = this.view;
        const N = v.nodes.length;
        const G = v.groupNames.length;
        const useGPUProj = v.quantMode !== 'rank' && N * G > 2000;
        console.log(`[GPU] Re-projecting current data, proj=${useGPUProj ? 'GPU' : 'CPU'}`);
        v.showProgress('Re-projecting...');
        const t0 = performance.now();
        try {
            const projFn = useGPUProj ? computeProjectionsGPU : computeProjections;
            const result = await runPipelineGPU(this._lastEdgesText, this._lastNodesText, projFn);
            const G = result.groupNames.length;
            for (let i = 0; i < v.nodes.length; i++) {
                for (let g = 0; g < G; g++) {
                    const off = (i * G + g) * 2;
                    const p = v.nodes[i].projections[result.groupNames[g]];
                    if (p) { p[0] = result.projBuf[off]; p[1] = result.projBuf[off + 1]; }
                }
            }
            v._quantStats = {};
            v.levels = new Array(ZOOM_LEVELS.length).fill(null);
            v._progressText = null;
            await this.rebuildProjections();
            this._updateOverview();
            console.log(`GPU pipeline: ${Math.round(performance.now() - t0)}ms`);
        } catch (err) {
            v._progressText = null;
            v.render();
            console.error('GPU pipeline failed:', err);
        }
    }

    /** Full reload with CPU pipeline and dataset settings. */
    async _reloadCPU() {
        console.log('[CPU] Reloading with CPU worker pipeline...');
        if (!this._lastEdgesText) return;
        await this.loadGraph(this._lastEdgesText, this._lastNodesText);
        const ds = this._currentDatasetId ? DATASETS.find(d => d.id === this._currentDatasetId) : null;
        this._finalizeLoad(ds);
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
            let edgesText, nodesText = null;
            if (dataset.stix) {
                status.textContent = `Fetching ${dataset.name} (STIX)...`;
                const jsonText = await this._fetchText(dataset.stix);
                status.textContent = `Converting ${dataset.name}...`;
                const result = convertStixToSnap(jsonText);
                edgesText = result.edgesText;
                nodesText = result.nodesText;
            } else {
                edgesText = await this._fetchText(dataset.edges);
                if (dataset.nodes) {
                    nodesText = await this._fetchText(dataset.nodes).catch(() => null);
                }
            }
            console.log(`[Load] Dataset: ${dataset.name}, GPU: ${!!this.view.useGPU}`);
            if (this.view.useGPU) {
                await this.loadGraphGPU(edgesText, nodesText, dataset);
            } else {
                await this.loadGraph(edgesText, nodesText);
            }
            this._currentDatasetId = dataset.id;
            this._finalizeLoad(dataset);
        } catch (err) {
            status.textContent = 'Error: ' + err.message;
            status.classList.add('error');
            progressBar.style.display = 'none';
            document.querySelectorAll('.dataset-btn').forEach(b => b.disabled = false);
        }
    }

    showLoaderScreen() {
        if (this.activeWorker) { this.activeWorker.terminate(); this.activeWorker = null; }
        const hadData = this.view && this.view.nodes && this.view.nodes.length > 0;
        this.dataLoaded = false;
        this.pendingEdgesText = null;
        this.pendingNodesText = null;
        document.getElementById('edgesFile').value = '';
        document.getElementById('nodesFile').value = '';
        document.getElementById('loadBtn').disabled = true;
        document.getElementById('loadStatus').textContent = '';
        document.getElementById('loadStatus').classList.remove('error');
        document.getElementById('loadProgress').style.display = 'none';
        document.getElementById('loadProgress').value = 0;
        const canvasEl = document.getElementById('canvas');
        canvasEl.style.display = 'none';
        if (canvasEl.parentElement && canvasEl.parentElement !== document.body) {
            canvasEl.parentElement.style.display = 'none'; // hide GL wrapper
        }
        document.getElementById('loader-screen').classList.remove('hidden');
        document.getElementById('loadNewBtn').style.display = 'none';
        document.getElementById('cancelLoadBtn').style.display = hadData ? '' : 'none';
        document.querySelectorAll('.dataset-btn').forEach(b => b.disabled = false);
    }

    // ─── Event binding ─────────────────────────────────────────────────────────

    _bindEvents() {
        const v = this.view;
        const canvas = v.canvas;
        const sig = { signal: this._abortController.signal };

        // Size-by toggle
        const sizeMemBtn = document.getElementById('sizeByMembers');
        const sizeEdgBtn = document.getElementById('sizeByEdges');
        const updateSizeButtons = () => {
            sizeMemBtn.style.background = v.sizeBy === 'members' ? 'var(--accent)' : '';
            sizeMemBtn.style.color = v.sizeBy === 'members' ? '#fff' : '';
            sizeEdgBtn.style.background = v.sizeBy === 'edges' ? 'var(--accent)' : '';
            sizeEdgBtn.style.color = v.sizeBy === 'edges' ? '#fff' : '';
        };
        this._updateSizeButtons = updateSizeButtons;
        updateSizeButtons();
        sizeMemBtn.addEventListener('click', () => { v.sizeBy = 'members'; updateSizeButtons(); v.render(); }, sig);
        sizeEdgBtn.addEventListener('click', () => { v.sizeBy = 'edges'; updateSizeButtons(); v.render(); }, sig);

        const sizeLogBtn = document.getElementById('sizeLogBtn');
        const updateLogBtn = () => {
            sizeLogBtn.style.background = v.sizeLog ? 'var(--accent)' : '';
            sizeLogBtn.style.color = v.sizeLog ? '#fff' : '';
        };
        this._updateLogBtn = updateLogBtn;
        updateLogBtn();
        sizeLogBtn.addEventListener('click', () => {
            v.sizeLog = !v.sizeLog;
            updateLogBtn();
            v.render();
        }, sig);

        // Quantization mode toggle
        const quantBtn = document.getElementById('quantModeBtn');
        const QUANT_MODES = ['rank', 'gaussian'];
        const QUANT_LABELS = { rank: 'Q:R', gaussian: 'Q:G' };
        const updateQuantBtn = () => {
            quantBtn.textContent = QUANT_LABELS[v.quantMode];
            quantBtn.style.background = v.quantMode !== 'rank' ? 'var(--accent)' : '';
            quantBtn.style.color = v.quantMode !== 'rank' ? '#fff' : '';
        };
        this._updateQuantBtn = updateQuantBtn;
        updateQuantBtn();
        quantBtn.addEventListener('click', () => {
            const idx = QUANT_MODES.indexOf(v.quantMode);
            v.quantMode = QUANT_MODES[(idx + 1) % QUANT_MODES.length];
            v._quantStats = {}; // mode change → fresh boundaries
            updateQuantBtn();
            this.rebuildProjections();
        }, sig);

        // Edge mode toggle
        const edgeBtn = document.getElementById('edgeModeBtn');
        const EDGE_MODES = ['curves', 'lines', 'none'];
        const EDGE_LABELS = { curves: 'E:C', lines: 'E:L', none: 'E:—' };
        const updateEdgeBtn = () => {
            edgeBtn.textContent = EDGE_LABELS[v.edgeMode];
            edgeBtn.style.background = v.edgeMode !== 'none' ? '' : 'var(--accent)';
            edgeBtn.style.color = v.edgeMode !== 'none' ? '' : '#fff';
        };
        this._updateEdgeBtn = updateEdgeBtn;
        updateEdgeBtn();
        edgeBtn.addEventListener('click', () => {
            const idx = EDGE_MODES.indexOf(v.edgeMode);
            v.edgeMode = EDGE_MODES[(idx + 1) % EDGE_MODES.length];
            updateEdgeBtn();
            v.render();
        }, sig);

        // Heatmap toggle
        const heatBtn = document.getElementById('heatmapBtn');
        const HEAT_MODES = ['off', 'splat', 'density'];
        const HEAT_LABELS = { off: 'H', splat: 'H:S', density: 'H:D' };
        const updateHeatBtn = () => {
            heatBtn.textContent = HEAT_LABELS[v.heatmapMode];
            heatBtn.style.background = v.heatmapMode !== 'off' ? 'var(--accent)' : '';
            heatBtn.style.color = v.heatmapMode !== 'off' ? '#fff' : '';
        };
        this._updateHeatBtn = updateHeatBtn;
        updateHeatBtn();
        heatBtn.addEventListener('click', () => {
            const idx = HEAT_MODES.indexOf(v.heatmapMode);
            v.heatmapMode = HEAT_MODES[(idx + 1) % HEAT_MODES.length];
            updateHeatBtn();
            v.render();
        }, sig);

        // Auto-tune button (click to start, click again to stop)
        const autoBtn = document.getElementById('autoTuneBtn');
        let tuneAbort = null;
        const applyTuneResult = async (result) => {
            for (const g of v.groupNames) v.propWeights[g] = result.weights[g] ?? 0;
            v.smoothAlpha = result.alpha;
            v.quantMode = result.quantMode;
            v._quantStats = {};
            // Apply tuned label props
            if (result.labelProps) {
                v.labelProps.clear();
                for (const p of result.labelProps) {
                    if (v.groupNames.includes(p)) v.labelProps.add(p);
                }
                this._syncLabelCheckboxes();
            }
            this._syncWeightUI();
            document.getElementById('nudgeSlider').value = v.smoothAlpha;
            document.getElementById('nudgeVal').textContent = v.smoothAlpha.toFixed(2);
            this._updateQuantBtn();
            v._progressText = null;
            await this.rebuildProjections();
            this._updateOverview();
            autoBtn.textContent = 'Auto';
            autoBtn.style.background = '';
            autoBtn.style.color = '';
            tuneAbort = null;
        };
        autoBtn.addEventListener('click', async () => {
            // If running, abort and apply best so far
            if (tuneAbort) { tuneAbort.abort(); return; }

            tuneAbort = new AbortController();
            autoBtn.style.background = 'var(--accent)';
            autoBtn.style.color = '#fff';
            autoBtn.textContent = 'Stop';
            const result = await autoTuneWeights(v.nodes, v.groupNames, v.adjList, v.nodeIndexFull, {
                weights: true, alpha: true, quant: false,
                signal: tuneAbort.signal,
                onProgress: (info) => {
                    const pct = Math.round(100 * info.step / Math.max(1, info.total));
                    const phase = info.phase === 'presets' ? 'scanning presets'
                        : info.phase === 'done' ? 'done' : 'refining';
                    v.showProgress(`Auto-tuning: ${phase} (${pct}%) — click Stop to apply`);
                },
            });
            await applyTuneResult(result);
            console.log(`Auto-tune: ${result.blends} blends, ${result.quants} quants in ${result.timeMs}ms, score=${result.score.toFixed(3)}`);
        }, sig);

        // GPU toggle: re-project using WebGPU compute. When active, new data loads also use GPU.
        const gpuBtn = document.getElementById('gpuBtn');
        const updateGpuBtn = () => {
            gpuBtn.style.background = v.useGPU ? 'var(--accent)' : '';
            gpuBtn.style.color = v.useGPU ? '#fff' : '';
            gpuBtn.textContent = this._gpuUnavailable ? 'N/A' : 'GPU';
        };
        gpuBtn.addEventListener('click', async () => {
            if (this._gpuUnavailable) return;

            // Toggle off: reload with CPU pipeline
            if (v.useGPU) {
                v.useGPU = false;
                updateGpuBtn();
                await this._reloadCPU();
                return;
            }

            // Toggle on: init GPU, then re-project current data
            gpuBtn.disabled = true;
            gpuBtn.textContent = '...';
            v.showProgress('Initializing GPU...');

            const ok = await initGPU();
            if (!ok) {
                v.showProgress(null);
                this._gpuUnavailable = true;
                updateGpuBtn();
                gpuBtn.disabled = true;
                return;
            }

            v.useGPU = true;
            await this._applyGPUToCurrentData();
            updateGpuBtn();
            gpuBtn.disabled = false;
        }, sig);

        // GL toggle: switch between Canvas 2D and WebGL2 rendering
        const glBtn = document.getElementById('glBtn');
        if (glBtn) {
            const updateGlBtn = () => {
                glBtn.style.background = v.useWebGL ? 'var(--accent)' : '';
                glBtn.style.color = v.useWebGL ? '#fff' : '';
                glBtn.textContent = isWebGL2Available() ? 'GL' : 'N/A';
            };
            if (!isWebGL2Available()) {
                glBtn.textContent = 'N/A';
                glBtn.disabled = true;
            }
            glBtn.addEventListener('click', () => {
                if (!isWebGL2Available()) return;
                v.useWebGL = !v.useWebGL;
                updateGlBtn();
            }, sig);
            updateGlBtn();
        }

        // Sidebar
        document.getElementById('sidebarToggle').addEventListener('click', () => this._toggleSidebar(), sig);
        document.getElementById('sidebarBackdrop')?.addEventListener('click', () => this._toggleSidebar(false), sig);
        document.getElementById('nodePanelClose').addEventListener('click', () => {
            v.selectedId = null;
            document.getElementById('node-panel').classList.remove('open');
            v.render();
        }, sig);

        // Mouse
        canvas.addEventListener('mousedown', e => {
            this.mouseDown = true; this.mouseMoved = false;
            this.mouseStart = { x: e.clientX, y: e.clientY };
        }, sig);
        canvas.addEventListener('mousemove', e => {
            if (!this.mouseDown) {
                const r = canvas.getBoundingClientRect();
                const p = { x: e.clientX - r.left, y: e.clientY - r.top };
                const hit = v.hitTest(p.x, p.y);
                const hid = hit ? (hit.type === 'node' ? hit.item.id : hit.item.bid) : null;
                if (hid !== v.hoveredId) { v.hoveredId = hid; canvas.style.cursor = hid ? 'pointer' : 'grab'; v.render(); }
                return;
            }
            v.pan.x += e.clientX - this.mouseStart.x;
            v.pan.y += e.clientY - this.mouseStart.y;
            this.mouseStart = { x: e.clientX, y: e.clientY };
            if (Math.abs(v.pan.x) > 4 || Math.abs(v.pan.y) > 4) this.mouseMoved = true;
            v.render();
        }, sig);
        let clickTimer = null;
        canvas.addEventListener('mouseup', e => {
            this.mouseDown = false;
            if (!this.mouseMoved) {
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
                const r = canvas.getBoundingClientRect();
                const p = { x: e.clientX - r.left, y: e.clientY - r.top };
                const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
                clickTimer = setTimeout(() => {
                    clickTimer = null;
                    const hit = v.hitTest(p.x, p.y);
                    if (hit) {
                        const id = hit.type === 'node' ? hit.item.id : hit.item.bid;
                        if (isMulti) { v.toggleSelection(id); } else { v.selectedId = id; }
                        this._showDetail(hit);
                    } else if (!isMulti) {
                        v.selectedId = null;
                        document.getElementById('node-panel').classList.remove('open');
                    }
                    v.render();
                }, 250);
            }
        }, sig);
        canvas.addEventListener('mouseleave', () => { this.mouseDown = false; }, sig);
        canvas.addEventListener('dblclick', e => {
            e.preventDefault();
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            const r = canvas.getBoundingClientRect();
            const mx = e.clientX - r.left, my = e.clientY - r.top;
            if (e.shiftKey) {
                this._animateZoom(1 / 2, mx, my);
            } else {
                const hit = v.hitTest(mx, my);
                if (hit) {
                    this.zoomToNode(hit);
                } else {
                    this._animateZoom(2, mx, my);
                }
            }
        }, sig);

        // Touch
        const touchPos = (t) => {
            const r = canvas.getBoundingClientRect();
            return { id: t.identifier, x: t.clientX - r.left, y: t.clientY - r.top };
        };
        const touchDist = (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);

        canvas.addEventListener('touchstart', e => {
            e.preventDefault();
            this.touchMoved = false;
            if (e.touches.length === 1) { this.t1 = touchPos(e.touches[0]); this.t2 = null; }
            else if (e.touches.length === 2) { this.t1 = touchPos(e.touches[0]); this.t2 = touchPos(e.touches[1]); }
        }, { passive: false, signal: this._abortController.signal });

        canvas.addEventListener('touchmove', e => {
            e.preventDefault();
            this.touchMoved = true;
            if (e.touches.length === 1 && !this.t2) {
                const cur = touchPos(e.touches[0]);
                if (this.t1) { v.pan.x += cur.x - this.t1.x; v.pan.y += cur.y - this.t1.y; }
                this.t1 = cur;
                v.render();
            } else if (e.touches.length === 2) {
                const a = touchPos(e.touches[0]), b = touchPos(e.touches[1]);
                if (this.t1 && this.t2) {
                    const factor = touchDist(a, b) / (touchDist(this.t1, this.t2) || 1);
                    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                    const oldRZ = v.renderZoom;
                    v.zoom = Math.max(0.25, Math.min(10000, v.zoom * factor));
                    this._checkAutoLevel();
                    const rf = v.renderZoom / oldRZ;
                    v.pan.x = mx - (mx - v.pan.x) * rf;
                    v.pan.y = my - (my - v.pan.y) * rf;
                    const pmx = (this.t1.x + this.t2.x) / 2, pmy = (this.t1.y + this.t2.y) / 2;
                    v.pan.x += mx - pmx;
                    v.pan.y += my - pmy;
                    v.render();
                }
                this.t1 = a; this.t2 = b;
            }
        }, { passive: false, signal: this._abortController.signal });

        canvas.addEventListener('touchend', e => {
            e.preventDefault();
            if (e.touches.length === 0) {
                if (!this.touchMoved && this.t1) {
                    const hit = v.hitTest(this.t1.x, this.t1.y);
                    if (hit) { v.selectedId = hit.type==='node'?hit.item.id:hit.item.bid; this._showDetail(hit); }
                    else { v.selectedId = null; document.getElementById('node-panel').classList.remove('open'); }
                    v.render();
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
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.05 : 1/1.05;
            const oldRZ = v.renderZoom;
            v.zoom = Math.max(0.25, Math.min(10000, v.zoom * factor));
            this._checkAutoLevel();
            const f = v.renderZoom / oldRZ;
            v.pan.x = mx - (mx - v.pan.x) * f;
            v.pan.y = my - (my - v.pan.y) * f;
            v.render();
        }, { passive: false, signal: this._abortController.signal });

        // Level stepper + keyboard
        document.getElementById('zoomPrev').addEventListener('click', () => {
            if (v.currentLevel > 0) this.switchLevel(v.currentLevel - 1);
        }, sig);
        document.getElementById('zoomNext').addEventListener('click', () => {
            if (v.currentLevel < LEVEL_LABELS.length - 1) this.switchLevel(v.currentLevel + 1);
        }, sig);
        document.getElementById('resetBtn').addEventListener('click', () => {
            v.pan = {x: 0, y: 0};
            v.zoom = 1;
            v.baseLevel = v.currentLevel;
            v.zoomForLevel(v.currentLevel);
            v.render();
        }, sig);

        window.addEventListener('keydown', e => {
            if (!this.dataLoaded) return;
            if (e.key === 'ArrowLeft' && v.currentLevel > 0) {
                e.preventDefault(); this.switchLevel(v.currentLevel - 1);
            } else if (e.key === 'ArrowRight' && v.currentLevel < LEVEL_LABELS.length - 1) {
                e.preventDefault(); this.switchLevel(v.currentLevel + 1);
            } else if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                const oldRZ = v.renderZoom;
                v.zoom = Math.min(10000, v.zoom * 1.15);
                this._checkAutoLevel();
                const f = v.renderZoom / oldRZ;
                v.pan.x = v.W/2 - (v.W/2 - v.pan.x) * f;
                v.pan.y = v.H/2 - (v.H/2 - v.pan.y) * f;
                v.render();
            } else if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                const oldRZ = v.renderZoom;
                v.zoom = Math.max(0.25, v.zoom / 1.15);
                this._checkAutoLevel();
                const f = v.renderZoom / oldRZ;
                v.pan.x = v.W/2 - (v.W/2 - v.pan.x) * f;
                v.pan.y = v.H/2 - (v.H/2 - v.pan.y) * f;
                v.render();
            }
        }, sig);

        // Topology alpha slider
        document.getElementById('nudgeSlider').addEventListener('input', e => {
            if (!this.dataLoaded) return;
            v.smoothAlpha = parseFloat(e.target.value);
            document.getElementById('nudgeVal').textContent = v.smoothAlpha.toFixed(2);
            if (this.smoothDebounceTimer) clearTimeout(this.smoothDebounceTimer);
            this.smoothDebounceTimer = setTimeout(async () => {
                v.levels = new Array(ZOOM_LEVELS.length).fill(null);
                await v._blend();
                v.layoutAll();
                v.render();
                this.smoothDebounceTimer = null;
            }, 120);
        }, sig);

        window.addEventListener('resize', () => { if (this.dataLoaded) v.resize(); }, sig);

        // Load button + file inputs + drop zone
        document.getElementById('loadNewBtn').addEventListener('click', () => this.showLoaderScreen(), sig);
        document.getElementById('cancelLoadBtn').addEventListener('click', () => {
            this.dataLoaded = true;
            document.getElementById('loader-screen').classList.add('hidden');
            const canvasEl = document.getElementById('canvas');
            canvasEl.style.display = 'block';
            if (canvasEl.parentElement && canvasEl.parentElement !== document.body) {
                canvasEl.parentElement.style.display = '';
            }
            document.getElementById('loadNewBtn').style.display = '';
            v.resize();
        }, sig);
        document.getElementById('edgesFile').addEventListener('change', e => {
            const f = e.target.files[0];
            if (!f) return;
            const n = f.name.toLowerCase();
            if (n.endsWith('.json') || n.endsWith('.json.gz')) this._handleStixFile(f);
            else this._handleFileSelect(f, 'edges');
        }, sig);
        document.getElementById('nodesFile').addEventListener('change', e => {
            if (e.target.files[0]) this._handleFileSelect(e.target.files[0], 'labels');
        }, sig);

        const dropZone = document.getElementById('dropZone');
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); }, sig);
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'), sig);
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            for (const f of e.dataTransfer.files) {
                const n = f.name.toLowerCase();
                if (n.endsWith('.json') || n.endsWith('.json.gz')) this._handleStixFile(f);
                else if (n.endsWith('.edges') || n.endsWith('.edges.gz')) this._handleFileSelect(f, 'edges');
                else if (n.endsWith('.nodes') || n.endsWith('.nodes.gz') || n.endsWith('.labels') || n.endsWith('.labels.gz')) this._handleFileSelect(f, 'labels');
            }
        }, sig);

        document.getElementById('loadBtn').addEventListener('click', async () => {
            const progressBar = document.getElementById('loadProgress');
            progressBar.style.display = 'block';
            progressBar.value = 0;
            document.getElementById('loadBtn').disabled = true;
            try {
                if (v.useGPU) await this.loadGraphGPU(this.pendingEdgesText, this.pendingNodesText, null);
                else await this.loadGraph(this.pendingEdgesText, this.pendingNodesText);
                this._finalizeLoad(null);
            }
            catch (_err) { /* shown by worker handler */ }
        }, sig);
    }

    _toggleSidebar(open) {
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebarBackdrop');
        const isOpen = open !== undefined ? open : !sidebar.classList.contains('open');
        sidebar.classList.toggle('open', isOpen);
        if (backdrop) backdrop.classList.toggle('open', isOpen);
    }

    async _fetchText(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
        if (url.endsWith('.gz')) {
            const ds = new DecompressionStream('gzip');
            const reader = resp.body.pipeThrough(ds).getReader();
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            const merged = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
            let off = 0;
            for (const c of chunks) { merged.set(c, off); off += c.length; }
            return new TextDecoder().decode(merged);
        }
        return resp.text();
    }

    async _handleFileSelect(file, type) {
        let text;
        if (file.name.endsWith('.gz')) {
            const buf = await file.arrayBuffer();
            const ds = new DecompressionStream('gzip');
            const reader = ds.readable.getReader();
            const writer = ds.writable.getWriter();
            writer.write(new Uint8Array(buf));
            writer.close();
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            const merged = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
            let off = 0;
            for (const c of chunks) { merged.set(c, off); off += c.length; }
            text = new TextDecoder().decode(merged);
        } else {
            text = await file.text();
        }
        if (type === 'edges') this.pendingEdgesText = text;
        else this.pendingNodesText = text;
        this._updateLoadStatus();
    }

    async _handleStixFile(file) {
        const status = document.getElementById('loadStatus');
        status.textContent = 'Loading STIX 2.1 JSON...';
        status.classList.remove('error');
        try {
            let jsonText;
            if (file.name.endsWith('.gz')) {
                const buf = await file.arrayBuffer();
                const ds = new DecompressionStream('gzip');
                const reader = ds.readable.getReader();
                const writer = ds.writable.getWriter();
                writer.write(new Uint8Array(buf));
                writer.close();
                const chunks = [];
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                }
                const merged = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
                let off = 0;
                for (const c of chunks) { merged.set(c, off); off += c.length; }
                jsonText = new TextDecoder().decode(merged);
            } else {
                jsonText = await file.text();
            }
            status.textContent = 'Converting STIX 2.1 JSON...';
            const result = convertStixToSnap(jsonText);
            this.pendingEdgesText = result.edgesText;
            this.pendingNodesText = result.nodesText;
            status.textContent = `STIX: ${result.stats.nodes} nodes, ${result.stats.edges} edges — ready to load`;
            document.getElementById('loadBtn').disabled = false;
        } catch (err) {
            status.textContent = 'Error: ' + err.message;
            status.classList.add('error');
        }
    }

    _updateLoadStatus() {
        const status = document.getElementById('loadStatus');
        const parts = [];
        if (this.pendingEdgesText) parts.push('edges file ready');
        if (this.pendingNodesText) parts.push('nodes file ready');
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
window.bz = bz;

// Probe WebGPU, then load initial dataset
(async () => {
  try {
    const gpuOk = await initGPU();
    const gpuBtn = document.getElementById('gpuBtn');
    if (gpuOk) {
      bz.view.useGPU = true;
      console.log('[GPU] WebGPU available — GPU mode enabled');
      if (gpuBtn) { gpuBtn.style.background = 'var(--accent)'; gpuBtn.style.color = '#fff'; }
    } else {
      console.log('[GPU] WebGPU not available — using CPU pipeline');
      if (gpuBtn) { gpuBtn.textContent = 'N/A'; gpuBtn.disabled = true; bz._gpuUnavailable = true; }
    }
  } catch (err) {
    console.error('[GPU] WebGPU probe failed:', err);
    const gpuBtn = document.getElementById('gpuBtn');
    if (gpuBtn) { gpuBtn.textContent = 'N/A'; gpuBtn.disabled = true; bz._gpuUnavailable = true; }
  }

  const hashParams = bz._restoreFromHash();
  const hashDataset = hashParams?.d ? DATASETS.find(d => d.id === hashParams.d) : null;
  const startDataset = hashDataset || DATASETS.find(d => d.id === 'epstein');
  if (startDataset) bz.loadDataset(startDataset);
})();

window.addEventListener('hashchange', () => {
    const params = bz._restoreFromHash();
    if (params && params.d === bz._currentDatasetId) {
        bz._applyHashState(params);
    } else if (params?.d) {
        const ds = DATASETS.find(d => d.id === params.d);
        if (ds) bz.loadDataset(ds);
    }
});
