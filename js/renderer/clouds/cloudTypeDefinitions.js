// js/renderer/clouds/cloudTypeDefinitions.js
// Defines characteristics for different cloud types

/**
 * Cloud Type Definitions
 *
 * Altitude ranges (normalized to atmosphere height):
 * - Low: 0.0 - 0.2 (0-2km on Earth)
 * - Mid: 0.2 - 0.5 (2-6km on Earth)
 * - High: 0.5 - 1.0 (6-12km on Earth)
 *
 * Each cloud type has:
 * - altitudeMin/Max: Height range as fraction of atmosphere
 * - densityMultiplier: How dense/thick the clouds are
 * - noiseScale: Size of cloud features (larger = bigger clouds)
 * - detailScale: Size of detail features
 * - verticalStretch: How much to stretch vertically (< 1 = flat, > 1 = tall)
 * - worleyInfluence: How cellular/bumpy (0 = smooth, 1 = very cellular)
 * - edgeSoftness: How soft the edges are (0 = hard, 1 = very soft)
 * - extinction: Light absorption (higher = darker)
 * - albedo: Reflectivity (higher = brighter white)
 */

export const CloudTypes = {
    // === HIGH CLOUDS (ice crystals) ===

    CIRRUS: {
        name: 'cirrus',
        altitudeMin: 0.6,
        altitudeMax: 1.0,
        densityMultiplier: 0.18,      // Very thin wisps
        noiseScale: 3.2,              // Larger streaky features
        detailScale: 0.8,
        verticalStretch: 0.1,         // Very flat/streaky
        worleyInfluence: 0.25,        // Slight cellular break-up
        edgeSoftness: 0.88,           // Wispy edges
        extinction: 0.012,            // Very transparent
        albedo: 1.0,                  // Bright white
        windSpeedMult: 2.0,           // High altitude = faster wind
        description: 'Thin, wispy, hair-like streaks'
    },

    CIRROCUMULUS: {
        name: 'cirrocumulus',
        altitudeMin: 0.55,
        altitudeMax: 0.85,
        densityMultiplier: 0.25,
        noiseScale: 0.6,              // Small patches (mackerel sky)
        detailScale: 0.4,
        verticalStretch: 0.3,         // Fairly flat
        worleyInfluence: 0.8,         // Very cellular pattern
        edgeSoftness: 0.6,
        extinction: 0.02,
        albedo: 1.0,
        windSpeedMult: 1.8,
        description: 'Small white patches, rippled pattern'
    },

    CIRROSTRATUS: {
        name: 'cirrostratus',
        altitudeMin: 0.5,
        altitudeMax: 0.9,
        densityMultiplier: 0.18,
        noiseScale: 3.5,              // Break up uniform veils
        detailScale: 2.0,
        verticalStretch: 0.15,        // Thin layer
        worleyInfluence: 0.2,         // Slight streaking
        edgeSoftness: 0.8,            // Softer, but not a uniform veil
        extinction: 0.012,
        albedo: 0.95,
        windSpeedMult: 1.5,
        description: 'Thin veil, creates halos'
    },

    // === MID CLOUDS ===

    ALTOCUMULUS: {
        name: 'altocumulus',
        altitudeMin: 0.25,
        cauliflower: 0.45, // baseline softer than now
        altitudeMax: 0.55,
        densityMultiplier: 0.5,
        noiseScale: 1.2,              // Medium-sized patches
        detailScale: 0.6,
        verticalStretch: 0.4,
        worleyInfluence: 0.7,         // Cellular, but softer than cirrocumulus
        edgeSoftness: 0.5,
        extinction: 0.04,
        albedo: 0.9,
        windSpeedMult: 1.2,
        description: 'White/grey patches, larger than cirrocumulus'
    },

    ALTOSTRATUS: {
        name: 'altostratus',
        altitudeMin: 0.2,
        altitudeMax: 0.5,
        densityMultiplier: 0.6,
        noiseScale: 4.0,              // Large uniform layer
        detailScale: 1.5,
        verticalStretch: 0.25,
        worleyInfluence: 0.2,
        edgeSoftness: 0.7,
        extinction: 0.06,
        albedo: 0.7,                  // Greyish
        windSpeedMult: 1.0,
        description: 'Grey/blue sheet, sun appears watery'
    },

    // === LOW CLOUDS ===

    STRATOCUMULUS: {
        name: 'stratocumulus',
        altitudeMin: 0.05,
        cauliflower: 0.25, // baseline softer than now
        altitudeMax: 0.25,
        densityMultiplier: 0.7,
        noiseScale: 1.5,
        detailScale: 0.7,
        verticalStretch: 0.5,
        worleyInfluence: 0.6,         // Lumpy patches
        edgeSoftness: 0.4,
        extinction: 0.05,
        albedo: 0.85,
        windSpeedMult: 0.8,
        description: 'Lumpy grey/white layer with gaps'
    },

    STRATUS: {
        name: 'stratus',
        altitudeMin: 0.0,
        altitudeMax: 0.15,
        densityMultiplier: 0.5,
        noiseScale: 6.0,              // Very uniform
        detailScale: 2.0,
        verticalStretch: 0.2,         // Flat layer
        worleyInfluence: 0.1,         // Smooth, fog-like
        edgeSoftness: 0.8,
        extinction: 0.04,
        albedo: 0.75,                 // Grey
        windSpeedMult: 0.6,
        description: 'Uniform grey layer, fog-like'
    },

    CUMULUS: {
        name: 'cumulus',
        altitudeMin: 0.05,
        altitudeMax: 0.3,

        noiseScale: 1.0,
        detailScale: 0.9,
        verticalStretch: 1.2,         // Taller than wide

        densityMultiplier: 0.15,   // was 0.7
        extinction: 0.022,         // was 0.035
        edgeSoftness: 0.90,        // was 0.45
        worleyInfluence: 0.35,     // was 0.9 (less “one big cell”)
        cauliflower: 0.8, // baseline softer than now
        albedo: 1.0,                  // Bright white
        windSpeedMult: 1.0,
        description: 'Fluffy fair-weather clouds'
    },

    CUMULUS_CONGESTUS: {
        name: 'cumulus_congestus',
        cauliflower: 0.65, // baseline softer than now
        altitudeMin: 0.05,
        altitudeMax: 0.5,
        densityMultiplier: 0.9,
        noiseScale: 1.2,
        detailScale: 0.5,
        verticalStretch: 2.0,         // Towering
        worleyInfluence: 0.65,
        edgeSoftness: 0.4,
        extinction: 0.05,
        albedo: 0.95,
        windSpeedMult: 1.0,
        description: 'Towering cumulus, may produce showers'
    },

    // === RAIN/STORM CLOUDS ===

    NIMBOSTRATUS: {
        name: 'nimbostratus',
        altitudeMin: 0.0,
        altitudeMax: 0.4,
        densityMultiplier: 1.0,
        noiseScale: 3.0,
        detailScale: 1.0,
        verticalStretch: 0.6,
        worleyInfluence: 0.3,
        edgeSoftness: 0.5,
        extinction: 0.12,             // Dark
        albedo: 0.5,                  // Dark grey
        windSpeedMult: 0.8,
        description: 'Thick dark grey rain cloud'
    },

    CUMULONIMBUS: {
        name: 'cumulonimbus',
        altitudeMin: 0.02,
        cauliflower: 0.85, // baseline softer than now
        altitudeMax: 0.95,            // Spans almost entire atmosphere
        densityMultiplier: 1.2,
        noiseScale: 1.5,
        detailScale: 0.6,
        verticalStretch: 3.0,         // Very tall towers
        worleyInfluence: 0.85,        // Very cellular
        edgeSoftness: 0.25,
        extinction: 0.16,             // Very dark base
        albedo: 0.4,                  // Dark
        windSpeedMult: 1.2,
        anvilTop: true,               // Has anvil-shaped top
        description: 'Towering storm cloud with anvil'
    }
};

/**
 * Weather to cloud type mapping
 * Returns array of cloud types with their coverage for given weather
 */
export function getCloudTypesForWeather(weather, intensity = 0.5) {
    const i = Math.max(0, Math.min(1, intensity));

    switch (weather) {
        case 'clear':
            return [
                { type: CloudTypes.CIRRUS, coverage: 0.05 + i * 0.1 },
                { type: CloudTypes.CUMULUS, coverage: 0.2 + i * 0.15 }
            ];

        case 'partly_cloudy':
            return [
                { type: CloudTypes.CIRRUS, coverage: 0.1 + i * 0.15 },
                { type: CloudTypes.CUMULUS, coverage: 0.3 + i * 0.2 },
            ];

        case 'cloudy':
            return [
                { type: CloudTypes.CIRRUS, coverage: 0.2 + i * 0.2 },
                { type: CloudTypes.CUMULUS, coverage: 0.3 + i * 0.2 },
            ];

        case 'overcast':
            return [
                { type: CloudTypes.CIRRUS, coverage: 0.25 + i * 0.2 },
                { type: CloudTypes.CUMULUS, coverage: 0.3 + i * 0.2 },
            ];

        case 'rain':
            return [
                { type: CloudTypes.CIRRUS, coverage: 0.2 + i * 0.15 },
                { type: CloudTypes.CUMULUS, coverage: 0.3 + i * 0.2 },
            ];

        case 'storm':
            return [
                { type: CloudTypes.CIRRUS, coverage: 0.18 + i * 0.15 },
                { type: CloudTypes.CUMULUS, coverage: 0.3 + i * 0.2 },
            ];

        case 'foggy':
            return [
                { type: CloudTypes.CIRRUS, coverage: 0.1 + i * 0.1 },
                { type: CloudTypes.CUMULUS, coverage: 0.3 + i * 0.2 },
            ];

        case 'snow':
            return [
                { type: CloudTypes.CIRRUS, coverage: 0.18 + i * 0.15 },
                { type: CloudTypes.CUMULUS, coverage: 0.3 + i * 0.2 },
            ];
        default:
            return [
                { type: CloudTypes.CUMULUS, coverage: 0.35 },
                { type: CloudTypes.CIRRUS, coverage: 0.45 }
            ];
    }
}

/**
 * Get simplified cloud layer configuration for shader
 * Combines multiple cloud types into renderable layers
 */
export function getCloudLayers(weather, intensity, atmosphereHeight) {
    const cloudTypes = getCloudTypesForWeather(weather, intensity);

    // Group into 3 altitude bands for efficient rendering
    const layers = {
        low: { coverage: 0, types: [], altMin: 0, altMax: 0.25 },
        mid: { coverage: 0, types: [], altMin: 0.2, altMax: 0.55 },
        high: { coverage: 0, types: [], altMin: 0.5, altMax: 1.0 }
    };

    for (const { type, coverage } of cloudTypes) {
        const centerAlt = (type.altitudeMin + type.altitudeMax) / 2;

        if (centerAlt < 0.25) {
            layers.low.coverage = Math.max(layers.low.coverage, coverage);
            layers.low.types.push({ type, coverage });
        } else if (centerAlt < 0.55) {
            layers.mid.coverage = Math.max(layers.mid.coverage, coverage);
            layers.mid.types.push({ type, coverage });
        } else {
            layers.high.coverage = Math.max(layers.high.coverage, coverage);
            layers.high.types.push({ type, coverage });
        }
    }

    // Compute blended parameters for each layer
    const result = [];

    for (const [name, layer] of Object.entries(layers)) {
        if (layer.types.length === 0) continue;

        // Weighted average of type parameters
        let totalWeight = 0;
        const blended = {
            name,
            coverage: layer.coverage,
            altMin: layer.altMin * atmosphereHeight,
            altMax: layer.altMax * atmosphereHeight,
            densityMultiplier: 0,
            noiseScale: 0,
            verticalStretch: 0,
            worleyInfluence: 0,
            edgeSoftness: 0,
            extinction: 0,
            albedo: 0,
            windSpeedMult: 0,
            cauliflower: 0,
        };

        for (const { type, coverage: cov } of layer.types) {
            const w = cov;
            totalWeight += w;
            blended.densityMultiplier += type.densityMultiplier * w;
            blended.noiseScale += type.noiseScale * w;
            blended.verticalStretch += type.verticalStretch * w;
            blended.worleyInfluence += type.worleyInfluence * w;
            blended.edgeSoftness += type.edgeSoftness * w;
            blended.extinction += type.extinction * w;
            blended.albedo += type.albedo * w;
            blended.windSpeedMult += type.windSpeedMult * w;
            blended.cauliflower += (type.cauliflower ?? 0.35) * w;
        }

        if (totalWeight > 0) {
            blended.densityMultiplier /= totalWeight;
            blended.noiseScale /= totalWeight;
            blended.verticalStretch /= totalWeight;
            blended.worleyInfluence /= totalWeight;
            blended.edgeSoftness /= totalWeight;
            blended.extinction /= totalWeight;
            blended.albedo /= totalWeight;
            blended.windSpeedMult /= totalWeight;
            blended.cauliflower /= totalWeight;
        }

        // Global tuning to reduce harshness and overly solid clouds
        blended.densityMultiplier *= 0.9;
        blended.extinction *= 0.9;
        blended.worleyInfluence *= 0.9;
        blended.edgeSoftness = Math.min(1.0, Math.max(0.0, blended.edgeSoftness + 0.12));

        if (name === 'high') {
            blended.coverage = Math.min(blended.coverage, 0.75);
            blended.densityMultiplier *= 0.7;
            blended.extinction *= 0.7;
            blended.worleyInfluence = Math.max(blended.worleyInfluence, 0.22);
            blended.edgeSoftness = Math.min(blended.edgeSoftness, 0.85);
            blended.noiseScale = Math.max(blended.noiseScale, 1.8);
        }

        result.push(blended);
    }

    return result;
}
