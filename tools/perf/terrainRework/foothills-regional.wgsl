// Unfinished zero-centred trial for views.mjs; not part of runtime terrain.
let legacyBand = dSmoothstep(FOOTHILL_TT_START, FOOTHILL_TT_FULL, regional.terrainType);
                var existingFoothills = dConst(0.0);
                if (legacyBand.x > 0.0) {
                    let existingHill = fbmAuto_d(unitDir, SCALE_FOOTHILLS, 3, seed + 1950, 2.0, 0.5);
                    existingFoothills = dMul(legacyBand, dSmoothstep(-0.3, 0.6, existingHill)) * ((HEIGHT_FOOTHILLS / maxTerrainHeightM()) * amp.mountainHeight);
                }
                let change = dSmoothstep(0.40, 0.50, regional.terrainType);
                foothillsH = existingFoothills;
                if (change.x > 0.0) {
                let regionN = fbmAuto_d(unitDir, 28.0, 1, seed + 1977, 2.0, 0.5);
                let R = noiseReferenceRadiusM();
                let broadW = wavelength_m(7.0, GEOLOGY_SCALE);
                let broadStretch = vec3<f32>(0.48, 1.0, 1.0);
                let broadP = rotateDomain3(sphereDomainPos(unitDir, R) / broadW) * broadStretch;
                let broadN = perlin3D_d(broadP, seed + 1950);
                let broad = vec4<f32>(broadN.x, rotateDomain3Transpose(broadN.yzw * broadStretch) * (R / broadW));
                let tightW = wavelength_m(2.7, GEOLOGY_SCALE);
                let tightStretch = vec3<f32>(1.0, 0.65, 1.0);
                let tightP = rotateDomain3(sphereDomainPos(unitDir, R) / tightW) * tightStretch;
                let tightN = perlin3D_d(tightP, seed + 1951);
                let tight = vec4<f32>(tightN.x, rotateDomain3Transpose(tightN.yzw * tightStretch) * (R / tightW));
                let character = dSmoothstep(-0.30, 0.30, regionN);
                let landform = dMix(broad, tight, character) + regionN * 0.18;
                let variation = dMul(footBand, landform) * ((HEIGHT_FOOTHILLS * 1.8 / maxTerrainHeightM()) * amp.mountainHeight);
                foothillsH = existingFoothills + dMul(change, variation);
                }
