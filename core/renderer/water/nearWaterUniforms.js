import { NEAR_WATER_UNIFORM_FLOATS } from './nearWaterSurface.wgsl.js';
const vec3Of = (v, fallback) => {
    if (v && Number.isFinite(v.x)) return [v.x, v.y, v.z];
    if (v && Number.isFinite(v.r)) return [v.r, v.g, v.b];
    return fallback;
};
const numOf = (v, fallback) => (Number.isFinite(v) ? v : fallback);

export function fillNearWaterUniforms(u, {viewMatrix, projectionMatrix, planetConfig, uniformManager, camera, water, lakes=[], apFade}) {
    const o=planetConfig?.origin??{x:0,y:0,z:0},cam=camera.position,range=water.near.fadeEndM;
    u.set(viewMatrix.elements ?? viewMatrix, 0);
    u.set(projectionMatrix.elements ?? projectionMatrix, 16);
    const g = uniformManager?.uniforms ?? {};
    const apOn = numOf(g.aerialPerspectiveEnabled?.value, planetConfig?.hasAtmosphere ? 1 : 0);
    u.set([o.x, o.y, o.z, water.R, cam.x, cam.y, cam.z, range * 1.05,
        97, apOn > 0.5 ? 1 : 0, 0, 0], 32);
    u.fill(0, 44, 60);
    u.set(lakes, 44);
    // Lighting and atmosphere: the values and defaults the terrain shading
    // gets (webgpuBackend.js terrain fragment uniforms).
    u.set([...vec3Of(g.sunLightDirection?.value, [0, 1, 0]), numOf(g.sunLightIntensity?.value, 1),
        ...vec3Of(g.sunLightColor?.value, [1, 1, 1]), numOf(g.ambientLightIntensity?.value, 0.8),
        ...vec3Of(g.ambientLightColor?.value, [0.3, 0.3, 0.4]), numOf(g.atmospherePlanetRadius?.value, 50000),
        ...vec3Of(g.atmosphereRayleighScattering?.value, [5.5e-5, 13.0e-5, 22.4e-5]), numOf(g.atmosphereMieScattering?.value, 21e-5),
        numOf(g.atmosphereRadius?.value, 60000), numOf(g.atmosphereScaleHeightRayleigh?.value, 800),
        numOf(g.atmosphereScaleHeightMie?.value, 120), numOf(g.atmosphereMieAnisotropy?.value, 0.8),
        ...vec3Of(g.fogColor?.value, [0.7, 0.8, 1.0]), numOf(g.fogDensity?.value, 0.00005),
        numOf(g.atmosphereSunIntensity?.value, 20), apFade.start, apFade.end, 0], 60);

    return u;
}
export { NEAR_WATER_UNIFORM_FLOATS };
