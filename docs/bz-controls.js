// bz-controls.js — <bz-controls> web component for BitZoom.
// Strength sliders + bearing dials per property group.
//
// Declarative usage:
//   <bz-graph id="g" edges="data/karate.edges" nodes="data/karate.nodes"></bz-graph>
//   <bz-controls for="g"></bz-controls>
//
// Events:
//   'input'   — continuous during slider/dial drag, detail: { name, strength, bearing }
//   'change'  — on drag end,                        detail: { name, strength, bearing }
//   'colorby' — group label click,                  detail: { name }

class BzControls extends HTMLElement {
  static get observedAttributes() { return ['for', 'max-strength', 'checkboxes']; }

  constructor() {
    super();
    this._groups = [];
    this._maxStrength = 10;
    this._labelProps = new Set();
    this._colorBy = null;
    this._boundView = null;
    this._boundTarget = null;
    this._boundReadyHandler = null;
    this._boundStateHandler = null;
    this._onBoundInput = null;

    this._shadow = this.attachShadow({ mode: 'open' });
    this._shadow.innerHTML = `<style>
      :host { display: block; font: 11px -apple-system, system-ui, sans-serif; color: var(--fg, #dde); }
      .row { display: flex; align-items: center; gap: 6px; padding: 3px 0; min-width: 0; }
      .label { width: 70px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; font-size: 11px; }
      .label:hover { color: var(--accent, #5af); }
      .slider { flex: 1 1 0; min-width: 0; height: 3px; -webkit-appearance: none; appearance: none; background: var(--border, #334); border-radius: 2px; outline: none; cursor: pointer; }
      .slider::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: var(--accent, #5af); cursor: pointer; }
      .slider::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--accent, #5af); border: none; cursor: pointer; }
      .val { font-size: 10px; color: var(--accent, #5af); min-width: 18px; text-align: right; font-family: 'JetBrains Mono', monospace; }
      .dial { width: 20px; height: 20px; border-radius: 50%; border: 0.5px solid var(--border, #334); background: var(--bg, #12122a); opacity: 0.4; position: relative; flex-shrink: 0; cursor: ns-resize; touch-action: none; outline: none; user-select: none; transition: opacity 0.15s, border-color 0.15s; }
      .dial.nonzero { opacity: 0.9; border: 1px solid var(--accent3, #6af7c8); }
      .dial:hover, .dial:focus { opacity: 1; border-color: var(--accent, #5af); }
      .tick { position: absolute; left: 50%; top: 2px; width: 2px; height: 8px; margin-left: -1px; background: var(--accent, #5af); transform-origin: 50% 100%; pointer-events: none; }
      .cb { width: 12px; height: 12px; accent-color: var(--accent, #5af); flex-shrink: 0; }
      .label.active { text-decoration: underline; }
      .container { display: flex; flex-direction: column; }
      .toolbar { display: flex; gap: 4px; justify-content: flex-end; padding: 4px 0 2px; }
      .toolbar button { background: var(--bg, #12122a); color: var(--fg, #dde); border: 1px solid var(--border, #334); font: bold 10px -apple-system, system-ui, sans-serif; padding: 2px 6px; border-radius: 3px; cursor: pointer; line-height: 1.2; }
      .toolbar button:hover { border-color: var(--accent, #5af); color: var(--accent, #5af); }
    </style><div class="container"></div>`;
    this._container = this._shadow.querySelector('.container');
  }

  connectedCallback() {
    const forId = this.getAttribute('for');
    if (forId) this._bindToGraph(forId);
  }

  disconnectedCallback() {
    this._unbind();
  }

  attributeChangedCallback(name, _old, val) {
    if (name === 'for') this._bindToGraph(val);
    else if (name === 'max-strength') { this._maxStrength = parseFloat(val) || 10; this._rebuild(); }
    else if (name === 'checkboxes') this._rebuild();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  get groups() { return this._groups; }
  set groups(arr) {
    this._groups = (arr || []).map(g => ({ ...g }));
    this._rebuild();
  }

  get maxStrength() { return this._maxStrength; }
  set maxStrength(v) { this._maxStrength = v; this._rebuild(); }

  get labelProps() { return this._labelProps; }
  set labelProps(s) { this._labelProps = s instanceof Set ? s : new Set(s || []); this._syncCheckboxes(); }

  get colorBy() { return this._colorBy; }
  set colorBy(v) { this._colorBy = v; this._syncColorBy(); }

  update(name, strength, bearing) {
    const g = this._groups.find(g => g.name === name);
    if (!g) return;
    g.strength = strength;
    g.bearing = bearing;
    this._syncRow(name);
  }

  updateAll(arr) {
    for (const src of arr) {
      const g = this._groups.find(g => g.name === src.name);
      if (g) {
        g.strength = src.strength;
        g.bearing = src.bearing;
        if (src.color) g.color = src.color;
      }
    }
    this._syncAllRows();
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  _rebuild() {
    this._container.innerHTML = '';

    // Toolbar with 0 and A buttons
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.innerHTML = `<button data-action="zero" title="Reset all to zero">0</button><button data-action="auto" title="Auto-tune strengths and bearings">A</button>`;
    this._container.appendChild(toolbar);
    toolbar.addEventListener('click', (e) => {
      const action = e.target.dataset?.action;
      if (action === 'zero') {
        for (const g of this._groups) { g.strength = 0; g.bearing = 0; }
        this._syncAllRows();
        for (const g of this._groups) {
          this.dispatchEvent(new CustomEvent('change', { detail: { name: g.name, strength: 0, bearing: 0 }, bubbles: true }));
        }
      } else if (action === 'auto') {
        this.dispatchEvent(new Event('autotune', { bubbles: true }));
      }
    });

    for (const g of this._groups) {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.group = g.name;
      const deg = Math.round(((g.bearing || 0) * 180 / Math.PI) % 360 + 360) % 360;

      const showCb = this.hasAttribute('checkboxes');
      const checked = this._labelProps.has(g.name);
      row.innerHTML = `${showCb ? `<input class="cb" type="checkbox" title="Include in label"${checked ? ' checked' : ''}>` : ''}
        <span class="label${this._colorBy === g.name ? ' active' : ''}" title="Color by ${g.name}">${g.name}</span>
        <input class="slider" type="range" min="0" max="${this._maxStrength}" step="0.1" value="${g.strength || 0}">
        <span class="val">${Math.round((g.strength || 0) * 10) / 10}</span>
        <div class="dial${deg ? ' nonzero' : ''}" tabindex="0" role="slider"
             aria-label="Bearing for ${g.name}" aria-valuemin="0" aria-valuemax="359" aria-valuenow="${deg}"
             aria-valuetext="${deg} degrees">
          <div class="tick" style="transform:rotate(${deg}deg)"></div>
        </div>`;
      this._container.appendChild(row);

      // Slider events
      const slider = row.querySelector('.slider');
      const valSpan = row.querySelector('.val');
      slider.addEventListener('input', () => {
        g.strength = parseFloat(slider.value);
        valSpan.textContent = Math.round(g.strength * 10) / 10;
        this._emit('input', g);
      });
      slider.addEventListener('change', () => this._emit('change', g));

      // Checkbox → labelchange
      const cb = row.querySelector('.cb');
      if (cb) {
        cb.addEventListener('change', () => {
          if (cb.checked) this._labelProps.add(g.name); else this._labelProps.delete(g.name);
          this.dispatchEvent(new CustomEvent('labelchange', {
            detail: { name: g.name, checked: cb.checked, labelProps: [...this._labelProps] },
            bubbles: true,
          }));
        });
      }

      // Label click → colorby
      row.querySelector('.label').addEventListener('click', () => {
        this._colorBy = this._colorBy === g.name ? null : g.name;
        this._syncColorBy();
        this.dispatchEvent(new CustomEvent('colorby', { detail: { name: g.name }, bubbles: true }));
      });

      // Bearing dial
      this._wireDial(row.querySelector('.dial'), g);
    }
  }

  _syncRow(name) {
    const row = this._container.querySelector(`[data-group="${CSS.escape(name)}"]`);
    if (!row) return;
    const g = this._groups.find(g => g.name === name);
    if (!g) return;
    const slider = row.querySelector('.slider');
    const valSpan = row.querySelector('.val');
    const dial = row.querySelector('.dial');
    const tick = dial?.querySelector('.tick');
    if (slider) slider.value = g.strength;
    if (valSpan) valSpan.textContent = Math.round(g.strength * 10) / 10;
    if (dial && tick) {
      const d = Math.round(((g.bearing || 0) * 180 / Math.PI) % 360 + 360) % 360;
      tick.style.transform = `rotate(${d}deg)`;
      dial.classList.toggle('nonzero', d !== 0);
      dial.setAttribute('aria-valuenow', String(d));
      dial.setAttribute('aria-valuetext', `${d} degrees`);
    }
  }

  _syncAllRows() {
    for (const g of this._groups) this._syncRow(g.name);
  }

  _syncCheckboxes() {
    for (const row of this._container.children) {
      const cb = row.querySelector('.cb');
      if (cb) cb.checked = this._labelProps.has(row.dataset.group);
    }
  }

  _syncColorBy() {
    for (const row of this._container.children) {
      const label = row.querySelector('.label');
      if (label) label.classList.toggle('active', this._colorBy === row.dataset.group);
    }
  }

  _emit(type, g) {
    this.dispatchEvent(new CustomEvent(type, {
      detail: { name: g.name, strength: g.strength, bearing: g.bearing || 0 },
      bubbles: true,
    }));
  }

  // ─── Bearing dial ───────────────────────────────────────────────────────────

  _wireDial(dial, g) {
    const tick = dial.querySelector('.tick');
    const PIXELS_PER_ROTATION = 200;

    const setDeg = (deg) => {
      let d = Math.round(deg) % 360;
      if (d < 0) d += 360;
      if (d <= 5 || d >= 355) d = 0;
      tick.style.transform = `rotate(${d}deg)`;
      dial.classList.toggle('nonzero', d !== 0);
      dial.setAttribute('aria-valuenow', String(d));
      dial.setAttribute('aria-valuetext', `${d} degrees`);
      g.bearing = d * Math.PI / 180;
    };

    let dragging = false, startY = 0, startDeg = 0;
    dial.addEventListener('pointerdown', e => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); setDeg(0); this._emit('change', g); return; }
      e.preventDefault();
      dial.focus();
      dragging = true;
      startY = e.clientY;
      startDeg = parseInt(dial.getAttribute('aria-valuenow') || '0', 10);
      dial.setPointerCapture(e.pointerId);
    });
    dial.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dy = startY - e.clientY;
      const sensitivity = e.shiftKey ? PIXELS_PER_ROTATION * 4 : PIXELS_PER_ROTATION;
      setDeg(startDeg + (dy / sensitivity) * 360);
      this._emit('input', g);
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { dial.releasePointerCapture(e.pointerId); } catch (_) {}
      this._emit('change', g);
    };
    dial.addEventListener('pointerup', endDrag);
    dial.addEventListener('pointercancel', endDrag);
    dial.addEventListener('dblclick', e => { e.preventDefault(); setDeg(0); this._emit('change', g); });

    dial.addEventListener('keydown', e => {
      const current = parseInt(dial.getAttribute('aria-valuenow') || '0', 10);
      const step = e.shiftKey ? 45 : 15;
      let consumed = false;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setDeg(current + step); consumed = true; }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setDeg(current - step); consumed = true; }
      else if (e.key === 'Home' || e.key === '0') { setDeg(0); consumed = true; }
      if (consumed) { e.preventDefault(); e.stopPropagation(); this._emit('input', g); }
    });
  }

  // ─── Auto-bind to <bz-graph> ────────────────────────────────────────────────

  _unbind() {
    if (this._boundView && this._boundStateHandler) {
      this._boundView.canvas.removeEventListener('statechange', this._boundStateHandler);
      this._boundStateHandler = null;
    }
    if (this._boundReadyHandler) {
      this._boundTarget?.removeEventListener('ready', this._boundReadyHandler);
      this._boundReadyHandler = null;
      this._boundTarget = null;
    }
    if (this._onBoundInput) { this.removeEventListener('input', this._onBoundInput); this._onBoundInput = null; }
    this._boundView = null;
  }

  _bindToGraph(id) {
    this._unbind();
    if (!id) return;

    const el = document.getElementById(id);
    if (!el) return;

    const attach = () => {
      const view = el.view;
      if (!view || !view.groupNames || !view.groupNames.length) return;
      this._boundView = view;
      this._syncFromView();

      // Push control changes → view
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
            view._blend(true).then(() => { view.layoutAll(); view.render(); });
          });
        }
      });

      // Pull view changes → controls
      this._boundStateHandler = () => this._syncFromView();
      view.canvas.addEventListener('statechange', this._boundStateHandler);
    };

    if (el.view) attach();
    else {
      this._boundTarget = el;
      this._boundReadyHandler = () => attach();
      el.addEventListener('ready', this._boundReadyHandler, { once: true });
    }
  }

  _syncFromView() {
    const v = this._boundView;
    if (!v) return;
    const skip = new Set(['label', 'structure', 'neighbors']);
    const groups = v.groupNames.filter(g => !skip.has(g)).map(g => {
      const cmap = v.propColors && v.propColors[g];
      const color = cmap ? Object.values(cmap)[0] || '#888' : '#888';
      return { name: g, color, strength: v.propStrengths[g] || 0, bearing: v.propBearings[g] || 0 };
    });
    if (this._groups.length === groups.length) {
      const same = groups.every((g, i) => {
        const o = this._groups[i];
        return o && o.name === g.name && o.strength === g.strength && o.bearing === g.bearing;
      });
      if (same) return;
      this.updateAll(groups);
    } else {
      this.groups = groups;
    }
  }
}

customElements.define('bz-controls', BzControls);
export { BzControls };
