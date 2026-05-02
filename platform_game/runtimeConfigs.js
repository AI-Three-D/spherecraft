// platform_game/runtimeConfigs.js
//
// Configuration assembly for the platform jumper demo. Mirrors
// wizard_game/runtimeConfigs.js but tunes the planet for a cold,
// snowy, mountainous world suitable for a cloud-platform jumper.
//
// Turn 1 scope: reuse EngineConfig/GameDataConfig defaults from
// the wizard_game factory where possible, and override only the
// knobs that matter for the desired look & feel:
//   - very high maxTerrainHeight so peaks reach the snow line
//   - aggressive tectonics & volcanism for dramatic ridges
//   - lower ocean level so the player spawns on snowy uplands
//   - colder atmosphere tint via sun intensity / fog
//   - higher spawn so the first platforms can sit in the sky

import {
    createEngineConfig as createWizardEngineConfig,
    createGameDataConfig as createWizardGameDataConfig
} from '../wizard_game/runtimeConfigs.js';

// Override helpers — keep the structural defaults from wizard_game
// and only patch the fields that define the platform_game setting.
export function createEngineConfig() {
    const cfg = createWizardEngineConfig();

    // Cooler, brighter day, longer draw distance so the curvature
    // of the planet is readable from cloud-altitude platforms.
    if (cfg.rendering?.lighting?.fog) {
        const fog = cfg.rendering.lighting.fog;
        fog.densityMultiplier = 0.35;
        fog.dayDensityScale = 0.85;
        fog.sunTintStrength = 0.06;
    }
    // Attach game-specific knobs so they travel with EngineConfig.
    applyPlatformGameKnobsInline(cfg);

    if (cfg.rendering?.terrainShader) {
        // Softer aerial perspective so distant snow still reads as white.
        cfg.rendering.terrainShader.aerialFadeStartMeters = 600;
        cfg.rendering.terrainShader.aerialFadeEndMeters = 1600;
    }
    return cfg;
}

export function createGameDataConfig() {
    const cfg = createWizardGameDataConfig();

    const planet = cfg.starSystem?.planets?.[0];
    if (planet) {
        planet.name = 'Frostspire';
        // Taller mountains → more snow-capped peaks.
        planet.maxTerrainHeight = 8000;

        if (planet.terrain) {
            // Tectonics dominate, erosion moderate → rugged ridges.
            if (planet.terrain.tectonics) {
                planet.terrain.tectonics.mountainBuildingRate = 2.0;
                planet.terrain.tectonics.plateCount = 10;
            }
            if (planet.terrain.volcanism) {
                planet.terrain.volcanism.averageHeight = 2200;
                planet.terrain.volcanism.plateBoundaryActivity = 0.9;
            }
            if (planet.terrain.continents) {
                planet.terrain.continents.averageSize = 0.45;
            }
            if (planet.terrain.water) {
                // Lower oceans so the player lands on snowy uplands.
                planet.terrain.water.oceanLevel = -0.15;
            }
            if (planet.terrain.surface) {
                // Earlier rock reveal → jagged exposed peaks above snow.
                planet.terrain.surface.rockSlopeStart = 0.25;
                planet.terrain.surface.rockSlopeFull = 0.65;
            }
            // Cold planet: shift the whole world into the snow band.
            // baseTemperature is °C at sea-level equator; temperatureGradient
            // is °C per 1000 m of altitude. The surface shader uses these
            // (via climateCommon.wgsl) to pick snow tiles when tempC is low.
            if (planet.terrain.climate) {
                planet.terrain.climate.baseTemperature = -15;
                planet.terrain.climate.temperatureGradient = -8.0;
            }
        }

        // Slightly cooler, less saturated atmosphere.
        if (planet.atmosphereOptions) {
            planet.atmosphereOptions.visualDensity = 0.45;
            planet.atmosphereOptions.sunIntensity = 18.0;
        }
    }

    if (cfg.starSystem) {
        cfg.starSystem.sunIntensity = 18;
    }

    // Spawn high enough on the slopes that the sky-platform gameplay
    // reads immediately once clouds are added in Turn 2.
    cfg.spawn = {
        ...(cfg.spawn ?? {}),
        height: 2200,
        spawnOnSunSide: true,
        defaultX: 0,
        defaultY: 2200,
        defaultZ: 2200
    };

    // Early morning light — cool shadows, long contrasts.
    cfg.time = {
        ...(cfg.time ?? {}),
        dayDurationMs: 120 * 1000,
        startDay: 320,  // late-year date hints at winter biome
        startHour: 9
    };

    // No playerCharacterUrl: PlatformActorManager builds the player as
    // a procedural sphere and never loads a GLTF descriptor. If the base
    // GameEngine falls back to wizard's descriptor URL and passes it to
    // our overridden createPlayer(), the URL is just ignored.

    return cfg;
}

/**
 * Game-specific knobs consumed by platform_game modules (ball visuals,
 * cloud field density). Kept on EngineConfig under `.platformGame` so
 * it travels with the engine config used by the Studio world loader.
 */
function applyPlatformGameKnobsInline(engineConfig) {
    engineConfig.platformGame = {
        ball: {
            radius: 0.55,
            collisionRadius: 0.55,
            moveSpeed: 6.5,
            sprintMultiplier: 1.5,
            maxSlopeDeg: 55,
            color:    { r: 0.25, g: 0.60, b: 1.0 },
            emissive: { r: 0.05, g: 0.18, b: 0.45 },
            emissiveIntensity: 0.25,
        },
        cloudField: {
            targetCount:       36,
            cellSizeMeters:    50,
            streamRadiusCells: 5,
            // Altitudes are relative to the player's current altitude at
            // spawn time, so clouds always sit above the terrain. The
            // lowest tier starts just above head-height so the player can
            // reach it; higher tiers go up several hundred metres so the
            // game vertically uses the planet's curvature.
            minAltitude:       5,
            maxAltitude:       450,
            seed:              0xC10D,
        },
    };
    return engineConfig;
}
export const applyPlatformGameKnobs = applyPlatformGameKnobsInline;
