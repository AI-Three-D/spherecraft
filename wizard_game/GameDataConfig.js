// js/config/GameDataConfig.js
import { requireBool, requireInt, requireNumber, requireObject, requireString, requireArray } from '../shared/requireUtil.js';
/**
 * Game data configuration settings.
 * Contains star system + planet/gameplay definitions (planet-specific).
 *
 * Key rule:
 * - chunksPerFace is planet-specific and comes from here.
 * - surfaceChunkSize (meters per chunk) comes from EngineConfig (passed in by GameEngine).
 * - radius is never set explicitly; PlanetConfig derives it.
 */
export class GameDataConfig {
  constructor(options = {}) {
    const starSystemOptions = requireObject(options.starSystem, 'starSystem');
    const planetOptions = requireArray(starSystemOptions.planets, 'starSystem.planets', 1);

    // -------------------- Star system --------------------
    this.starSystem = {
      name: requireString(starSystemOptions.name, 'starSystem.name'),
      timeScale: requireNumber(starSystemOptions.timeScale, 'starSystem.timeScale'),
      autoTimeScale: requireBool(starSystemOptions.autoTimeScale, 'starSystem.autoTimeScale'),
      useGameTimeRotation: requireBool(starSystemOptions.useGameTimeRotation, 'starSystem.useGameTimeRotation'),
      sunIntensity: requireNumber(starSystemOptions.sunIntensity, 'starSystem.sunIntensity'),
      planets: planetOptions.map((planet, index) => new PlanetDataConfig(planet, index))
    };

    // -------------------- Time --------------------
    const time = requireObject(options.time, 'time');
    this.time = {
      dayDurationMs: requireNumber(time.dayDurationMs, 'time.dayDurationMs'),
      startDay: requireInt(time.startDay, 'time.startDay', 0),
      startHour: requireNumber(time.startHour, 'time.startHour')
    };

    // -------------------- Spawn --------------------
    const spawn = requireObject(options.spawn, 'spawn');
    this.spawn = {
      defaultX: requireNumber(spawn.defaultX, 'spawn.defaultX'),
      defaultY: requireNumber(spawn.defaultY, 'spawn.defaultY'),
      defaultZ: requireNumber(spawn.defaultZ, 'spawn.defaultZ'),
      height: requireNumber(spawn.height, 'spawn.height'),
      spawnOnSunSide: requireBool(spawn.spawnOnSunSide, 'spawn.spawnOnSunSide')
    };
  }

  get planets() {
    return this.starSystem.planets;
  }

  getPlanet(idOrIndex) {
    if (idOrIndex === null || idOrIndex === undefined) {
      throw new Error('GameDataConfig.getPlanet requires a planet id or index');
    }
    if (typeof idOrIndex === 'number') {
      return this.starSystem.planets[idOrIndex] ?? null;
    }
    if (typeof idOrIndex === 'string') {
      return this.starSystem.planets.find((planet) => planet.id === idOrIndex) ?? null;
    }
    throw new Error('GameDataConfig.getPlanet requires a planet id or index');
  }

  /**
   * Build planet options for PlanetConfig.
   *
   * Required args:
   *   surfaceChunkSize
   */
  buildPlanetOptions(args = {}, planetId) {
    const planet = this.getPlanet(planetId);
    if (!planet) {
      throw new Error('GameDataConfig.buildPlanetOptions requires a valid planet');
    }

    const surfaceChunkSize = requireNumber(args.surfaceChunkSize, 'surfaceChunkSize');
    // Derived radius used ONLY for dependent values (PlanetConfig remains authoritative)
    const derivedRadius = surfaceChunkSize * planet.chunksPerFace * 0.5;
    const atmosphereThickness = derivedRadius * planet.atmosphereHeightRatio;

    return {
      name: planet.name,

      // planet sizing inputs
      surfaceChunkSize,
      chunksPerFace: planet.chunksPerFace,

      // optional planet knobs
      hasAtmosphere: planet.hasAtmosphere,
      maxTerrainHeight: planet.maxTerrainHeight,
      seed: planet.seed,

      // Atmosphere configuration - uses the new scaling system
      // atmosphereThickness is in meters, densityFalloff values are fractions of thickness
      atmosphereHeight: atmosphereThickness,
      atmosphereOptions: {
        atmosphereThickness: atmosphereThickness,
        densityFalloffRayleigh: planet.atmosphereOptions.scaleHeightRayleighRatio,
        densityFalloffMie: planet.atmosphereOptions.scaleHeightMieRatio,
        mieAnisotropy: planet.atmosphereOptions.mieAnisotropy,
        visualDensity: planet.atmosphereOptions.visualDensity ?? 1.0,
        sunIntensity: planet.atmosphereOptions.sunIntensity ?? 20.0
      },

      // altitude zones
      surfaceAltitude: planet.altitudeZones.surface,
      lowAltitude: planet.altitudeZones.low,
      transitionAltitude: planet.altitudeZones.transition,
      orbitalAltitude: planet.altitudeZones.orbital,

      // origin
      origin: { ...planet.origin },

      // per-planet texture/atlas configuration
      tileConfig: planet.tileConfig,
      atlasConfig: planet.atlasConfig,
      grassConfig: planet.grassConfig,
      macroTileSpan: planet.macroTileSpan,
      macroMaxLOD: planet.macroMaxLOD,
      tileCatalog: planet.tileCatalog,
      worldAuthoring: planet.worldAuthoring,
      biomeDefinitions: planet.biomeDefinitions,
      assetProfiles: planet.assetProfiles,
      atmoBankAuthoring: planet.atmoBankAuthoring,

      // terrain generation config
      terrainGeneration: planet.terrain,

      // cloud configuration (atmosphere-relative)
      cloudOptions: planet.cloudOptions
    };
  }

  /**
   * Options forwarded into StarSystem.createTestSystem(planetConfig, options)
   * Keep it simple and extensible.
   */
  buildStarSystemOptions(planetConfig) {
    if (!planetConfig || !Number.isFinite(planetConfig.radius)) {
      throw new Error('GameDataConfig.buildStarSystemOptions requires a valid planetConfig');
    }
    return {
      name: this.starSystem.name,
      timeScale: this.starSystem.timeScale,
      autoTimeScale: this.starSystem.autoTimeScale,
      useGameTimeRotation: this.starSystem.useGameTimeRotation,
      sunIntensity: this.starSystem.sunIntensity,
      planetRadius: planetConfig.radius
    };
  }
}

class PlanetDataConfig {
  constructor(options = {}, index = 0) {
    const prefix = `starSystem.planets[${index}]`;
    this.id = requireString(options.id, `${prefix}.id`);
    this.enabled = requireBool(options.enabled, `${prefix}.enabled`);
    this.name = requireString(options.name, `${prefix}.name`);

    // Planet-specific sizing knob:
    // number of chunks across a cube face edge (power of two recommended)
    this.chunksPerFace = requireInt(options.chunksPerFace, `${prefix}.chunksPerFace`, 1);

    // Origin in system coordinates
    const origin = requireObject(options.origin, `${prefix}.origin`);
    this.origin = {
      x: requireNumber(origin.x, `${prefix}.origin.x`),
      y: requireNumber(origin.y, `${prefix}.origin.y`),
      z: requireNumber(origin.z, `${prefix}.origin.z`)
    };

    // Atmosphere ratios etc
    this.hasAtmosphere = requireBool(options.hasAtmosphere, `${prefix}.hasAtmosphere`);
    this.atmosphereHeightRatio = requireNumber(options.atmosphereHeightRatio, `${prefix}.atmosphereHeightRatio`);

    const atmosphereOptions = requireObject(options.atmosphereOptions, `${prefix}.atmosphereOptions`);
    this.atmosphereOptions = {
      scaleHeightRayleighRatio: requireNumber(
        atmosphereOptions.scaleHeightRayleighRatio,
        `${prefix}.atmosphereOptions.scaleHeightRayleighRatio`
      ),
      scaleHeightMieRatio: requireNumber(
        atmosphereOptions.scaleHeightMieRatio,
        `${prefix}.atmosphereOptions.scaleHeightMieRatio`
      ),
      mieAnisotropy: requireNumber(
        atmosphereOptions.mieAnisotropy,
        `${prefix}.atmosphereOptions.mieAnisotropy`
      ),
      // Optional parameters with defaults
      visualDensity: atmosphereOptions.visualDensity ?? 1.0,
      sunIntensity: atmosphereOptions.sunIntensity ?? 20.0
    };

    const altitudeZones = requireObject(options.altitudeZones, `${prefix}.altitudeZones`);
    this.altitudeZones = {
      surface: requireNumber(altitudeZones.surface, `${prefix}.altitudeZones.surface`),
      low: requireNumber(altitudeZones.low, `${prefix}.altitudeZones.low`),
      transition: requireNumber(altitudeZones.transition, `${prefix}.altitudeZones.transition`),
      orbital: requireNumber(altitudeZones.orbital, `${prefix}.altitudeZones.orbital`)
    };

    // Optional planet tuning
    this.maxTerrainHeight = requireNumber(options.maxTerrainHeight, `${prefix}.maxTerrainHeight`);
    this.seed = requireInt(options.seed, `${prefix}.seed`, 0);

    // Per-planet config bundles
    this.terrain = requireObject(options.terrain, `${prefix}.terrain`);
    this.tileConfig = requireObject(options.tileConfig, `${prefix}.tileConfig`);
    this.atlasConfig = requireObject(options.atlasConfig, `${prefix}.atlasConfig`);
    this.grassConfig = requireObject(options.grassConfig, `${prefix}.grassConfig`);
    this.macroTileSpan = options.macroTileSpan ?? 4;
    this.macroMaxLOD = options.macroMaxLOD ?? 0;
    this.tileCatalog = options.tileCatalog ?? options.worldAuthoring?.tileCatalog ?? null;
    this.atmoBankAuthoring = options.atmoBankAuthoring ?? null;

    // Cloud options (optional with defaults) - altitudes as fractions of atmosphereHeight
    const cloudOpts = options.cloudOptions || {};
    this.cloudOptions = {
      // Cloud layer altitudes as fractions of atmosphere height
      cumulusLayerStart: cloudOpts.cumulusLayerStart ?? 0.02,   // 2% - low clouds start
      cumulusLayerEnd: cloudOpts.cumulusLayerEnd ?? 0.15,       // 15% - low clouds end
      cirrusLayerStart: cloudOpts.cirrusLayerStart ?? 0.5,      // 50% - high clouds start
      cirrusLayerEnd: cloudOpts.cirrusLayerEnd ?? 0.85,         // 85% - high clouds end

      // Climate zones (latitude-based, optional)
      climateZones: cloudOpts.climateZones ?? {
        polar: { latitudeStart: 0.8, cloudCoverage: 0.4, precipitationRate: 0.2 },
        temperate: { latitudeStart: 0.4, cloudCoverage: 0.5, precipitationRate: 0.5 },
        tropical: { latitudeStart: 0.0, cloudCoverage: 0.6, precipitationRate: 0.8 }
      },

      // Precipitation cycle settings
      precipitation: cloudOpts.precipitation ?? {
        cycleLength: 86400,         // seconds for full weather cycle (1 day default)
        stormProbability: 0.15,     // chance of storms per cycle
        clearProbability: 0.3,      // chance of clear weather
        windInfluence: 0.5          // how much wind affects cloud movement (0-1)
      }
    };
  }
}
