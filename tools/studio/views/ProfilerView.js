/**
 * ProfilerView — GPU and CPU frame performance profiler.
 *
 * Planned features:
 *   - No 3D viewport needed: this is a pure data dashboard
 *   - GPU pass timings via WebGPU GPUQuerySet (timestamp queries)
 *     Passes: terrain, particles, bloom-downsample, bloom-upsample,
 *             bloom-composite, distortion, tone-map, total frame
 *   - CPU timings: JS per-system per frame (scheduler, streamer, animation, UI)
 *   - Frame timeline: scrolling bar chart, last N frames
 *   - Memory panel: GPU buffer allocations, texture memory (estimated from size/format)
 *   - Bottleneck advisor: simple heuristic flags (e.g. "bloom > 4ms — consider
 *     reducing resolution or passes")
 *
 * Wire-up:
 *   - Frontend must expose a getFrameStats() method returning:
 *       { gpu: { passName: ms, ... }, cpu: { systemName: ms, ... }, memory: { ... } }
 *   - GPUQuerySet timestamps: need to be added to each pass in the postprocessing pipeline
 *
 * TODO: implement GPUQuerySet integration in PostProcessingPipeline.
 * TODO: implement CPU timing in Frontend.tick() using performance.now() brackets.
 */

import { StudioView } from '../StudioView.js';

const PASS_COLORS = {
    terrain:          '#4db8ff',
    particles:        '#ff7a45',
    bloom_down:       '#a78bfa',
    bloom_up:         '#c084fc',
    bloom_composite:  '#e879f9',
    distortion:       '#34d399',
    tone_map:         '#fbbf24',
    total:            '#f9fafb',
};

const HISTORY_LEN = 120; // frames of history

export class ProfilerView extends StudioView {
    get usesCanvas() { return false; }

    constructor(id) {
        super(id);
        /** @type {Array<{gpu:{},cpu:{},ts:number}>} */
        this._history = [];
        this._paused  = false;
    }

    async onInit(context) {
        this._ctx = context;
        context.sidebarLeftTitle.textContent  = 'Filters';
        context.sidebarRightTitle.textContent = 'Advisor';
        this._buildDashboard(context);
        this._buildLeftSidebar(context.sidebarLeft);
        this._buildRightSidebar(context.sidebarRight);
    }

    async onActivate() {
        this.setExtraStatus('<span class="label">Recording</span> <span class="value" id="profiler-state">live</span>');
        console.log('[ProfilerView] activated');
    }

    onDeactivate() {}

    onUpdate(_dt, _t) {
        if (this._paused) return;

        // TODO: pull real stats from Frontend.getFrameStats()
        // For now, generate placeholder data
        const fakeStats = this._fakeSample();
        this._history.push(fakeStats);
        if (this._history.length > HISTORY_LEN) this._history.shift();
        this._renderTimeline();
        this._updatePassTable(fakeStats);
    }

    // ── Dashboard (injected into viewport area) ───────────────────────

    _buildDashboard(context) {
        const wrap = document.getElementById('viewport-wrap');

        const dash = document.createElement('div');
        dash.style.cssText = `
            position:absolute; inset:0; display:flex; flex-direction:column;
            padding:16px; gap:12px; overflow-y:auto; background:var(--bg-deep);
        `;

        // Title row
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex; align-items:center; gap:12px;';
        titleRow.innerHTML = `
            <span style="font-size:13px;font-weight:600;color:var(--text-bright);">Frame Profiler</span>
        `;
        const pauseBtn = document.createElement('button');
        pauseBtn.textContent = 'Pause';
        pauseBtn.style.cssText = `
            padding:3px 10px; background:var(--accent-dim); border:1px solid var(--border-bright);
            color:var(--accent); font-size:11px; font-family:inherit; cursor:pointer; border-radius:3px;
        `;
        pauseBtn.addEventListener('click', () => {
            this._paused = !this._paused;
            pauseBtn.textContent = this._paused ? 'Resume' : 'Pause';
            const stateEl = document.getElementById('profiler-state');
            if (stateEl) stateEl.textContent = this._paused ? 'paused' : 'live';
        });
        titleRow.appendChild(pauseBtn);
        dash.appendChild(titleRow);

        // Timeline canvas
        const timelineWrap = document.createElement('div');
        timelineWrap.style.cssText = `
            background:var(--bg-panel); border:1px solid var(--border); border-radius:4px;
            padding:8px; flex-shrink:0;
        `;
        const timelineLabel = document.createElement('div');
        timelineLabel.style.cssText = 'font-size:10px;color:var(--text-dim);margin-bottom:6px;letter-spacing:0.08em;text-transform:uppercase;';
        timelineLabel.textContent   = 'Frame time (ms) — last 120 frames';
        const tlCanvas = document.createElement('canvas');
        tlCanvas.width  = 800;
        tlCanvas.height = 80;
        tlCanvas.style.cssText = 'width:100%;height:80px;display:block;';
        this._timelineCanvas = tlCanvas;
        timelineWrap.appendChild(timelineLabel);
        timelineWrap.appendChild(tlCanvas);
        dash.appendChild(timelineWrap);

        // Pass table
        const tableWrap = document.createElement('div');
        tableWrap.style.cssText = `
            background:var(--bg-panel); border:1px solid var(--border); border-radius:4px;
            padding:8px; flex-shrink:0;
        `;
        const tableLabel = document.createElement('div');
        tableLabel.style.cssText = 'font-size:10px;color:var(--text-dim);margin-bottom:8px;letter-spacing:0.08em;text-transform:uppercase;';
        tableLabel.textContent   = 'GPU pass timings (ms)';
        tableWrap.appendChild(tableLabel);

        const table = document.createElement('div');
        table.style.cssText = 'display:grid;grid-template-columns:1fr auto auto;gap:2px 16px;';
        this._passTableEl = table;
        tableWrap.appendChild(table);
        dash.appendChild(tableWrap);

        // Memory panel placeholder
        const memWrap = document.createElement('div');
        memWrap.style.cssText = `
            background:var(--bg-panel); border:1px solid var(--border); border-radius:4px;
            padding:12px; flex-shrink:0;
        `;
        memWrap.innerHTML = `
            <div style="font-size:10px;color:var(--text-dim);margin-bottom:6px;letter-spacing:0.08em;text-transform:uppercase;">Memory (estimated)</div>
            <div style="font-size:11px;color:var(--text-dim);">GPU buffer and texture accounting not yet wired up. TODO: implement in Frontend.</div>
        `;
        dash.appendChild(memWrap);

        wrap.appendChild(dash);
        this._dashEl = dash;
    }

    // ── Timeline renderer ─────────────────────────────────────────────

    _renderTimeline() {
        const canvas = this._timelineCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W   = canvas.width;
        const H   = canvas.height;
        const max = 33.3; // 30 fps target in ms

        ctx.clearRect(0, 0, W, H);

        // Grid lines at 16.6ms (60fps) and 33.3ms (30fps)
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth   = 1;
        [16.6, 33.3].forEach(ms => {
            const y = H - (ms / max) * H;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        });

        // Bars
        const barW   = W / HISTORY_LEN;
        this._history.forEach((sample, i) => {
            const total = sample.gpu.total ?? 0;
            const h     = Math.min((total / max) * H, H);
            const x     = i * barW;
            ctx.fillStyle = total > 33 ? '#f87171' : total > 16 ? '#fbbf24' : '#34d399';
            ctx.fillRect(x, H - h, Math.max(barW - 1, 1), h);
        });
    }

    // ── Pass table ────────────────────────────────────────────────────

    _updatePassTable(stats) {
        const el = this._passTableEl;
        if (!el) return;
        el.innerHTML = '';

        const passes = Object.entries(stats.gpu);
        passes.forEach(([name, ms]) => {
            const color = PASS_COLORS[name] ?? 'var(--text)';
            const pct   = stats.gpu.total > 0 ? ((ms / stats.gpu.total) * 100).toFixed(1) : '—';

            const nameEl = document.createElement('div');
            nameEl.style.cssText = `font-size:11px; color:${color};`;
            nameEl.textContent   = name.replace(/_/g, ' ');

            const msEl = document.createElement('div');
            msEl.style.cssText = 'font-size:11px; font-variant-numeric:tabular-nums; text-align:right;';
            msEl.textContent   = ms.toFixed(2) + ' ms';

            const pctEl = document.createElement('div');
            pctEl.style.cssText = 'font-size:11px; color:var(--text-dim); text-align:right;';
            pctEl.textContent   = pct + '%';

            el.appendChild(nameEl);
            el.appendChild(msEl);
            el.appendChild(pctEl);
        });
    }

    // ── Left sidebar — filters ────────────────────────────────────────

    _buildLeftSidebar(container) {
        const sec = this._addSection(container, 'Visible Passes');
        Object.keys(PASS_COLORS).forEach(name => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 12px;';
            const cb = document.createElement('input');
            cb.type    = 'checkbox';
            cb.checked = true;
            cb.style.accentColor = PASS_COLORS[name];
            const lbl = document.createElement('label');
            lbl.textContent = name.replace(/_/g, ' ');
            lbl.style.cssText = `font-size:11px; color:${PASS_COLORS[name]};`;
            row.appendChild(cb);
            row.appendChild(lbl);
            sec.appendChild(row);
            // TODO: toggle pass visibility in timeline
        });

        const exportSec = this._addSection(container, 'Recording');
        this._addButton(exportSec, 'Export Profile CSV', () => this._exportCSV());
    }

    // ── Right sidebar — advisor ───────────────────────────────────────

    _buildRightSidebar(container) {
        const sec = this._addSection(container, 'Bottleneck Advisor');
        const msg = document.createElement('div');
        msg.style.cssText = 'padding:8px 12px; color:var(--text-dim); font-size:11px; line-height:1.6;';
        msg.textContent   = 'Run the profiler live to see automatic bottleneck hints here.';
        sec.appendChild(msg);
        this._advisorEl = sec;
        // TODO: implement heuristic advisor: if pass > threshold → show warning + tip
    }

    // ── Fake sample (placeholder until real stats are wired up) ───────

    _fakeSample() {
        const rand = (base, jitter) => Math.max(0.05, base + (Math.random() - 0.5) * jitter);
        const bloom_down = rand(1.2, 0.4);
        const bloom_up   = rand(0.8, 0.3);
        const bloom_comp = rand(0.3, 0.1);
        const particles  = rand(1.8, 0.6);
        const terrain    = rand(4.5, 1.0);
        const distortion = rand(0.4, 0.15);
        const tone_map   = rand(0.2, 0.05);
        const total      = bloom_down + bloom_up + bloom_comp + particles + terrain + distortion + tone_map;
        return {
            gpu: { terrain, particles, bloom_down, bloom_up, bloom_composite: bloom_comp, distortion, tone_map, total },
            cpu: {},
            ts:  performance.now()
        };
    }

    // ── Export ────────────────────────────────────────────────────────

    _exportCSV() {
        if (this._history.length === 0) { this.toast('No data to export'); return; }
        const headers = ['frame', ...Object.keys(this._history[0].gpu)];
        const rows    = this._history.map((s, i) => [i, ...Object.values(s.gpu)].join(','));
        const csv     = [headers.join(','), ...rows].join('\n');
        const blob    = new Blob([csv], { type: 'text/csv' });
        const url     = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: 'profile.csv' }).click();
        URL.revokeObjectURL(url);
        this.toast('Exported profile.csv');
    }
}
