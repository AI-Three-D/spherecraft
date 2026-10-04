export class TerrainGenerationConfig {
    constructor(options = {}) {
        // Noise reference radius in meters (optional override; default uses planet radius).
        const noiseReferenceRadiusM = options.noiseReferenceRadiusM;
        this.noiseReferenceRadiusM = Number.isFinite(noiseReferenceRadiusM)
            ? noiseReferenceRadiusM
            : null;

        // Base generator selection (used by WebGPU terrain shader assembly).
        this.baseGenerator = options.baseGenerator ?? 'earthLike';


        // RuneVision erosion filter (templates/terrain-shaders/features/
        // featureErosionFilter.wgsl.js, MPL-2.0), always on: erodes the
        // landform of the sphere terrain. All lengths in metres; see the
        // filter file for the parameters.
        const ef = options.erosionFilter ?? {};
        const num = (v, d) => (Number.isFinite(v) ? v : d);
        const vec = (v, d) => (Array.isArray(v) && v.length === d.length && v.every(Number.isFinite) ? v.slice() : d);
        this.erosionFilter = {
            scale: num(ef.scale, 1500),
            strength: num(ef.strength, 0.22),
            gullyWeight: num(ef.gullyWeight, 0.5),
            detail: num(ef.detail, 1.5),
            // rounding.z (input rounding) 1.0 and onset.x 0.9 (RuneVision demo:
            // 0.1, 1.25): gullies fade in more gently where the input is nearly
            // flat. At summits and saddles the gully direction spins around a
            // point; with a sharp onset that left pinch points and closed
            // crease rings around hilltops.
            // On the sphere terrain rounding.x / .y / .z set only the input
            // mask (first-octave onset); the octaves' ridge and crease
            // rounding come from styleRidgeRounding / styleCreaseRounding
            // (below). .w (per-octave multiplier) applies as is.
            // Crease rounding >= 0.1 (demo: 0.0): zero-width V gully bottoms
            // alias on the tile grid. Ridge rounding 0.1 (demo) made a narrow
            // band along each coarser crest where the finer octaves fade
            // out: a ~60 m wide raised cap above concave shoulders down most
            // spurs ("spinal cord"); 0.2+ softens it.
            rounding: vec(ef.rounding, [0.3, 0.1, 1.0, 2.0]),
            onset: vec(ef.onset, [0.9, 1.25, 2.8, 1.5]),
            assumedSlope: vec(ef.assumedSlope, [0.7, 1.0]),
            octaves: Math.max(1, Math.min(8, Math.round(num(ef.octaves, 5)))),
            lacunarity: num(ef.lacunarity, 2.0),
            gain: num(ef.gain, 0.5),
            cellScale: num(ef.cellScale, 0.7),
            normalization: num(ef.normalization, 0.5),
            normalSquash: num(ef.normalSquash, 2.5),
            // Height above the regional base that maps to the filter's fade
            // target range [-1, 1] (valleys .. peaks).
            fadeRangeM: num(ef.fadeRangeM, 1200),
            // Local amount (multiplies strength) = variation x relief ramp.
            // Relief = summed height of the large landforms (mountains,
            // highlands, big lone hills): lowReliefAmount below reliefStartM,
            // full from reliefFullM. Variation: a noise field with wavelength
            // variationScaleM between variationMin and 1, so some regions are
            // rugged and others gentle. Where the amount is 0 the filter is
            // skipped. The small lone-hill domes fade out over the same relief
            // ramp (scaled by (1 - ramp)^2).
            reliefStartM: num(ef.reliefStartM, 150),
            reliefFullM: num(ef.reliefFullM, 600),
            lowReliefAmount: num(ef.lowReliefAmount, 0.2),
            // Steepness ramp (input slope, rise over run): erosion at full
            // amount from sharpSlopeFull, none below sharpSlopeStart. Keeps
            // gullies off summits, saddles and valley floors (where they
            // pinched into bowties) and lightens erosion on gentle ground.
            sharpSlopeStart: num(ef.sharpSlopeStart, 0.05),
            sharpSlopeFull: num(ef.sharpSlopeFull, 0.45),
            variationScaleM: num(ef.variationScaleM, 15000),
            variationMin: num(ef.variationMin, 0.15),
            // Fraction of meso1/meso2 kept where erosion is at full amount
            // (1 everywhere it is 0).
            mesoKeep: num(ef.mesoKeep, 0.35),
            // Ridge/crease rounding used where the amount is low (light
            // erosion as soft undulation, not etched lines): fully at amount
            // <= softAmountFull, not at all from softAmountNone.
            lowAmountRounding: num(ef.lowAmountRounding, 1.0),
            softAmountFull: num(ef.softAmountFull, 0.15),
            softAmountNone: num(ef.softAmountNone, 0.6),
            // Mountain style by location: a noise field (wavelength
            // styleScaleM) from 0 = rounded (old, grassy ridges) to
            // 1 = jagged (sharp crests, deep couloirs). styleBias shifts
            // the mix: -1 all rounded, 0 about half each, +1 all jagged.
            // Each pair below is [rounded, jagged]:
            // - styleStrength multiplies the erosion amount;
            // - styleRidgeRounding / styleCreaseRounding replace rounding.x
            //   / rounding.y (before the low-amount softening);
            // - styleMountainHeight scales the mountain ranges, and rounded
            //   ranges use their smooth shape (jagged: the ridged one).
            // Rounding compounds per octave (x rounding.w), so values much
            // above 0.5 suppress the finer octaves and with them the
            // branching valleys.
            styleScaleM: num(ef.styleScaleM, 40000),
            styleBias: num(ef.styleBias, 0.0),
            styleStrength: vec(ef.styleStrength, [0.8, 1.3]),
            styleRidgeRounding: vec(ef.styleRidgeRounding, [0.4, 0.2]),
            styleCreaseRounding: vec(ef.styleCreaseRounding, [0.3, 0.1]),
            styleMountainHeight: vec(ef.styleMountainHeight, [0.8, 1.15]),
            seed: Math.round(num(ef.seed, 7))
        };

        // Terrain feature toggles: { mountains: false, ... } switches a term
        // of the height function off. Keys and descriptions:
        // core/world/terrain-generator/terrainFeatureToggles.js. At runtime:
        // qtDiag.setTerrainFeatures({...}) / qtDiag.terrainFeatures().
        this.features = { ...(options.features ?? {}) };

        // High-level noise profile knobs (shader expects these in _pad3/_pad4).
        const profile = options.noiseProfile ?? {};
        this.noiseProfile = {
            baseBias: profile.baseBias ?? 1.0,
            mountainBias: profile.mountainBias ?? 1.0,
            hillBias: profile.hillBias ?? 1.0,
            canyonBias: profile.canyonBias ?? 1.0,
            rareBoost: profile.rareBoost ?? 1.0,
            warpStrength: profile.warpStrength ?? 1.0,
            ridgeSharpness: profile.ridgeSharpness ?? 1.0,
            microGain: profile.microGain ?? 1.0
        };

        // Surface (tile) distribution tuning
        const surface = options.surface ?? {};
        this.surface = {
            rockCoverageMin: surface.rockCoverageMin ?? 0.05,
            rockCoverageMax: surface.rockCoverageMax ?? 0.25,
            rockSlopeStart: surface.rockSlopeStart ?? 0.25,
            rockSlopeFull: surface.rockSlopeFull ?? 0.60
        };

        // Continental configuration
        this.continents = {
            enabled: options.continents?.enabled ?? true,
            count: options.continents?.count ?? 7,
            averageSize: options.continents?.averageSize ?? 0.3, // 0-1, fraction of surface
            coastalComplexity: options.continents?.coastalComplexity ?? 0.7 // 0-1, fractal dimension
        };

        // Tectonic plates
        this.tectonics = {
            enabled: options.tectonics?.enabled ?? true,
            plateCount: options.tectonics?.plateCount ?? 12,
            mountainBuildingRate: options.tectonics?.mountainBuildingRate ?? 1.0,
            riftValleyDepth: options.tectonics?.riftValleyDepth ?? 0.5
        };

        // Volcanic activity
        this.volcanism = {
            enabled: options.volcanism?.enabled ?? true,
            hotspotDensity: options.volcanism?.hotspotDensity ?? 0.00001, // per sq km
            plateBoundaryActivity: options.volcanism?.plateBoundaryActivity ?? 0.8, // 0-1
            averageHeight: options.volcanism?.averageHeight ?? 1500 // meters
        };

        // Impact craters
        this.impacts = {
            enabled: options.impacts?.enabled ?? true,
            craterDensity: options.impacts?.craterDensity ?? 0.00005 // per sq km
        };

        // Erosion parameters
        this.erosion = {
            enabled: options.erosion?.enabled ?? true,
            globalRate: options.erosion?.globalRate ?? 0.5, // 0-1 scale
            thermalRate: options.erosion?.thermalRate ?? 0.3, // slope-based
            hydraulicRate: options.erosion?.hydraulicRate ?? 0.6 // water-based
        };

        this.climate = {
            enabled: options.climate?.enabled ?? true,
            temperatureGradient: options.climate?.temperatureGradient ?? -6.5, // °C per 1000m
            baseTemperature: options.climate?.baseTemperature ?? 30.0, // °C at sea level equator
            
            // Temperature bands with precipitation ranges
            zones: options.climate?.zones ?? [
                { 
                    name: 'polar', 
                    minLat: 66.5, 
                    maxLat: 90, 
                    tempModifier: -50,
                    precipitationMin: 0.1,  // Dry (polar desert)
                    precipitationMax: 0.4   // Occasionally high precipitation (coastal)
                },
                { 
                    name: 'subpolar', 
                    minLat: 55, 
                    maxLat: 66.5, 
                    tempModifier: -30,
                    precipitationMin: 0.3,  // Moderate
                    precipitationMax: 0.7   // High precipitation (maritime)
                },
                { 
                    name: 'temperate', 
                    minLat: 30, 
                    maxLat: 55, 
                    tempModifier: -10,
                    precipitationMin: 0.2,  // Semi-arid
                    precipitationMax: 0.9   // Very high precipitation
                },
                { 
                    name: 'subtropical', 
                    minLat: 23.5, 
                    maxLat: 30, 
                    tempModifier: 0,
                    precipitationMin: 0.1,  // Desert
                    precipitationMax: 0.8   // High precipitation subtropical
                },
                { 
                    name: 'tropical', 
                    minLat: 0, 
                    maxLat: 23.5, 
                    tempModifier: 5,
                    precipitationMin: 0.2,  // Savanna
                    precipitationMax: 1.0   // Rainforest
                }
            ],

            // Precipitation noise scales
            precipitationScale: options.climate?.precipitationScale ?? 14.0  // ~14km regions (less regular banding)
        };
        // Water configuration
        this.water = {
            enabled: options.water?.enabled ?? true,
            hasOceans: options.water?.hasOceans ?? true,
            // Ocean level is expressed in the same *normalized height units* as the WebGPU
            // terrain generator output (see `advancedTerrainCompute.wgsl` outputType 0).
            // Convert to meters in rendering by multiplying with `planetConfig.heightScale`.
            oceanLevel: options.water?.oceanLevel ?? 0.0,
            averageOceanDepth: options.water?.averageOceanDepth ?? 3700, // meters
            // Visual attenuation range used by the water renderer (meters). This is an
            // artistic scattering/absorption length and is not used by terrain generation.
            // If omitted, the renderer derives a reasonable value from `averageOceanDepth`.
            visualDepthRange: options.water?.visualDepthRange ?? null,
            waveHeight: options.water?.waveHeight ?? 1.5 // average meters
        };

        // River channel — carved directly into terrain height at generation
        // time (see templates/terrain-shaders/features/featureRivers.wgsl.js),
        // not a separate overlay mesh. Walking-skeleton scope: one fixed
        // straight channel, no authoring format yet. `anchorDir`/`channelDir`
        // are unit direction vectors from the planet's own origin (NOT real
        // meters — normalized before use on the shader side); `channelDir`
        // must be perpendicular to `anchorDir` (a tangent at that point).
        // Because a tile's height is baked once and never invalidated (see
        // RIVER_WALKING_SKELETON_LOG.md, Session 4), this anchor must be a
        // FIXED value known before any terrain generates — it cannot be
        // computed dynamically from wherever the player happens to spawn,
        // the way the original walking-skeleton design worked. Whatever
        // caller places the river's water simulation (RiverSystem) should
        // anchor itself to this SAME fixed point, not the other way around.
        const river = options.river ?? {};
        this.river = {
            enabled: river.enabled ?? false,
            anchorDir: river.anchorDir ?? { x: 0, y: 1, z: 0 },
            channelDir: river.channelDir ?? { x: 1, y: 0, z: 0 },
            halfWidthM: river.halfWidthM ?? 16,
            depthM: river.depthM ?? 3,
            lengthM: river.lengthM ?? 128,
            // Traced steepest-descent path (HydrologyPrecompute.js), set at
            // runtime once the precompute finishes — empty until then, which
            // is a valid state (see featureRiverHeight()'s fallback).
            // Each entry: {along, across, widthScale, depthScale}.
            path: river.path ?? [],
        };

        // Stage-2 confirmed erosion-seed basins (ErosionSeedVerifier.js), set
        // at runtime once verification finishes — empty until then, which is
        // a valid state (every level-1 candidate just stays at its own small
        // nudge size, see featureErosionSeedsHeight()). Each entry:
        // {regionX, regionY, radiusScale, depthScale}.
        const erosionSeeds = options.erosionSeeds ?? {};
        this.erosionSeeds = {
            confirmed: erosionSeeds.confirmed ?? [],
        };
    }

    // Get shader-compatible uniform data
    toShaderUniforms() {
        return {
            // Continental parameters (vec4)
            continentParams: [
                this.continents.enabled ? 1.0 : 0.0,
                this.continents.count,
                this.continents.averageSize,
                this.continents.coastalComplexity
            ],
            
            // Tectonic parameters (vec4)
            tectonicParams: [
                this.tectonics.enabled ? 1.0 : 0.0,
                this.tectonics.plateCount,
                this.tectonics.mountainBuildingRate,
                this.tectonics.riftValleyDepth
            ],
            
            // Volcanic parameters (vec4)
            volcanicParams: [
                this.volcanism.enabled ? 1.0 : 0.0,
                this.volcanism.plateBoundaryActivity,
                this.volcanism.averageHeight / 10000.0, // normalize
                this.volcanism.hotspotDensity * 1000000 // scale for shader
            ],
            
            // Erosion parameters (vec4)
            erosionParams: [
                this.erosion.enabled ? 1.0 : 0.0,
                this.erosion.globalRate,
                this.erosion.hydraulicRate,
                this.erosion.thermalRate
            ],
            
            // Water parameters (vec4)
            waterParams: [
                this.water.hasOceans ? 1.0 : 0.0,
                this.water.oceanLevel,
                this.water.averageOceanDepth,
                this.water.waveHeight
            ],
            


            // Noise profile parameters (vec4 + vec4)
            noiseProfileA: [
                this.noiseProfile.baseBias,
                this.noiseProfile.mountainBias,
                this.noiseProfile.hillBias,
                this.noiseProfile.canyonBias
            ],
            noiseProfileB: [
                this.noiseProfile.rareBoost,
                this.noiseProfile.warpStrength,
                this.noiseProfile.ridgeSharpness,
                this.noiseProfile.microGain
            ],

            // Surface parameters (vec4)
            surfaceParams: [
                this.surface.rockCoverageMin,
                this.surface.rockCoverageMax,
                this.surface.rockSlopeStart,
                this.surface.rockSlopeFull
            ],
                 // Climate parameters (vec4) - update this one
            climateParams: [
                this.climate.temperatureGradient,
                this.climate.baseTemperature,
                this.climate.precipitationScale,
                this.climate.enabled ? 1.0 : 0.0
            ],

            // Add climate zone data (we'll pass the most important zones)
            // Pack into vec4s: [minLat, maxLat, tempModifier, precipitationMin]
            climateZone0: [
                this.climate.zones[4].minLat,  // tropical
                this.climate.zones[4].maxLat,
                this.climate.zones[4].tempModifier,
                this.climate.zones[4].precipitationMin
            ],
            climateZone0Extra: [
                this.climate.zones[4].precipitationMax,
                0, 0, 0
            ],
            
            climateZone1: [
                this.climate.zones[3].minLat,  // subtropical
                this.climate.zones[3].maxLat,
                this.climate.zones[3].tempModifier,
                this.climate.zones[3].precipitationMin
            ],
            climateZone1Extra: [
                this.climate.zones[3].precipitationMax,
                0, 0, 0
            ],
            
            climateZone2: [
                this.climate.zones[2].minLat,  // temperate
                this.climate.zones[2].maxLat,
                this.climate.zones[2].tempModifier,
                this.climate.zones[2].precipitationMin
            ],
            climateZone2Extra: [
                this.climate.zones[2].precipitationMax,
                0, 0, 0
            ],
            
            climateZone3: [
                this.climate.zones[1].minLat,  // subpolar
                this.climate.zones[1].maxLat,
                this.climate.zones[1].tempModifier,
                this.climate.zones[1].precipitationMin
            ],
            climateZone3Extra: [
                this.climate.zones[1].precipitationMax,
                0, 0, 0
            ],
            
            climateZone4: [
                this.climate.zones[0].minLat,  // polar
                this.climate.zones[0].maxLat,
                this.climate.zones[0].tempModifier,
                this.climate.zones[0].precipitationMin
            ],
            climateZone4Extra: [
                this.climate.zones[0].precipitationMax,
                0, 0, 0
            ],

            // River channel (vec4 x3) — see featureRivers.wgsl.js.
            riverAnchor: [
                this.river.anchorDir.x,
                this.river.anchorDir.y,
                this.river.anchorDir.z,
                this.river.enabled ? 1.0 : 0.0
            ],
            riverChannelDir: [
                this.river.channelDir.x,
                this.river.channelDir.y,
                this.river.channelDir.z,
                0.0
            ],
            riverPath: this.river.path,
            riverParams: [
                this.river.halfWidthM,
                this.river.depthM,
                this.river.lengthM,
                0.0
            ],
            erosionConfirmed: this.erosionSeeds.confirmed,
        };
    }

    // Validation
    validate() {
        const errors = [];
        
        if (this.continents.count < 0 || this.continents.count > 20) {
            errors.push('Continent count must be between 0 and 20');
        }
        
        if (this.tectonics.plateCount < 1 || this.tectonics.plateCount > 50) {
            errors.push('Plate count must be between 1 and 50');
        }
        
        return errors;
    }

    // Factory methods for different planet types
    static createEarthLike() {
        return new TerrainGenerationConfig({
            continents: { count: 7, averageSize: 0.29 },
            tectonics: { plateCount: 15 },
            volcanism: { plateBoundaryActivity: 0.7 },
            water: { hasOceans: true, oceanLevel: 0 }
        });
    }

    static createMarsLike() {
        return new TerrainGenerationConfig({
            continents: { count: 2, averageSize: 0.4 },
            tectonics: { enabled: false }, // Mars is tectonically dead
            volcanism: { 
                enabled: true, 
                plateBoundaryActivity: 0, 
                hotspotDensity: 0.00005 // Olympus Mons type
            },
            water: { hasOceans: false },
            erosion: { hydraulicRate: 0.1 },
            impacts: { craterDensity: 0.001 } // heavily cratered
        });
    }

    static createMoonLike() {
        return new TerrainGenerationConfig({
            continents: { enabled: false },
            tectonics: { enabled: false },
            volcanism: { enabled: false },
            water: { hasOceans: false },
            erosion: { enabled: false },
            impacts: { craterDensity: 0.01 }, // many preserved craters
            climate: { enabled: false }
        });
    }

    static createOceanWorld() {
        return new TerrainGenerationConfig({
            continents: { count: 0 }, // only small islands
            water: { 
                hasOceans: true, 
                oceanLevel: 100, // higher ocean level
                averageOceanDepth: 5000 
            },
            volcanism: { 
                hotspotDensity: 0.0001, // volcanic islands
                plateBoundaryActivity: 0.9 
            }
        });
    }
}
