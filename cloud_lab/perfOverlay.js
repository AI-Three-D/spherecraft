// FPS counter, frame-time graph and per-pass GPU timings.

const WINDOW = 240;
const GRAPH_MAX_MS = 40;

export class PerfOverlay {
    constructor(root, { timer }) {
        this.timer = timer;
        this.intervals = [];
        this.cpu = [];
        this.gpuTotals = [];
        this._lastText = 0;
        this.battery = null;
        navigator.getBattery?.().then(battery => { this.battery = battery; }).catch(() => {});
        root.innerHTML = `
            <div class="perf-head"><span class="perf-fps">–</span><span class="perf-unit">fps</span><span class="perf-ms"></span></div>
            <div class="perf-busy"></div>
            <div class="perf-cap"></div>
            <canvas class="perf-graph" width="520" height="120"></canvas>
            <div class="perf-legend"><i class="cpu"></i>frame interval <i class="gpu"></i>GPU frame <span>guides 8.3 / 16.7 / 33.3 ms</span></div>
            <table class="perf-passes"></table>
            <div class="perf-note"></div>
            <div class="perf-actions"><button type="button" class="perf-run">Profile all views</button></div>
            <table class="perf-profile"></table>`;
        this.fpsEl = root.querySelector('.perf-fps');
        this.msEl = root.querySelector('.perf-ms');
        this.busyEl = root.querySelector('.perf-busy');
        this.capEl = root.querySelector('.perf-cap');
        this.graph = root.querySelector('.perf-graph');
        this.ctx = this.graph.getContext('2d');
        this.passesEl = root.querySelector('.perf-passes');
        this.noteEl = root.querySelector('.perf-note');
        this.runButton = root.querySelector('.perf-run');
        this.profileEl = root.querySelector('.perf-profile');
        if (!timer?.supported) this.noteEl.textContent = 'GPU timings unavailable (adapter lacks timestamp-query).';
    }

    /** Call once per animation frame with the measured interval and the frame's CPU time. */
    frame(intervalMs, now, cpuMs = NaN) {
        push(this.intervals, intervalMs);
        push(this.cpu, cpuMs);
        const gpu = this.timer?.samples.get('total');
        push(this.gpuTotals, gpu?.[gpu.length - 1] ?? NaN);
        this._drawGraph();
        if (now - this._lastText > 250) {
            this._lastText = now;
            this._drawText();
        }
    }

    showProfile(rows, columns) {
        const head = `<tr><th>view</th>${columns.map(c => `<th>${c.label}</th>`).join('')}</tr>`;
        const body = rows.map(row => `<tr><td>${row.view}</td>${columns.map(c => `<td>${c.format(row)}</td>`).join('')}</tr>`).join('');
        this.profileEl.innerHTML = head + body;
    }

    _drawText() {
        const n = this.intervals.length;
        if (!n) return;
        const avg = this.intervals.reduce((s, v) => s + v, 0) / n;
        const sorted = [...this.intervals].sort((a, b) => a - b);
        const p99 = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
        this.fpsEl.textContent = (1000 / avg).toFixed(0);
        this.msEl.textContent = `${avg.toFixed(1)} ms avg · ${p99.toFixed(1)} ms p99`;
        const stats = this.timer?.supported ? this.timer.stats() : [];
        const total = stats.find(s => s.name === 'total');
        const cpu = mean(this.cpu);
        this.busyEl.textContent = `work per frame: CPU ${fmt(cpu)} ms · GPU ${fmt(total?.avg)} ms`;
        this.capEl.textContent = capNote(avg, p99, Math.max(cpu || 0, total?.avg || 0), this.battery);
        if (!this.timer?.supported) return;
        const scale = Math.max(total?.avg ?? 1, 0.001);
        this.passesEl.innerHTML = stats
            .filter(s => s.name !== 'total')
            .map(s => `<tr><td>${s.name}</td><td>${s.avg.toFixed(2)}</td><td>${s.p95.toFixed(2)}</td>`
                + `<td class="bar"><span style="width:${Math.min(100, s.avg / scale * 100).toFixed(1)}%"></span></td></tr>`)
            .join('')
            + (total ? `<tr class="total"><td>GPU frame</td><td>${total.avg.toFixed(2)}</td><td>${total.p95.toFixed(2)}</td><td></td></tr>` : '');
        this.passesEl.insertAdjacentHTML('afterbegin', '<tr><th>pass</th><th>avg ms</th><th>p95</th><th></th></tr>');
    }

    _drawGraph() {
        const { ctx, graph } = this;
        const w = graph.width, h = graph.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        for (const ms of [1000 / 120, 1000 / 60, 1000 / 30]) {
            const y = h - ms / GRAPH_MAX_MS * h;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        const line = (values, color) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            let started = false;
            values.forEach((v, i) => {
                if (!Number.isFinite(v)) return;
                const x = (i + WINDOW - values.length) / (WINDOW - 1) * w;
                const y = h - Math.min(v, GRAPH_MAX_MS) / GRAPH_MAX_MS * h;
                if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
                started = true;
            });
            ctx.stroke();
        };
        line(this.intervals, '#7fb8ff');
        line(this.gpuTotals, '#ffb35c');
    }
}

// A steady interval far above the frame's own CPU/GPU work means something else paces the frames.
function capNote(avgMs, p99Ms, busyMs, battery) {
    if (!(busyMs > 0) || avgMs < busyMs * 2 + 2 || p99Ms - avgMs > 3) return '';
    const hz = Math.round(1000 / avgMs);
    // 60+ is ordinary vsync; only flag caps below any common display rate.
    if (hz > 50) return '';
    let note = `Frame rate is capped at ~${hz} fps by the browser or display, not by rendering `
        + `(a frame needs ~${busyMs.toFixed(1)} ms).`;
    if (hz <= 32) {
        note += ' Chrome\'s Energy Saver caps pages at 30 fps'
            + (battery && !battery.charging ? ' and this machine is on battery' : ' on battery')
            + '; turn it off in chrome://settings/performance.';
    }
    return note;
}

function mean(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? finite.reduce((s, v) => s + v, 0) / finite.length : NaN;
}

function fmt(ms) { return Number.isFinite(ms) ? ms.toFixed(1) : '–'; }

function push(list, value) {
    list.push(value);
    if (list.length > WINDOW) list.shift();
}
