// bz-graph.js — <bz-graph> web component for BitZoom.
//
// Usage:
//   <!-- Prevent flash of inline text before component loads -->
//   <style>bz-graph:not(:defined) { visibility: hidden; }</style>
//
//   <bz-graph edges="data/karate.edges" nodes="data/karate.nodes"
//             level="3" heatmap="density" legend color-scheme="viridis">
//   </bz-graph>
//
//   <bz-graph format="json">
//     {"nodes":[{"id":"a","group":"x"},{"id":"b","group":"y"}],
//      "edges":[{"src":"a","dst":"b"}]}
//   </bz-graph>
//
//   <bz-graph format="snap">
//     # From	To
//     alice	bob
//     bob	carol
//   </bz-graph>

import { createBitZoomView, createBitZoomFromGraph } from './bitzoom-canvas.js';
import { SCHEME_VIVID } from './bitzoom-colors.js';
import { classifyFiles } from './bitzoom-parsers.js';
import './bz-compass.js';
import './bz-controls.js';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const ATTR_MAP = {
  'level':        { prop: 'initialLevel', type: 'int', default: 3 },
  'heatmap':      { prop: 'heatmapMode',  type: 'string', default: 'off' },
  'edge-mode':    { prop: 'edgeMode',     type: 'string', default: 'curves' },
  'quant':        { prop: 'quantMode',    type: 'string', default: 'gaussian' },
  'alpha':        { prop: 'smoothAlpha',  type: 'float', default: 0 },
  'color-scheme': { prop: 'colorScheme',  type: 'int', default: SCHEME_VIVID },
  'size-by':      { prop: 'sizeBy',       type: 'string', default: 'edges' },
  'webgl':        { prop: 'webgl',        type: 'bool', default: false },
  'auto-gpu':     { prop: 'autoGPU',      type: 'bool', default: true },
  'use-gpu':      { prop: 'useGPU',      type: 'bool', default: false },
  'color-by':     { prop: 'colorBy',    type: 'string', default: null },
  'auto-tune':    { prop: 'autoTune',     type: 'json', default: null },
};

const BOOL_ATTRS = ['legend', 'reset-btn', 'light-mode', 'size-log', 'webgl', 'auto-gpu', 'compass', 'controls'];

function parseAttr(value, type) {
  if (value === null || value === undefined) return undefined;
  switch (type) {
    case 'int': return parseInt(value, 10) || 0;
    case 'float': return parseFloat(value) || 0;
    case 'bool': return value !== 'false' && value !== '0';
    case 'string': return value;
    case 'json': try { return JSON.parse(value); } catch { return null; }
    default: return value;
  }
}

class BzGraph extends HTMLElement {
  static get observedAttributes() {
    return ['edges', 'nodes', 'format', ...Object.keys(ATTR_MAP), ...BOOL_ATTRS];
  }

  constructor() {
    super();
    this._view = null;
    this._shadow = this.attachShadow({ mode: 'open' });
    this._shadow.innerHTML = `<style>
      :host { display: block; position: relative; }
      .wrap { width: 100%; height: 100%; position: relative; }
      canvas { width: 100%; height: 100%; display: block; background: var(--bz-bg, #12122a); outline: none; }
      canvas:focus { box-shadow: inset 0 0 0 1px rgba(124,106,247,0.3); }
      :host(.dragover) { outline: 2px dashed var(--accent, #7c6af7); outline-offset: -2px; }
      .visually-hidden, .visually-hidden-focusable:not(:focus):not(:focus-within) { position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0; }
      :host(.a11y-debug) .visually-hidden { all:revert; position:absolute; z-index:9999; left:0; background:rgba(0,0,10,0.85); color:#dde; font:10px/1.5 'JetBrains Mono',monospace; padding:6px 8px; pointer-events:none; }
      :host(.a11y-debug) [aria-live] { top:0; right:0; }
      :host(.a11y-debug) table.visually-hidden { bottom:0; height:33%; width:80%; overflow-y:auto !important; display:block; }
      :host(.a11y-debug) .visually-hidden table { color:inherit; font:inherit; border-collapse:collapse; width:100%; }
      :host(.a11y-debug) .visually-hidden th, :host(.a11y-debug) .visually-hidden td { text-align:left; padding:1px 6px; }
      :host(.a11y-debug) .visually-hidden th { color:#889; }
    </style><div class="wrap"><canvas></canvas></div>
    <div class="visually-hidden" aria-live="polite" aria-atomic="true"></div>
    <table class="visually-hidden" role="table" aria-label="Graph nodes"><thead><tr><th>Name</th><th>Group</th><th>Connections</th></tr></thead><tbody></tbody></table>`;
    this._canvas = this._shadow.querySelector('canvas');
    this._ariaLive = this._shadow.querySelector('[aria-live]');
    this._summaryBody = this._shadow.querySelector('tbody');
  }

  connectedCallback() {
    // Defer to allow inner text content to be parsed
    requestAnimationFrame(() => this._init());
    // Drop zone for files (opt-in via `drop-zone` attribute)
    if (this.hasAttribute('drop-zone')) {
      this.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; this.classList.add('dragover'); });
      this.addEventListener('dragleave', () => this.classList.remove('dragover'));
      this.addEventListener('drop', e => { e.preventDefault(); this.classList.remove('dragover'); this._handleDrop(e.dataTransfer.files); });
    }
  }

  disconnectedCallback() {
    if (this._view) { this._view.destroy(); this._view = null; }
    if (this._compassPanel) { this._compassPanel.remove(); this._compassPanel = null; }
    if (this._controlsPanel) { this._controlsPanel.remove(); this._controlsPanel = null; }
  }

  async _init() {
    if (this._view) return;
    const opts = this._buildOpts();
    const edgesUrl = this.getAttribute('edges');
    const nodesUrl = this.getAttribute('nodes');
    const format = this.getAttribute('format');
    const inline = this.textContent.trim();

    if (edgesUrl) {
      // File mode: fetch SNAP files
      const [edgesText, nodesText] = await Promise.all([
        fetch(edgesUrl).then(r => r.text()),
        nodesUrl ? fetch(nodesUrl).then(r => r.text()).catch(() => null) : Promise.resolve(null),
      ]);
      this._view = createBitZoomView(this._canvas, edgesText, nodesText, opts);
    } else if (inline && format === 'json') {
      // Inline JSON mode
      const data = JSON.parse(inline);
      const nodes = data.nodes || [];
      const edges = data.edges || [];
      this._view = createBitZoomFromGraph(this._canvas, nodes, edges, opts);
    } else if (inline) {
      // Inline SNAP mode (default for raw text)
      const lines = inline.split('\n');
      // Split into edges text and optional nodes text (separated by blank line + # header)
      let edgesText = inline;
      let nodesText = null;
      const sepIdx = lines.findIndex((l, i) => i > 0 && l.startsWith('# ') && lines[i - 1].trim() === '');
      if (sepIdx > 0) {
        edgesText = lines.slice(0, sepIdx - 1).join('\n');
        nodesText = lines.slice(sepIdx).join('\n');
      }
      this._view = createBitZoomView(this._canvas, edgesText, nodesText, opts);
    }
    // a11y debug toggle (handled via canvas keydown — canvas has tabindex from BitZoomCanvas)
    this._canvas.addEventListener('keydown', e => {
      if (e.key === 'a') this.classList.toggle('a11y-debug');
    });

    // Create floating panels (default: on, disable with compass="false" or controls="false")
    // Panels start hidden; toggle with r/R keyboard shortcuts after clicking graph
    if (this.getAttribute('compass') !== 'false') this._createCompassPanel();
    if (this.getAttribute('controls') !== 'false') this._createControlsPanel();

    this.dispatchEvent(new Event('ready'));
  }

  /** Tear down current view and panels, rebuild with new data. */
  _reload(edgesText, nodesText, parsed) {
    if (this._view) { this._view.destroy(); this._view = null; }
    if (this._compassPanel) { this._compassPanel.remove(); this._compassPanel = null; }
    if (this._controlsPanel) { this._controlsPanel.remove(); this._controlsPanel = null; }
    // Clear stale attributes so autotune results aren't overridden
    this.removeAttribute('strengths');
    this.removeAttribute('weights');
    this.removeAttribute('label-props');
    this.removeAttribute('alpha');
    this.removeAttribute('quant');
    const opts = this._buildOpts();
    opts.autoTune = { strengths: true, alpha: true };

    if (parsed) {
      // Object pipeline: CSV, D3, JGF, GraphML, GEXF, Cytoscape, STIX, bare JSON, nodes-only
      const nodes = [];
      for (const [id, n] of parsed.nodes) {
        const obj = { id, group: n.group, label: n.label };
        if (n.extraProps) Object.assign(obj, n.extraProps);
        nodes.push(obj);
      }
      this._view = createBitZoomFromGraph(this._canvas, nodes, parsed.edges || [], opts);
    } else {
      // SNAP text pipeline
      this._view = createBitZoomView(this._canvas, edgesText, nodesText, opts);
    }

    if (this.getAttribute('compass') !== 'false') this._createCompassPanel();
    if (this.getAttribute('controls') !== 'false') this._createControlsPanel();
    this.dispatchEvent(new Event('ready'));
  }

  /** Handle dropped files — classifies via shared utility, then reloads. */
  async _handleDrop(files) {
    if (!files.length) return;
    const { edgesText, nodesText, parsed } = await classifyFiles([...files]);
    if (parsed) this._reload(null, null, parsed);
    else if (edgesText || nodesText) this._reload(edgesText, nodesText, null);
  }

  _createPanel(className, title) {
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;z-index:100;background:rgba(17,17,24,0.95);border:1px solid #2a2a4a;border-radius:8px;overflow:auto;min-width:140px;display:none;box-shadow:0 4px 16px rgba(0,0,0,0.4);resize:both;';
    if (className === 'compass-panel') panel.style.cssText += 'width:220px;height:240px;';
    else panel.style.cssText += 'width:220px;';
    panel.innerHTML = `<div class="panel-bar" style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;cursor:move;font:10px -apple-system,system-ui,sans-serif;color:#8888a0;user-select:none;border-bottom:1px solid #2a2a4a;background:rgba(10,10,15,0.8)"><span>${title}</span><button style="background:none;border:none;color:#8888a0;font-size:14px;cursor:pointer;padding:0 2px;line-height:1" aria-label="Close">&times;</button></div>`;
    document.body.appendChild(panel);

    // Close button
    panel.querySelector('button').addEventListener('click', () => { panel.style.display = 'none'; });

    // Draggable title bar
    const bar = panel.querySelector('.panel-bar');
    let dragging = false, dx = 0, dy = 0;
    bar.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      dragging = true;
      dx = e.clientX - panel.offsetLeft;
      dy = e.clientY - panel.offsetTop;
    });
    const onMove = e => { if (dragging) { panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; } };
    const onUp = () => { dragging = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    bar.addEventListener('touchstart', e => {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      dragging = true;
      dx = e.touches[0].clientX - panel.offsetLeft;
      dy = e.touches[0].clientY - panel.offsetTop;
    }, { passive: false });
    window.addEventListener('touchmove', e => { if (dragging) { panel.style.left = (e.touches[0].clientX - dx) + 'px'; panel.style.top = (e.touches[0].clientY - dy) + 'px'; panel.style.right = 'auto'; } }, { passive: true });
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);

    return panel;
  }

  _togglePanel(panel) {
    if (panel.style.display !== 'none') {
      panel.style.display = 'none';
    } else {
      panel.style.display = '';
      if (!panel.dataset.placed) {
        panel.dataset.placed = '1';
        const rect = this.getBoundingClientRect();
        const isCompass = panel === this._compassPanel;
        panel.style.left = (rect.left + (isCompass ? rect.width - 230 : 10)) + 'px';
        panel.style.top = (rect.top + 10) + 'px';
      }
    }
  }

  _createCompassPanel() {
    const panel = this._createPanel('compass-panel', 'Compass');
    this._compassPanel = panel;
    const compass = document.createElement('bz-compass');
    compass.style.cssText = 'display:block;width:100%;height:calc(100% - 26px);';
    panel.appendChild(compass);

    // Sync from view
    const sync = () => {
      if (!this._view) return;
      const v = this._view;
      const groups = v.groupNames.filter(g => g !== 'label' && g !== 'structure' && g !== 'neighbors').map(g => ({
        name: g, color: (v.propColors[g] && Object.values(v.propColors[g])[0]) || '#888',
        strength: v.propStrengths[g] || 0, bearing: v.propBearings[g] || 0,
      }));
      if (compass.groups.length === groups.length) compass.updateAll(groups);
      else compass.groups = groups;
    };
    this._canvas.addEventListener('statechange', sync);
    sync(); // initial sync — statechange already fired during init

    // Push compass changes → view
    let pending = false;
    const onCompassChange = (e) => {
      const { name, strength, bearing } = e.detail;
      this._view.propStrengths[name] = strength;
      this._view.propBearings[name] = bearing;
      if (!pending) {
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          const v = this._view;
          v._quantStats = {};
          v.levels = new Array(v.levels.length).fill(null);
          v._blend().then(() => { v.layoutAll(); v.render(); });
        });
      }
    };
    compass.addEventListener('input', onCompassChange);
    compass.addEventListener('change', onCompassChange);
    compass.addEventListener('autotune', () => this._runAutotune());
  }

  async _runAutotune() {
    if (this._tuneAbort) { this._tuneAbort.abort(); return; }
    try {
      this._tuneAbort = new AbortController();
      const { autoTuneStrengths, autoTuneBearings } = await import('./bitzoom-utils.js');
      const v = this._view;
      const result = await autoTuneStrengths(v.nodes, v.groupNames, v.adjList, v.nodeIndexFull, {
        strengths: true, alpha: true, signal: this._tuneAbort.signal,
      });
      for (const g of v.groupNames) v.propStrengths[g] = result.strengths[g] ?? 0;
      v.smoothAlpha = result.alpha;
      v.quantMode = result.quantMode;
      v._quantStats = {};
      const bearings = autoTuneBearings(v.nodes, v.groupNames, result.strengths);
      v.propBearings = bearings;
      v.levels = new Array(v.levels.length).fill(null);
      await v._blend();
      v.layoutAll();
      v.render();
    } catch (e) { console.warn('[bz-graph] autotune failed:', e.message); }
    this._tuneAbort = null;
  }

  _createControlsPanel() {
    const panel = this._createPanel('controls-panel', 'Controls');
    this._controlsPanel = panel;
    const controls = document.createElement('bz-controls');
    controls.setAttribute('checkboxes', '');
    controls.style.cssText = 'display:block;padding:6px;';
    panel.appendChild(controls);

    // Sync from view
    const sync = () => {
      if (!this._view) return;
      const v = this._view;
      const groups = v.groupNames.map(g => ({
        name: g, strength: v.propStrengths[g] || 0, bearing: v.propBearings[g] || 0,
      }));
      if (controls.groups.length === groups.length) controls.updateAll(groups);
      else controls.groups = groups;
      controls.labelProps = v.labelProps;
    };
    this._canvas.addEventListener('statechange', sync);
    sync(); // initial sync — statechange already fired during init

    // Push changes → view
    let pending = false;
    const onControlsChange = (e) => {
      const { name, strength, bearing } = e.detail;
      this._view.propStrengths[name] = strength;
      this._view.propBearings[name] = bearing;
      if (!pending) {
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          const v = this._view;
          v._quantStats = {};
          v.levels = new Array(v.levels.length).fill(null);
          v._blend().then(() => { v.layoutAll(); v.render(); });
        });
      }
    };
    controls.addEventListener('input', onControlsChange);
    controls.addEventListener('change', onControlsChange);
    controls.addEventListener('labelchange', e => {
      this._view.labelProps = new Set(e.detail.labelProps);
      this._view._refreshPropCache();
      this._view.render();
    });
    controls.addEventListener('colorby', e => {
      const v = this._view;
      v.colorBy = (v.colorBy === e.detail.name) ? null : e.detail.name;
    });
    controls.addEventListener('autotune', () => this._runAutotune());
  }

  _buildOpts() {
    const opts = {};
    // Panel toggle shortcuts via onKeydown callback (called by BitZoomCanvas before its own handler)
    opts.onKeydown = (e) => {
      if (e.key === 'r' && !e.shiftKey && this._compassPanel) { this._togglePanel(this._compassPanel); return true; }
      if (e.key === 'R' && this._controlsPanel) { this._togglePanel(this._controlsPanel); return true; }
      return false;
    };
    // Accessibility: wire onAnnounce to shadow DOM aria-live region
    opts.onAnnounce = (text) => {
      if (this._ariaLive) this._ariaLive.textContent = text;
    };
    opts.onSummary = (rows) => {
      if (!this._summaryBody) return;
      this._summaryBody.innerHTML = rows.map(r =>
        `<tr><td>${esc(r.label)}</td><td>${esc(r.group)}</td><td>${r.connections}</td></tr>`
      ).join('');
    };
    // Strengths from attribute: strengths="group:5,kind:8" (also accepts deprecated weights="...")
    const strengthsAttr = this.getAttribute('strengths') || this.getAttribute('weights');
    if (strengthsAttr) {
      opts.strengths = {};
      for (const pair of strengthsAttr.split(',')) {
        const [k, v] = pair.split(':');
        if (k && v) opts.strengths[k.trim()] = parseFloat(v.trim()) || 0;
      }
    }
    // Label props from attribute: label-props="label,group"
    const labelPropsAttr = this.getAttribute('label-props');
    if (labelPropsAttr) {
      opts.labelProps = labelPropsAttr.split(',').map(s => s.trim());
    }
    // Mapped attributes
    for (const [attr, def] of Object.entries(ATTR_MAP)) {
      const raw = this.getAttribute(attr);
      if (raw !== null) opts[def.prop] = parseAttr(raw, def.type);
    }
    // Boolean attributes — legend defaults to true
    if (this.getAttribute('legend') !== 'false') opts.showLegend = true;
    if (this.hasAttribute('reset-btn')) opts.showResetBtn = true;
    if (this.hasAttribute('light-mode')) opts.lightMode = true;
    if (this.hasAttribute('size-log')) opts.sizeLog = true;
    return opts;
  }

  // Public API: access the underlying BitZoomCanvas
  get view() { return this._view; }

  attributeChangedCallback(name, oldVal, newVal) {
    if (!this._view || oldVal === newVal) return;
    const v = this._view;
    switch (name) {
      case 'level': v.switchLevel(parseInt(newVal) || 0); break;
      case 'alpha': v.setAlpha(parseFloat(newVal) || 0); break;
      case 'color-scheme': v.colorScheme = parseInt(newVal) || 0; break;
      case 'light-mode': v.lightMode = this.hasAttribute('light-mode'); break;
      case 'legend': v.showLegend = this.hasAttribute('legend') ? 1 : 0; v.render(); break;
      case 'heatmap': v.setOptions({ heatmapMode: newVal || 'off' }); v.render(); break;
      case 'edge-mode': v.setOptions({ edgeMode: newVal || 'curves' }); v.render(); break;
      case 'color-by': v.colorBy = newVal || null; break;
    }
  }
}

customElements.define('bz-graph', BzGraph);

export { BzGraph };
