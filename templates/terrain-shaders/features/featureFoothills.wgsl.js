import { normalizeFoothillsConfig } from '../../../core/world/terrain-generator/foothillsConfig.js';

const wgslFloat = value => {
    const s = String(value);
    return /[.eE]/.test(s) ? s : `${s}.0`;
};

// A startup-only choice: the same source is assembled for tiles, lake-table
// construction and the hydrology sampler. The legacy source stays identical.
export function createFoothillWgsl(options = {}) {
    const cfg = normalizeFoothillsConfig(options);
    if (cfg.model === 'legacy') {
        return {
            band: 'dSmoothstep(FOOTHILL_TT_START, FOOTHILL_TT_FULL, regional.terrainType)',
            calculation: `let hillN = fbmAuto_d(unitDir, SCALE_FOOTHILLS, 3, seed + 1950, 2.0, 0.5);
                foothillsH = dMul(footBand, dSmoothstep(-0.3, 0.6, hillN)) * ((HEIGHT_FOOTHILLS / maxTerrainHeightM()) * amp.mountainHeight);`,
        };
    }
    const n = wgslFloat;
    return {
        band: `dSmoothstep(${n(cfg.coverageStart)}, ${n(cfg.coverageFull)}, regional.terrainType)`,
        calculation: `let legacyBand = dSmoothstep(FOOTHILL_TT_START, FOOTHILL_TT_FULL, regional.terrainType);
                var existingFoothills = dConst(0.0);
                if (legacyBand.x > 0.0) {
                    let existingHill = fbmAuto_d(unitDir, SCALE_FOOTHILLS, 3, seed + 1950, 2.0, 0.5);
                    existingFoothills = dMul(legacyBand, dSmoothstep(-0.3, 0.6, existingHill)) * ((HEIGHT_FOOTHILLS / maxTerrainHeightM()) * amp.mountainHeight);
                }
                let change = dSmoothstep(${n(cfg.changeStart)}, ${n(cfg.changeFull)}, regional.terrainType);
                foothillsH = existingFoothills;
                if (change.x > 0.0) {
                    let regionN = fbmAuto_d(unitDir, ${n(cfg.regionScaleKm)}, 1, seed + 1977, 2.0, 0.5);
                    let R = noiseReferenceRadiusM();
                    let broadW = wavelength_m(${n(cfg.broadScaleKm)}, GEOLOGY_SCALE);
                    let broadStretch = vec3<f32>(${n(cfg.broadStretch)}, 1.0, 1.0);
                    let broadP = rotateDomain3(sphereDomainPos(unitDir, R) / broadW) * broadStretch;
                    let broadN = perlin3D_d(broadP, seed + 1950);
                    let broad = vec4<f32>(broadN.x, rotateDomain3Transpose(broadN.yzw * broadStretch) * (R / broadW));
                    let tightW = wavelength_m(${n(cfg.tightScaleKm)}, GEOLOGY_SCALE);
                    let tightStretch = vec3<f32>(1.0, ${n(cfg.tightStretch)}, 1.0);
                    let tightP = rotateDomain3(sphereDomainPos(unitDir, R) / tightW) * tightStretch;
                    let tightN = perlin3D_d(tightP, seed + 1951);
                    let tight = vec4<f32>(tightN.x, rotateDomain3Transpose(tightN.yzw * tightStretch) * (R / tightW));
                    let character = dSmoothstep(-0.30, 0.30, regionN);
                    let landform = dMix(broad, tight, character) + regionN * ${n(cfg.regionBias)};
                    let variation = dMul(footBand, landform) * ((HEIGHT_FOOTHILLS * ${n(cfg.strength)} / maxTerrainHeightM()) * amp.mountainHeight);
                    foothillsH = existingFoothills + dMul(change, variation);
                }`,
    };
}
