export class TerrainGenerationConfig {
    constructor(options = {}) {
        // Noise reference radius in meters (optional override; default uses planet radius).
        const noiseReferenceRadiusM = options.noiseReferenceRadiusM;
        this.noiseReferenceRadiusM = Number.isFinite(noiseReferenceRadiusM)
            ? noiseReferenceRadiusM
            : null;

        // Base generator selection (used by WebGPU terrain shader assembly).
        this.baseGenerator = options.baseGenerator ?? 'earthLike';

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
            ]
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
