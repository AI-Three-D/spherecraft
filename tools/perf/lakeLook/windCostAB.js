import { fencedFrames } from '/tools/perf/terrainDetail/scene.js';

// Compare the previous distant-wind function and the current one in a
// single settled page; restore every material even if measurement fails.
export async function windCostAB({ rounds = 3, frames = 24 } = {}) {
    const materials = [...gameEngine.renderer.quadtreeTerrainRenderer._materials.values()];
    const original = materials.map(m => m.fragmentShader);
    const old = `fn waterSwells(p: vec3<f32>, invM: f32, phase: f32, rate: f32) -> f32 {
    let t = waterParams.time * rate * 2.0;
    return (waterSwell(p, vec3<f32>(0.83, 0.31, 0.47) * invM, phase + t)
        + waterSwell(p, vec3<f32>(-0.38, 0.86, 0.34) * invM, phase * 0.7 - 0.61 * t)
        + waterSwell(p, vec3<f32>(0.29, -0.52, 0.80) * invM, phase * 1.3 + 0.37 * t)) * 0.3333;
}`;
    if (!original.some(source => source.includes('fn waterSwells('))) throw new Error('Water wind shader was not found');
    const result = { old: [], current: [] };
    const set = useOld => materials.forEach((m, i) => {
        m.fragmentShader = useOld ? original[i].replace(/fn waterSwells\([\s\S]*?\n\}/, old) : original[i];
        m._needsCompile = true;
    });
    try {
        for (let r = 0; r < rounds; r++) for (const name of r % 2 ? ['current', 'old'] : ['old', 'current']) {
            set(name === 'old');
            await new Promise(resolve => setTimeout(resolve, 400));
            result[name].push((await fencedFrames(frames, 5)).gpuSpanMs.median);
        }
    } finally { set(false); }
    return result;
}
