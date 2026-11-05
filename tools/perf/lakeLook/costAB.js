// In-page cost of water states: same page, same tiles, same pose, states taken
// in turn, so what differs between runs (tiles, streaming, the GPU's other work)
// cancels. Across page loads the same code differs by 2 ms and more here.
// Each state is a qtDiag.water.look value; the arm's patch decides what it does.
import { fencedFrames } from '/tools/perf/terrainDetail/scene.js';

export async function costAB({ states, rounds = 6, frames = 24 }) {
    const out = Object.fromEntries(Object.keys(states).map(k => [k, []]));
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < rounds; i++) {
        for (const [name, look] of Object.entries(states)) {
            window.qtDiag.water.look(look);
            await new Promise(r => setTimeout(r, 120));
            out[name].push((await fencedFrames(frames, 3)).gpuSpanMs.median);
        }
    }
    window.qtDiag.water.look({ wind: 1 });
    const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { median: +med(v).toFixed(2), runs: v.map(x => +x.toFixed(1)) }]));
}
