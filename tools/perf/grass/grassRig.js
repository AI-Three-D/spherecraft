// Browser-side helper for the grass work (core/renderer/grass/): quiet logs, fixed weather and sun, camera at eye level,
// blades against the canopy the ground draws without them (teacher against student). Load in the game page:
//   const R = await import("/tools/perf/grass/grassRig.js"); await R.boot(); await R.biome("grassland");
//   await R.teacher()   // linear ratio blades / canopy at 30-44 m over sun heights, view turns and eye heights
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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
    // Clouds held still: their shadows moving between two pictures would read as a difference.
    const clouds = g.renderer.volumetricClouds;
    if (clouds) Object.assign(clouds.settings, { windSpeedKmS: 0, weatherEvolveKmS: 0, boilKmS: 0 });
    window.windMps = 6;
    window.windAngle = 0.6;
    // The game's own wind, kept for tests of a turning wind (gameWind()); by default a fixed one.
    window.__gameWind = w._updateWind.bind(w);
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

// The next frame the renderer finishes, read right after its commands are submitted (while the canvas still holds
// it: a WebGPU canvas is empty again once its frame is shown).
export function grabNext(w = 800, h = 450) {
    const core = window.gameEngine.renderer.rendererCore;
    if (!core.__grabHooked) {
        const end = core.endFrame.bind(core);
        core.endFrame = (f) => {
            const r = end(f);
            const take = window.__onFrame;
            if (take) { window.__onFrame = null; take(); }
            return r;
        };
        core.__grabHooked = true;
    }
    return new Promise(res => {
        window.__onFrame = () => {
            const o = new OffscreenCanvas(w, h), x = o.getContext('2d', { willReadFrequently: true });
            x.drawImage(window.gameEngine.canvas, 0, 0, w, h);
            res({ w, h, d: x.getImageData(0, 0, w, h).data });
        };
    });
}

// Distance (m) to the ground along the view ray through each image row at the middle column; null where it misses.
export async function rowDistances(h = 450, maxM = 260) {
    const g = window.gameEngine, c = g.renderer.camera, R = g.planetConfig.radius;
    const p = [c.position.x, c.position.y, c.position.z];
    const e = c.matrixWorldInverse.elements;
    const upv = [e[1], e[5], e[9]], back = [e[2], e[6], e[10]];
    const tanH = Math.tan(c.fov * Math.PI / 360);
    const steps = [];
    for (let m = 1; m <= maxM; m += m < 60 ? 0.5 : 1.5) steps.push(m);
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

// Flicker while the camera moves: time held (no wind motion), the camera stepped stepM per frame along its view on the
// level, second difference |a - 2b + c| of luminance over the lower part of the picture, mean and 99th percentile.
// Grass on against off at the same steps: what the grass adds.
export async function motionFlicker({ dir = POSES.grassland, eye = 1.8, bearing = 0, pitch = -4, aheadM = 150, stepM = 0.03, n = 12 } = {}) {
    const grass = window.gameEngine.renderer.quadtreeTerrainRenderer.grass;
    const compute = grass.compute.bind(grass);
    grass.compute = (enc, o) => compute(enc, { ...o, deltaTime: 0 });
    const run = async () => {
        const seq = [], R = [];
        for (let i = 0; i < n; i++) {
            await eyeAt(dir, { eye, bearing, pitch, aheadM: aheadM + i * stepM });
            await grabNext(8, 8);
            const g = await grabNext(800, 450);
            const lum = new Float32Array(800 * 450);
            for (let k = 0; k < lum.length; k++) lum[k] = 0.2126 * g.d[4 * k] + 0.7152 * g.d[4 * k + 1] + 0.0722 * g.d[4 * k + 2];
            seq.push(lum);
            if (seq.length > 3) seq.shift();
            if (seq.length < 3) continue;
            const [a, b, c] = seq, v = [];
            let first = 0;
            for (let k = 800 * 160; k < lum.length; k++) { v.push(Math.abs(a[k] - 2 * b[k] + c[k])); first += Math.abs(c[k] - b[k]); }
            v.sort((x, y) => x - y);
            const second = v.reduce((s, x) => s + x, 0) / v.length;
            first /= v.length;
            // Second over first difference: near 0 for smooth motion, about 1.4 for pixels that change at random.
            R.push([second, v[Math.floor(v.length * 0.99)], second / Math.max(first, 1e-6)]);
        }
        const med = j => R.map(x => x[j]).sort((x, y) => x - y)[R.length >> 1];
        return { second: +med(0).toFixed(2), p99: +med(1).toFixed(1), ratio: +med(2).toFixed(3) };
    };
    try {
        grass.enabled = true; const on = await run();
        grass.enabled = false; const off = await run();
        return { on, off };
    } finally { grass.enabled = true; grass.compute = compute; }
}

// The game's own wind, turning to a new way and speed every second or so (as the weather does, only more often).
export function gameWind(changesPerSecond = 1) {
    const w = window.gameEngine.renderer.weatherController;
    w.config.windChangeChancePerSecond = changesPerSecond;
    w._updateWind = window.__gameWind;
}

// Frame-to-frame change of a still view over the lower 70 % of the picture (grey levels), frames as rendered.
export async function stillChange(frames = 8) {
    const shots = [];
    for (let i = 0; i < frames; i++) shots.push(await grabNext(800, 450));
    let s = 0, n = 0;
    for (let k = 1; k < shots.length; k++) {
        const a = shots[k - 1].d, b = shots[k].d;
        for (let i = 4 * 800 * 135; i < a.length; i += 4) { s += Math.abs(a[i + 1] - b[i + 1]); n++; }
    }
    return +(s / n).toFixed(2);
}

// A view at a height over the meadow, bearing turned from the sun: 'root' 0.45 m, 'stand' 1.8 m, 'high' 8 m, 'over' 15 m.
export const HEIGHTS = { root: [0.45, -3], stand: [1.8, -10], high: [8, -12], over: [15, -16] };
export async function view(name, { dir = POSES.grassland, turn = 120, aheadM = 150, sun = 0.55 } = {}) {
    sunAt(dir, sun);
    await frames(4);
    const [eye, pitch] = HEIGHTS[name];
    await eyeAt(dir, { eye, pitch, bearing: sunBearing(dir) + turn, aheadM });
    await settle(30000);
    await wait(900);
    return window.gpuErrors.length;
}

// A pose from the game's position / look-at readout.
export async function poseAt(position, lookAt, fov = 60) {
    const l = Math.hypot(...position), up = position.map(x => x / l);
    const v = ([x, y, z]) => ({ x, y, z });
    window.qtDiag.regional.useCamera({ position: v(position), target: v(lookAt), up: v(up), fov });
    await settle(30000);
    await wait(800);
    return up;
}

// By distance band: mean grey, and fine contrast (mean absolute difference to the 4 neighbours, grey levels), over the
// middle 60 % of the picture's width, as rendered (frame grabbed at the end of rendering).
export async function profile(bands = [[3, 6], [6, 12], [12, 24], [24, 40], [40, 60], [60, 90], [90, 130], [130, 180], [180, 240], [240, 320], [320, 500]]) {
    const w = 800, h = 450;
    const rows = await rowDistances(h, 520);
    const img = await grabNext(w, h);
    const grey = new Float32Array(w * h);
    for (let i = 0; i < grey.length; i++) grey[i] = 0.2126 * img.d[4 * i] + 0.7152 * img.d[4 * i + 1] + 0.0722 * img.d[4 * i + 2];
    return bands.map(([a, b]) => {
        let s = 0, c = 0, n = 0;
        rows.forEach((d, r) => {
            if (d === null || d < a || d >= b || r === 0 || r === h - 1) return;
            for (let x = Math.floor(w * 0.2); x < w * 0.8; x++) {
                const i = r * w + x, g = grey[i];
                s += g;
                c += (Math.abs(g - grey[i - 1]) + Math.abs(g - grey[i + 1]) + Math.abs(g - grey[i - w]) + Math.abs(g - grey[i + w])) / 4;
                n++;
            }
        });
        return n ? [a, b, +(s / n).toFixed(1), +(c / n).toFixed(2)] : [a, b, null, null];
    });
}

// The profile with blades, with the ground's grass look alone, and with no grass at all.
export async function profiles() {
    const qtr = window.gameEngine.renderer.quadtreeTerrainRenderer, pass = qtr.pass, grass = qtr.grass;
    const set = async (look, blades) => { pass.options.grass = look; await pass.prepare(); grass.enabled = blades; await wait(700); };
    await set(true, true); const full = await profile();
    await set(true, false); const ground = await profile();
    await set(false, false); const none = await profile();
    await set(true, true);
    return full.map((f, i) => `${f[0]}-${f[1]} m  full ${f[2]} / ${f[3]}   ground ${ground[i][2]} / ${ground[i][3]}   none ${none[i][2]} / ${none[i][3]}`).join('\n');
}

// The field against a teacher: the spot d metres off along a level way from the eye, drawn as it is (zoomed in k times:
// blades as dense as for a pixel k times smaller, none widened; GrassPass.teacher: no distance shortcuts in their
// light) and as the game draws it. Mean colour of the game's view over the window the zoomed view covers, against the
// zoomed view's; and of the ground alone (no blades). eye: world position; bearing: degrees from north.
export async function zoomTruth({ eye, bearing = 0, dists = [12, 20, 30, 45, 65, 90, 130, 180], k = 8, game: withGame = true } = {}) {
    const g = window.gameEngine, R0 = g.planetConfig.radius;
    // The render camera's field of view (the game camera's is not passed on: frontend.js keeps its own, 75).
    const cam = g.renderer.camera, fov = cam.fov;
    const zoomed = 2 * Math.atan(Math.tan(fov * Math.PI / 360) / k) * 180 / Math.PI;
    const grass = g.renderer.quadtreeTerrainRenderer.grass;
    const up = norm(eye);
    const east = norm(cross([0, 1, 0], up)), north = cross(up, east);
    const b = bearing * Math.PI / 180;
    const fwd = east.map((x, i) => x * Math.sin(b) + north[i] * Math.cos(b));
    const meanOf = (img, frac) => {
        const x0 = Math.floor(img.w * (0.5 - frac / 2)), x1 = Math.ceil(img.w * (0.5 + frac / 2));
        const y0 = Math.floor(img.h * (0.5 - frac / 2)), y1 = Math.ceil(img.h * (0.5 + frac / 2));
        const s = [0, 0, 0]; let n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.w + x) * 4; s[0] += img.d[i]; s[1] += img.d[i + 1]; s[2] += img.d[i + 2]; n++; }
        return s.map(v => +(v / n).toFixed(1));
    };
    // Mean absolute difference of grey to the right and below neighbours, over the centre window (frac of each side),
    // after a box filter of `box` pixels.
    const contrastOf = (img, frac, box) => {
        const x0 = Math.floor(img.w * (0.5 - frac / 2)), y0 = Math.floor(img.h * (0.5 - frac / 2));
        const nx = Math.floor(img.w * frac / box), ny = Math.floor(img.h * frac / box);
        const grey = new Float32Array(nx * ny);
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
            let s = 0;
            for (let v = 0; v < box; v++) for (let u = 0; u < box; u++) {
                const i = ((y0 + y * box + v) * img.w + x0 + x * box + u) * 4;
                s += 0.2126 * img.d[i] + 0.7152 * img.d[i + 1] + 0.0722 * img.d[i + 2];
            }
            grey[y * nx + x] = s / (box * box);
        }
        let sum = 0, n = 0;
        for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
            const c = grey[y * nx + x];
            sum += Math.abs(c - grey[y * nx + x + 1]) + Math.abs(c - grey[(y + 1) * nx + x]); n += 2;
        }
        return +(sum / n).toFixed(2);
    };
    const rows = [];
    for (const d of dists) {
        const dirT = norm(eye.map((x, i) => x + fwd[i] * d));
        const [height] = await g.waterService._sampler.sampleDirsNatural(new Float32Array([...dirT, 0]));
        const target = dirT.map(x => x * (R0 + height));
        const W = g.canvas.width, H = g.canvas.height;
        const shot = async (f, teacher, blades) => {
            grass.teacher = teacher; grass.enabled = blades; cam.fov = f;
            await poseAt(eye, target, fov); await frames(4); await settle(20000); await frames(24);
            return grabNext(W, H);
        };
        const game = withGame ? await shot(fov, false, true) : null;
        const truth = await shot(zoomed, true, true);
        const ground = await shot(fov, false, false);
        // The spot's geometry: its normal (heights 1.5 m about it), the sight line, the sun.
        const tE = norm(cross(up, cross(fwd, up))), tN = cross(up, tE);
        const around = [tE, tE.map(x => -x), tN, tN.map(x => -x)].map(t => norm(target.map((x, i) => x + t[i] * 1.5)));
        const hs = await g.waterService._sampler.sampleDirsNatural(new Float32Array(around.flatMap(a => [...a, 0])));
        const pts = around.map((a, i) => a.map(x => x * (R0 + hs[i])));
        const normal = norm(cross(pts[0].map((x, i) => x - pts[1][i]), pts[2].map((x, i) => x - pts[3][i])));
        const n = dot3(normal, dirT) < 0 ? normal.map(x => -x) : normal;
        const toEye = norm(eye.map((x, i) => x - target[i]));
        const sv = g.renderer.uniformManager.uniforms.sunLightDirection.value, sun = norm([sv.x, sv.y, sv.z]);
        const geometry = { slant: +(dot3(toEye, n) / Math.max(dot3(dirT, n), 0.3)).toFixed(4), level: +dot3(toEye, dirT).toFixed(4),
            sunUp: +dot3(sun, dirT).toFixed(3), hot: +dot3(toEye, sun).toFixed(3), tilt: +dot3(n, dirT).toFixed(3) };
        rows.push({ d, ...geometry, game: game ? meanOf(game, 1 / k) : null, truth: meanOf(truth, 1), ground: meanOf(ground, 1 / k),
            // Fine contrast at the game's pixels: its window as drawn, the zoomed view boxed down k times.
            contrast: [game ? contrastOf(game, 1 / k, 1) : null, contrastOf(truth, 1, k), contrastOf(ground, 1 / k, 1)] });
    }
    grass.teacher = false; grass.enabled = true; cam.fov = fov;
    return rows;
}

// Side by side at each distance: the game's window (its own pixels, enlarged) and the teacher boxed down to the same
// pixels (the field as it is, filtered as a pixel would): canvas #cmp. eye: world position; bearing: degrees.
export async function teacherPanels({ eye, bearing = 0, dists = [10, 25], k = 8, size = 700 } = {}) {
    const g = window.gameEngine, R0 = g.planetConfig.radius, grass = g.renderer.quadtreeTerrainRenderer.grass, cam = g.renderer.camera;
    const up = norm(eye), east = norm(cross([0, 1, 0], up)), north = cross(up, east);
    const b = bearing * Math.PI / 180;
    const fwd = east.map((x, i) => x * Math.sin(b) + north[i] * Math.cos(b));
    const W = g.canvas.width, H = g.canvas.height, fov = cam.fov;
    const zoomed = 2 * Math.atan(Math.tan(fov * Math.PI / 360) / k) * 180 / Math.PI;
    document.getElementById('cmp')?.remove();
    const cv = document.createElement('canvas');
    cv.id = 'cmp'; cv.width = 2 * size; cv.height = dists.length * size / 2;
    cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;visibility:visible !important';
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const put = img => { const o = new OffscreenCanvas(img.w, img.h); o.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.d), img.w, img.h), 0, 0); return o; };
    const box = (img, f) => {
        const w = Math.floor(img.w / f), h = Math.floor(img.h / f), d = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const s = [0, 0, 0];
            for (let v = 0; v < f; v++) for (let u = 0; u < f; u++) { const i = ((y * f + v) * img.w + x * f + u) * 4; s[0] += img.d[i]; s[1] += img.d[i + 1]; s[2] += img.d[i + 2]; }
            const o = (y * w + x) * 4; d[o] = s[0] / (f * f); d[o + 1] = s[1] / (f * f); d[o + 2] = s[2] / (f * f); d[o + 3] = 255;
        }
        return { w, h, d };
    };
    let row = 0;
    for (const d of dists) {
        const dirT = norm(eye.map((x, i) => x + fwd[i] * d));
        const [hh] = await g.waterService._sampler.sampleDirsNatural(new Float32Array([...dirT, 0]));
        const target = dirT.map(x => x * (R0 + hh));
        const shot = async (f, teacher) => { grass.teacher = teacher; cam.fov = f; await poseAt(eye, target, fov); await frames(30); return grabNext(W, H); };
        const a = await shot(fov, false);
        const t = box(await shot(zoomed, true), k);
        ctx.drawImage(put(a), W * (0.5 - 0.5 / k), H * (0.5 - 0.5 / k), W / k, H / k, 0, row * size / 2, size, size / 2);
        ctx.drawImage(put(t), 0, 0, t.w, t.h, size, row * size / 2, size, size / 2);
        row++;
    }
    grass.teacher = false; cam.fov = fov;
}

// The meadow pose at an eye height, turned from the sun: { eye (world), bearing }.
export async function meadowEye({ eye = 1.8, turn = 0, sun = 0.7 } = {}) {
    const poses = await (await fetch('/tools/perf/biomeLandscape/poses.json')).json();
    const p = poses.find(x => x.name === 'grassland');
    sunAt(p.dir, sun);
    await frames(6);
    const bearing = sunBearing(p.dir) + turn;
    await eyeAt(p.dir, { eye, pitch: -8, bearing, aheadM: 150 });
    const c = window.gameEngine.camera.position;
    return { eye: [c.x, c.y, c.z], bearing };
}
