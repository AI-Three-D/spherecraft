/**
 * StudioView — base class for all Spherecraft Studio editor views.
 *
 * Lifecycle (called by Studio.js):
 *   init(context)   — called once on first activation. Receive StudioContext,
 *                     build sidebar DOM, set up any persistent state.
 *   activate()      — called each time the tab is switched to. Start frame loop,
 *                     restore input handlers.
 *   deactivate()    — called when switching away. Pause/cancel frame loop,
 *                     remove input handlers.
 *   destroy()       — called on shutdown. Free GPU resources, remove DOM.
 *
 * Sidebar helpers:
 *   Views receive pre-cleared sidebar containers via context. Populate them in
 *   init() or activate(). The base class provides small DOM-builder helpers.
 *
 * Status bar:
 *   Call this.setStatus(key, value) to update the shared extra status slot.
 */

export class StudioView {
    /** @param {string} id   — matches the tab id, e.g. 'world' */
    constructor(id) {
        this.id = id;
        /** @type {import('./Studio.js').StudioContext|null} */
        this._ctx = null;
        this._initialized = false;
        this._active = false;
        this._rafId = null;
        this._lastTime = 0;
    }

    // ── Lifecycle (override in subclasses) ───────────────────────────

    /**
     * Called once, before first activation.
     * @param {import('./Studio.js').StudioContext} context
     */
    // eslint-disable-next-line no-unused-vars
    async onInit(context) {}

    /** Called each time this tab becomes visible. */
    async onActivate() {}

    /** Called when switching away from this tab. */
    onDeactivate() {}

    /** Called on studio shutdown. Free GPU resources here. */
    onDestroy() {}

    /**
     * Per-frame update. Only called while this view is active.
     * @param {number} dt  seconds since last frame
     * @param {number} t   total elapsed seconds
     */
    // eslint-disable-next-line no-unused-vars
    onUpdate(dt, t) {}

    // ── Internal lifecycle (called by Studio) ────────────────────────

    async _init(context) {
        this._ctx = context;
        await this.onInit(context);
        this._initialized = true;
    }

    async _activate() {
        if (!this._initialized) return;
        this._active = true;
        await this.onActivate();
        this._startLoop();
    }

    _deactivate() {
        this._active = false;
        this._stopLoop();
        this.onDeactivate();
    }

    _destroy() {
        this._deactivate();
        this.onDestroy();
    }

    // ── Frame loop ───────────────────────────────────────────────────

    _startLoop() {
        this._lastTime = performance.now();
        const tick = (now) => {
            if (!this._active) return;
            const dt = Math.min((now - this._lastTime) / 1000, 0.1);
            this._lastTime = now;
            this.onUpdate(dt, now / 1000);
            this._ctx.updateStats();
            this._rafId = requestAnimationFrame(tick);
        };
        this._rafId = requestAnimationFrame(tick);
    }

    _stopLoop() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    // ── Sidebar helpers ──────────────────────────────────────────────

    /**
     * Build a collapsible section inside a sidebar container.
     * Returns the body element for you to append controls into.
     *
     * @param {HTMLElement} container
     * @param {string}      title
     * @param {boolean}     [startOpen=true]
     * @returns {HTMLElement} body div
     */
    _addSection(container, title, startOpen = true) {
        const section = document.createElement('div');
        section.className = 'panel-section';

        const head = document.createElement('div');
        head.className = 'panel-section-head' + (startOpen ? '' : ' collapsed');
        head.innerHTML = `<span>${title}</span><span class="arrow">▼</span>`;

        const body = document.createElement('div');
        body.className = 'panel-section-body' + (startOpen ? '' : ' hidden');

        head.addEventListener('click', () => {
            const collapsed = head.classList.toggle('collapsed');
            body.classList.toggle('hidden', collapsed);
        });

        section.appendChild(head);
        section.appendChild(body);
        container.appendChild(section);
        return body;
    }

    /**
     * Add a labelled range slider row to a section body.
     *
     * @param {HTMLElement} body
     * @param {object}      opts
     * @param {string}      opts.label
     * @param {number}      opts.min
     * @param {number}      opts.max
     * @param {number}      opts.step
     * @param {number}      opts.value
     * @param {function}    opts.onChange  called with (value: number)
     * @returns {{ input: HTMLInputElement, valueEl: HTMLElement }}
     */
    _addSlider(body, { label, min, max, step, value, onChange }) {
        const row = document.createElement('div');
        row.className = 'param-row';

        const lbl = document.createElement('label');
        lbl.textContent = label;

        const input = document.createElement('input');
        input.type = 'range';
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = value;

        const valueEl = document.createElement('span');
        valueEl.className = 'param-value';
        valueEl.textContent = value;

        input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            valueEl.textContent = v.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0);
            onChange(v);
        });

        row.appendChild(lbl);
        row.appendChild(input);
        row.appendChild(valueEl);
        body.appendChild(row);
        return { input, valueEl };
    }

    /**
     * Add a button row to a section body.
     * @param {HTMLElement} body
     * @param {string}      label
     * @param {function}    onClick
     * @returns {HTMLButtonElement}
     */
    _addButton(body, label, onClick) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:4px 12px;';
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = `
            width: 100%;
            padding: 5px 8px;
            background: var(--accent-dim);
            border: 1px solid var(--border-bright);
            color: var(--accent);
            font-size: 11px;
            font-family: inherit;
            cursor: pointer;
            border-radius: 3px;
            letter-spacing: 0.04em;
        `;
        btn.addEventListener('click', onClick);
        row.appendChild(btn);
        body.appendChild(row);
        return btn;
    }

    // ── Convenience ──────────────────────────────────────────────────

    /** Show a brief toast message in the viewport. */
    toast(msg) { this._ctx?.toast(msg); }

    /** Update the extra status slot in the status bar. */
    setExtraStatus(html) {
        const el = document.getElementById('stat-extra');
        if (el) el.innerHTML = html;
    }
}
