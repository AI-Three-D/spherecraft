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
    // === LOW / MID CLOUDS ===

    CUMULUS: {
        name: 'cumulus',
        altitudeMin: 0.08,
        altitudeMax: 0.22,
        densityMultiplier: 0.42,
        noiseScale: 1.0,
        detailScale: 0.9,
        verticalStretch: 0.65,
        worleyInfluence: 0.62,
        edgeSoftness: 0.58,
        extinction: 0.035,
        albedo: 0.92,
        windSpeedMult: 0.9,
        precipitation: 0.0,
        darkness: 0.05,
        cauliflower: 0.70,
        description: 'Small fair-weather puffs'
    },

    STRATUS: {
        name: 'stratus',
        altitudeMin: 0.05,
        altitudeMax: 0.18,
        densityMultiplier: 0.34,
        noiseScale: 1.8,
        detailScale: 1.2,
        verticalStretch: 0.20,
        worleyInfluence: 0.28,
        edgeSoftness: 0.92,
        extinction: 0.030,
        albedo: 0.78,
        windSpeedMult: 0.75,
        precipitation: 0.05,
        darkness: 0.16,
        cauliflower: 0.18,
        description: 'Flat low overcast sheets'
    },

    NIMBOSTRATUS: {
        name: 'nimbostratus',
        altitudeMin: 0.06,
        altitudeMax: 0.34,
        densityMultiplier: 0.74,
        noiseScale: 1.35,
        detailScale: 1.6,
        verticalStretch: 0.45,
        worleyInfluence: 0.42,
        edgeSoftness: 0.88,
        extinction: 0.080,
        albedo: 0.58,
        windSpeedMult: 0.95,
        precipitation: 0.85,
        darkness: 0.48,
        cauliflower: 0.32,
        description: 'Deep grey rain deck'
    },

    CUMULONIMBUS: {
        name: 'cumulonimbus',
        altitudeMin: 0.08,
        altitudeMax: 0.62,
        densityMultiplier: 0.92,
        noiseScale: 0.72,
        detailScale: 1.1,
        verticalStretch: 1.85,
        worleyInfluence: 0.78,
        edgeSoftness: 0.62,
        extinction: 0.110,
        albedo: 0.50,
        windSpeedMult: 1.25,
        precipitation: 1.0,
        darkness: 0.66,
        cauliflower: 0.92,
        description: 'Tall storm cells with dark bases'
    },

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
        precipitation: 0.0,
        darkness: 0.0,
        cauliflower: 0.18,
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
        precipitation: 0.0,
        darkness: 0.0,
        cauliflower: 0.25,
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
        precipitation: 0.0,
        darkness: 0.04,
        cauliflower: 0.12,
        description: 'Thin veil, creates halos'
    },

};

/**
 * Weather to cloud type mapping
 * Returns array of cloud types with their coverage for given weather
 */
export function getCloudTypesForWeather(weather, intensity = 0.5) {
    const i = Math.max(0, Math.min(1, intensity));

    switch (weather) {
        case 'clear':
            return [{ type: CloudTypes.CIRRUS, coverage: 0.05 + i * 0.1 }];
        case 'partly_cloudy':
            return [
                { type: CloudTypes.CUMULUS, coverage: 0.16 + i * 0.24 },
                { type: CloudTypes.CIRRUS, coverage: 0.10 + i * 0.15 },
            ];
        case 'cloudy':
            return [
                { type: CloudTypes.CUMULUS, coverage: 0.28 + i * 0.26 },
                { type: CloudTypes.STRATUS, coverage: 0.18 + i * 0.28 },
                { type: CloudTypes.CIRRUS, coverage: 0.20 + i * 0.20 },
            ];
        case 'overcast':
            return [
                { type: CloudTypes.STRATUS, coverage: 0.55 + i * 0.32 },
                { type: CloudTypes.CIRROSTRATUS, coverage: 0.28 + i * 0.18 },
            ];
        case 'rain':
            return [
                { type: CloudTypes.NIMBOSTRATUS, coverage: 0.58 + i * 0.34 },
                { type: CloudTypes.STRATUS, coverage: 0.32 + i * 0.30 },
                { type: CloudTypes.CIRROSTRATUS, coverage: 0.20 + i * 0.15 },
            ];
        case 'storm':
            return [
                { type: CloudTypes.CUMULONIMBUS, coverage: 0.44 + i * 0.46 },
                { type: CloudTypes.NIMBOSTRATUS, coverage: 0.48 + i * 0.32 },
                { type: CloudTypes.CIRROSTRATUS, coverage: 0.16 + i * 0.16 },
            ];
        case 'foggy':
            return [
                { type: CloudTypes.STRATUS, coverage: 0.28 + i * 0.34 },
                { type: CloudTypes.CIRRUS, coverage: 0.10 + i * 0.10 },
            ];
        case 'snow':
            return [
                { type: CloudTypes.NIMBOSTRATUS, coverage: 0.42 + i * 0.28 },
                { type: CloudTypes.CIRRUS, coverage: 0.18 + i * 0.15 },
            ];
        default:
            return [{ type: CloudTypes.CIRRUS, coverage: 0.25 }];
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
            precipitation: 0,
            darkness: 0,
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
            blended.precipitation += (type.precipitation ?? 0) * w;
            blended.darkness += (type.darkness ?? 0) * w;
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
            blended.precipitation /= totalWeight;
            blended.darkness /= totalWeight;
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

        if (name === 'low' || name === 'mid') {
            blended.coverage = Math.min(blended.coverage, 0.96);
            blended.densityMultiplier *= 1.1 + blended.precipitation * 0.35;
            blended.extinction *= 1.0 + blended.precipitation * 0.8;
            blended.albedo = Math.max(0.28, blended.albedo - blended.darkness * 0.22);
            blended.edgeSoftness = Math.min(0.98, blended.edgeSoftness + blended.precipitation * 0.05);
        }

        result.push(blended);
    }

    return result;
}
