// Unfinished trial for views.mjs; not part of the runtime terrain.
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
                let relief = dSmoothstep(-0.55, 0.55, landform);
                foothillsH = dMul(footBand, relief) * ((HEIGHT_FOOTHILLS * 2.0 / maxTerrainHeightM()) * amp.mountainHeight);
