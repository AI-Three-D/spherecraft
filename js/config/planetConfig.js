// js/planet/planetConfig.js
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { PlanetAtmosphereSettings } from './planetAtmosphereSettings.js';
import { requireBool, requireInt, requireNumber, requireObject, requireString } from '../util/requireUtil.js';
/**
 * PlanetConfig
 * -----------
 * Planet-specific knobs + derived quantities.
 *
 * Authoritative knobs for world scale agreement:
 *   - engineConfig.vertexSpacingMeters   (engine-wide)
 *   - engineConfig.chunkSegments         (engine-wide)
 *   - this.chunksPerFace                 (planet-specific)
 *
 * From these we derive:
 *   faceEdgeMeters = chunkSizeMeters * chunksPerFace
 *   radiusMeters   = faceEdgeMeters * 0.5
 *
 * Rationale: cube face spans [-R, R] on each axis (edge length = 2R).
 * Use faceEdge = 2R => R = faceEdge / 2
 */
export class PlanetConfig {
  /**
   * @param {object} options
   * @param {import('./EngineConfig.js').EngineConfig} options.engineConfig
   * @param {number} options.chunksPerFace
   */
  constructor(options = {}) {
    this.name = requireString(options.name, 'name');

    this.engineConfig = requireObject(options.engineConfig, 'engineConfig');
    this.chunksPerFace = requireInt(options.chunksPerFace, 'chunksPerFace', 1);

    this.hasAtmosphere = requireBool(options.hasAtmosphere, 'hasAtmosphere');
    const atmosphereOptions = requireObject(options.atmosphereOptions, 'atmosphereOptions');
    // New atmosphere parameters: atmosphereThickness, densityFalloff ratios, visualDensity
    this.atmosphereOptions = {
      atmosphereThickness: requireNumber(atmosphereOptions.atmosphereThickness, 'atmosphereOptions.atmosphereThickness'),
      densityFalloffRayleigh: requireNumber(atmosphereOptions.densityFalloffRayleigh, 'atmosphereOptions.densityFalloffRayleigh'),
      densityFalloffMie: requireNumber(atmosphereOptions.densityFalloffMie, 'atmosphereOptions.densityFalloffMie'),
      mieAnisotropy: requireNumber(atmosphereOptions.mieAnisotropy, 'atmosphereOptions.mieAnisotropy'),
      visualDensity: atmosphereOptions.visualDensity ?? 1.0,
      sunIntensity: atmosphereOptions.sunIntensity ?? 20.0
    };
    this.maxTerrainHeight = requireNumber(options.maxTerrainHeight, 'maxTerrainHeight');
    this.seed = requireInt(options.seed, 'seed', 0);
    const nightSkyOpts = options.nightSky || {};
    this.nightSky = {
        starSeed: nightSkyOpts.starSeed ?? (this.seed + 1000),
        colorSeed: nightSkyOpts.colorSeed ?? (this.seed + 2000),
        galaxies: {
            count: nightSkyOpts.galaxies?.count ?? 1,
            seed: nightSkyOpts.galaxies?.seed ?? (this.seed + 3000),
            brightness: nightSkyOpts.galaxies?.brightness ?? 1.0,
            spread: nightSkyOpts.galaxies?.spread ?? 0.25
        },
       
    };
    this.atmosphereHeight = this.atmosphereOptions.atmosphereThickness;
    this.atmosphereSettings = PlanetAtmosphereSettings.createForPlanet(this.radius, this.atmosphereOptions);

    this.tileConfig = requireObject(options.tileConfig, 'tileConfig');
    this.atlasConfig = requireObject(options.atlasConfig, 'atlasConfig');
    this.grassConfig = requireObject(options.grassConfig, 'grassConfig');
    this.macroTileSpan = options.macroTileSpan ?? 4;
    this.macroMaxLOD = options.macroMaxLOD ?? 0;
    this.terrainGeneration = requireObject(options.terrainGeneration, 'terrainGeneration');

    // Cloud options (atmosphere-relative altitudes)
    const cloudOpts = options.cloudOptions || {};
    this.cloudOptions = {
      cumulusLayerStart: cloudOpts.cumulusLayerStart ?? 0.02,
      cumulusLayerEnd: cloudOpts.cumulusLayerEnd ?? 0.15,
      cirrusLayerStart: cloudOpts.cirrusLayerStart ?? 0.5,
      cirrusLayerEnd: cloudOpts.cirrusLayerEnd ?? 0.85,
      climateZones: cloudOpts.climateZones ?? {
        polar: { latitudeStart: 0.8, cloudCoverage: 0.4, precipitationRate: 0.2 },
        temperate: { latitudeStart: 0.4, cloudCoverage: 0.5, precipitationRate: 0.5 },
        tropical: { latitudeStart: 0.0, cloudCoverage: 0.6, precipitationRate: 0.8 }
      },
      precipitation: cloudOpts.precipitation ?? {
        cycleLength: 86400,
        stormProbability: 0.15,
        clearProbability: 0.3,
        windInfluence: 0.5
      }
    };

    this.surfaceAltitude = requireNumber(options.surfaceAltitude, 'surfaceAltitude');
    this.lowAltitude = requireNumber(options.lowAltitude, 'lowAltitude');
    this.transitionAltitude = requireNumber(options.transitionAltitude, 'transitionAltitude');
    this.orbitalAltitude = requireNumber(options.orbitalAltitude, 'orbitalAltitude');

    const origin = requireObject(options.origin, 'origin');
    this.origin = new THREE.Vector3(
      requireNumber(origin.x, 'origin.x'),
      requireNumber(origin.y, 'origin.y'),
      requireNumber(origin.z, 'origin.z')
    );
  }

  // ==================== DERIVED (single-source-of-truth) ====================

  get chunkSizeMeters() {
    return this.engineConfig.chunkSizeMeters;
  }

  get faceEdgeMeters() {
    return this.chunkSizeMeters * this.chunksPerFace;
  }

  /** planet radius in meters (derived; NOT user-set) */
  get radius() {
    return this.faceEdgeMeters * 0.5;
  }

  // Legacy convenience aliases for older code paths:
  get radiusMeters() {
    return this.radius;
  }

  get surfaceChunkSize() {
    return this.chunkSizeMeters;
  }

  get heightScale() {
    return this.maxTerrainHeight;
  }

  // ==================== CLOUD LAYER RADII (derived from atmosphere) ====================

  /** Cumulus (low cloud) inner radius in world units */
  get cumulusInnerRadius() {
    return this.radius + this.atmosphereHeight * this.cloudOptions.cumulusLayerStart;
  }

  /** Cumulus (low cloud) outer radius in world units */
  get cumulusOuterRadius() {
    return this.radius + this.atmosphereHeight * this.cloudOptions.cumulusLayerEnd;
  }

  /** Cirrus (high cloud) inner radius in world units */
  get cirrusInnerRadius() {
    return this.radius + this.atmosphereHeight * this.cloudOptions.cirrusLayerStart;
  }

  /** Cirrus (high cloud) outer radius in world units */
  get cirrusOuterRadius() {
    return this.radius + this.atmosphereHeight * this.cloudOptions.cirrusLayerEnd;
  }

  /** Atmosphere outer radius (planet radius + atmosphere height) */
  get atmosphereRadius() {
    return this.radius + this.atmosphereHeight;
  }

  setOrigin(x, y, z) {
    this.origin.set(x, y, z);
  }

  setChunksPerFace(chunksPerFace) {
    this.chunksPerFace = Math.max(1, Math.floor(chunksPerFace));
  }
}
