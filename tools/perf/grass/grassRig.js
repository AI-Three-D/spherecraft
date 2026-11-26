// Browser-side helper for the grass work (core/renderer/grass/): quiet logs, fixed weather and sun, camera at eye level,
// blades against the canopy the ground draws without them (teacher against student). Load in the game page:
//   const R = await import("/tools/perf/grass/grassRig.js"); await R.boot(); await R.biome("grassland");
//   await R.teacher()   // linear ratio blades / canopy at 30-44 m over sun heights, view turns and eye heights
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
export const wait = ms => new Promise(r => setTimeout(r, ms));
export const frames = n => new Promise(r => { let k = 0; const f = () => ++k > n ? r() : requestAnimationFrame(f); requestAnimationFrame(f); });

export async function boot() {
    const base = location.pathname.replace('wizard_game/standalone.html', '');
    const L = (await import(base + 'shared/Logger.js')).Logger;
    for (const k of ['log', 'info', 'debug', 'warn']) L[k] = () => {};
    for (const k of ['log', 'info', 'debug']) console[k] = () => {};
    const t0 = performance.now();
    while (!window.gameEngine?.getLoadingStatus?.()?.complete && performance.now() - t0 < 170000) await wait(400);
    const g = window.gameEngine;
    window.gpuErrors = [];
    g.renderer.backend.device.addEventListener('uncapturederror', e => window.gpuErrors.push(e.error.message.slice(0, 1500)));
    const w = g.renderer.weatherController;
    w._pickNewWeatherTarget = () => {};
    w.config.weatherChangeChancePerSecond = 0;
    w.config.windChangeChancePerSecond = 0;
    w.config.variantChangeChancePerSecond = 0;
    w.setWeather('partly_cloudy', true);
    window.windMps = 6;
    window.windAngle = 0.6;
    w._updateWind = (dt, env) => { env.windSpeed = window.windMps; env.windDirection.set(Math.cos(window.windAngle), Math.sin(window.windAngle)); };
    const st = document.createElement('style');
    st.id = 'rigHide';
    st.textContent = 'body > *:not(canvas){visibility:hidden !important}';
    document.head.appendChild(st);
    return { canvas: [g.canvas.width, g.canvas.height] };
}

// Pause the day with the sun so high over dir (dot of sun and up).
export function sunAt(dir, target = 0.6, azimuthHint = null) {
    const s = window.gameEngine.starSystem, body = s.currentBody;
    s.paused = true; s.useGameTimeRotation = false;
    const up = norm(dir);
    let best = Infinity, rotation = 0;
    for (let i = 0; i < 2880; i++) {
        body.currentRotation = i * Math.PI * 2 / 2880;
        const d = body.getStarDirection(s.primaryStar).direction;
        const h = d.x * up[0] + d.y * up[1] + d.z * up[2];
        const rising = azimuthHint === null ? 0 : 0;
        if (Math.abs(h - target) + rising < best) { best = Math.abs(h - target); rotation = body.currentRotation; }
    }
    body.currentRotation = rotation;
    const d = body.getStarDirection(s.primaryStar).direction;
    return [d.x, d.y, d.z];
}

// The camera eye metres over the ground at dir, looking on a bearing (degrees from north), pitch degrees (negative down).
export async function eyeAt(dir, { eye = 1.7, bearing = 0, pitch = -8, fov = 60, sideM = 0, aheadM = 0 } = {}) {
    const g = window.gameEngine, R = g.planetConfig.radius;
    let up = norm(dir);
    const eastRaw = cross([0, 1, 0], up), east = norm(eastRaw), north = cross(up, east);
    const b = bearing * Math.PI / 180;
    const fwd = east.map((x, i) => x * Math.sin(b) + north[i] * Math.cos(b));
    const right = cross(fwd, up);
    if (sideM || aheadM) up = norm(up.map((x, i) => x * R + fwd[i] * aheadM + right[i] * sideM));
    const [ground] = await g.waterService._sampler.sampleDirsNatural(new Float32Array([...up, 0]));
    const pos = up.map(x => x * (R + ground + eye));
    const p = pitch * Math.PI / 180;
    const look = pos.map((x, i) => x + 100 * (fwd[i] * Math.cos(p) + up[i] * Math.sin(p)));
    const v = ([x, y, z]) => ({ x, y, z });
    window.qtDiag.regional.useCamera({ position: v(pos), target: v(look), up: v(up), fov });
    return { ground, up };
}

export async function settle(maxMs = 45000) {
    const g = window.gameEngine, tm = g.renderer.quadtreeTileManager;
    let idle = 0;
    const end = performance.now() + maxMs;
    do {
        await wait(150);
        const v = tm.getInitialLoadStatus?.();
        const quiet = v?.exactVisibleRatio === 1 && !v.pendingGenerations && !v.activeGenerations && !v.pendingCopies
            && !tm.tileStreamer.getRegenerationStats().pending;
        idle = quiet ? idle || performance.now() : 0;
    } while ((!idle || performance.now() - idle < 1200) && performance.now() < end);
    return !!idle;
}

export const POSES = {
    grassland: [0.0076762, 0.2226098, 0.9748774],
    eye: [-122698.33, -18459.30, 44220.54],
};

// The canvas as luminance and colour rows, in the frame that drew it (presented frames alternate with empty ones).
export function grab(w = 800, h = 450) {
    const cv = window.gameEngine.canvas;
    return new Promise(res => {
        const go = () => requestAnimationFrame(() => {
            const o = new OffscreenCanvas(w, h), x = o.getContext('2d', { willReadFrequently: true });
            x.drawImage(cv, 0, 0, w, h);
            const d = x.getImageData(0, 0, w, h).data;
            let sum = 0;
            for (let i = 0; i < d.length; i += 16) sum += d[i + 1];
            if (sum === 0) return go();
            res({ w, h, d });
        });
        go();
    });
}

// Distance (m) to the ground along the view ray through each image row at the middle column; null where it misses.
export async function rowDistances(h = 450, maxM = 120) {
    const g = window.gameEngine, c = g.renderer.camera, R = g.planetConfig.radius;
    const p = [c.position.x, c.position.y, c.position.z];
    const e = c.matrixWorldInverse.elements;
    const upv = [e[1], e[5], e[9]], back = [e[2], e[6], e[10]];
    const tanH = Math.tan(c.fov * Math.PI / 360);
    const steps = [];
    for (let m = 1; m <= maxM; m += 0.5) steps.push(m);
    const out = [];
    for (let row = 0; row < h; row++) {
        const ny = 1 - 2 * (row + 0.5) / h;
        const dir = norm([0, 1, 2].map(i => -back[i] + upv[i] * ny * tanH));
        const dirs = new Float32Array(steps.length * 4);
        steps.forEach((m, k) => { const q = norm(p.map((x, i) => x + dir[i] * m)); dirs.set([...q, 0], k * 4); });
        const ground = await g.waterService._sampler.sampleDirsNatural(dirs);
        let hit = null;
        for (let k = 0; k < steps.length; k++) {
            const q = p.map((x, i) => x + dir[i] * steps[k]);
            if (Math.hypot(...q) - R <= ground[k]) { hit = steps[k]; break; }
        }
        out.push(hit);
    }
    return out;
}

// Mean colour by distance band, grass on against off (same pose, frozen time).
export async function handover(bands = [[10, 20], [20, 30], [30, 38], [38, 44], [44, 50], [50, 60], [60, 80]]) {
    const grass = window.gameEngine.renderer.quadtreeTerrainRenderer.grass;
    const rows = await rowDistances();
    const cols = [0.2, 0.8];
    const mean = img => bands.map(([a, b]) => {
        const s = [0, 0, 0]; let n = 0;
        rows.forEach((d, r) => {
            if (d === null || d < a || d >= b) return;
            for (let x = Math.floor(cols[0] * img.w); x < cols[1] * img.w; x++) { const i = (r * img.w + x) * 4; s[0] += img.d[i]; s[1] += img.d[i + 1]; s[2] += img.d[i + 2]; n++; }
        });
        return n ? s.map(v => +(v / n).toFixed(1)) : null;
    });
    grass.enabled = true; await wait(600); const on = mean(await grab());
    grass.enabled = false; await wait(600); const off = mean(await grab());
    grass.enabled = true;
    return bands.map((b, i) => `${b[0]}-${b[1]} m  on ${JSON.stringify(on[i])}  off ${JSON.stringify(off[i])}`).join('\n');
}

export async function biome(name, { eye = 1.7, pitch = -6, bearing = null, aheadM = 0, sun = null } = {}) {
    const poses = await (await fetch('/tools/perf/biomeLandscape/poses.json')).json();
    const p = poses.find(x => x.name === name);
    sunAt(p.dir, sun ?? p.sun ?? 0.6);
    const r = await eyeAt(p.dir, { eye, pitch, bearing: bearing ?? p.bearing, aheadM });
    await settle(30000);
    await wait(700);
    return r;
}

// Bearing (degrees from north) of the sun at a place.
export function sunBearing(dir) {
    const up = norm(dir), east = norm(cross([0, 1, 0], up)), north = cross(up, east);
    const s = window.gameEngine.renderer.uniformManager.uniforms.sunLightDirection.value;
    const v = [s.x, s.y, s.z];
    const e = v.reduce((a, x, i) => a + x * east[i], 0), n = v.reduce((a, x, i) => a + x * north[i], 0);
    return Math.atan2(e, n) * 180 / Math.PI;
}

// Blades (teacher) against the canopy the ground draws without them (student), band 30-44 m: linear ratio per channel.
export async function teacher({ dir = POSES.grassland, aheadM = 150, suns = [0.25, 0.55, 0.85], turns = [0, 60, 120, 180], eyes = [1.8, 6] } = {}) {
    const lin = c => Math.pow(c / 255, 2.2);
    const out = [];
    for (const sun of suns) {
        sunAt(dir, sun);
        await frames(3);
        const sb = sunBearing(dir);
        for (const eye of eyes) for (const turn of turns) {
            await eyeAt(dir, { eye, bearing: sb + turn, pitch: eye > 3 ? -10 : -4, aheadM });
            await settle(15000);
            await wait(400);
            const text = await handover([[30, 44]]);
            const m = text.match(/on \[([^\]]+)\]\s+off \[([^\]]+)\]/);
            if (!m) { out.push({ sun, eye, turn, ratio: null }); continue; }
            const on = m[1].split(',').map(Number), off = m[2].split(',').map(Number);
            out.push({ sun, eye, turn, ratio: on.map((x, i) => +(lin(x) / lin(off[i])).toFixed(3)) });
        }
    }
    return out;
}
