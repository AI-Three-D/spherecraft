// What the terrain's lighting says about the sky at one sun height, for
// calibrating the water's reflected sky against the sky drawn on screen.
export async function lightAt({ pos, sun }) {
    const l = Math.hypot(...pos), dir = pos.map(v => v / l);
    window.__lr.daylightAt(dir, sun);
    await new Promise(r => setTimeout(r, 500));
    const g = window.gameEngine.renderer.uniformManager?.uniforms ?? {};
    const c = v => v && [v.x ?? v.r, v.y ?? v.g, v.z ?? v.b];
    return {
        sun,
        ambient: c(g.ambientLightColor?.value), ambientI: g.ambientLightIntensity?.value,
        sunColor: c(g.sunLightColor?.value), sunI: g.sunLightIntensity?.value,
        sunDir: c(g.sunLightDirection?.value),
    };
}
