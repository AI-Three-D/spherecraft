import type { RenderCamera, RendererBackend, Vector3Like } from '../contracts.js';
import type { Geometry } from '../resources/geometry.js';
import type { Texture } from '../resources/texture.js';
import type { TerrainDraw, TerrainSource, TerrainWaterData } from './contracts.js';

export interface TerrainAOSettings {
    enabled?: boolean; maxLod?: number; sampleStrength?: number; directStrength?: number; ambientFloor?: number;
    resolution?: number; maxBakesPerFrame?: number; logDispatches?: boolean; aoFloor?: number;
}
export interface GroundFieldSettings {
    enabled?: boolean;
    terrainFallback?: { enabled?: boolean; tintStrength?: number; grassTint?: readonly number[]; fernTint?: readonly number[] };
}
/** Draw settings are independent of generator, residency, and game configuration. */
export interface TerrainShaderSettings {
    fullMaxLOD?: number; nearMaxLOD?: number; midMaxLOD?: number;
    shadowMaxLod?: number; shadowDistanceMaxMeters?: number;
    aerialMaxLod?: number; aerialFadeStartMeters?: number; aerialFadeEndMeters?: number;
    enableMacroLayer?: boolean; forceMacroOverlay?: boolean; macroStartLod?: number;
    macroBlend?: number; macroNoiseWeight?: number;
    resolvedColorEnabled?: boolean; resolvedColorStartLod?: number;
    solidColorTierEnabled?: boolean; solidColorStartLod?: number;
    solidColorTierDistanceFadeEnabled?: boolean; solidColorTierDistanceFadeHeightMarginMeters?: number;
    solidColorTierDistanceFadeEndSafety?: number; solidColorTierDistanceFadeBandFraction?: number;
    solidColorTierEdgeBlendEnabled?: boolean; solidColorTierEdgeBlendWidth?: number; solidColorTierEdgeBlendStrength?: number;
    solidColorAverageWindowMeters?: number;
    lodEdgeFadeEnabled?: boolean; lodEdgeFadeMaxLod?: number;
    lodEdgeAOFadeEnabled?: boolean; lodEdgeColorStrength?: number; lodEdgeShadowStrength?: number;
    lodEdgeNormalStrength?: number; lodEdgeAOStrength?: number;
    lodEdgeToSolidColorStrength?: number; lodEdgeToSolidColorFadeStartMeters?: number; lodEdgeToSolidColorFadeEndMeters?: number;
    nearToMidFadeStartChunks?: number; nearToMidFadeEndChunks?: number;
    nearDetailEnabled?: boolean; nearDetailMaxLod?: number; nearDetailScaleMeters?: number; nearDetailStrength?: number;
    nearDetailFadeStartMeters?: number; nearDetailFadeEndMeters?: number;
}
export interface TerrainRenderSettings {
    chunkSegments: number;
    chunkSizeMeters: number;
    lod?: { distancesMeters: readonly number[] };
    features?: { shadows?: boolean };
    rendering?: { terrainShader?: TerrainShaderSettings };
    debug?: { terrainVertexDebugMode?: number; terrainFragmentDebugMode?: number };
}
export interface TerrainAtmosphereSettings {
    planetRadius: number; atmosphereRadius: number; scaleHeightRayleigh: number; scaleHeightMie: number;
    rayleighScattering: Vector3Like & { clone(): Vector3Like };
    mieScattering: number; mieAnisotropy: number; sunIntensity: number;
}
export interface TerrainPlanetSettings {
    radius: number; origin: Vector3Like; heightScale: number; chunksPerFace: number;
    hasAtmosphere: boolean;
    atmosphereSettings: TerrainAtmosphereSettings;
    macroTileSpan?: number; macroMaxLOD?: number;
    terrainAO?: TerrainAOSettings;
    engineConfig?: { terrainAO?: TerrainAOSettings; groundFieldBake?: GroundFieldSettings; splatConfig?: { fixedMaterialFamiliesEnabled?: boolean } };
}
export interface TerrainTileCategory {
    id: number;
    name: string;
    ranges: number[][];
}
export interface TerrainTextureProvider {
    getAtlasTexture(level: 'micro' | 'macro'): Texture | null;
    getLookupTables(): {
        tileTypeLookup?: Texture; macroTileTypeLookup?: Texture; numVariantsTex?: Texture;
        blendModeTable?: Texture; tileLayerHeights?: Texture;
    };
    getCategoryAverageColorMap?(categories: TerrainTileCategory[]): Map<number, number[]> | null;
}
export interface TerrainUniformProvider {
    readonly currentEnvironmentState?: object;
    readonly uniforms: Readonly<Record<string, { value: unknown }>>;
}
export interface QuadtreeTerrainRendererOptions {
    backend: RendererBackend;
    tileManager: TerrainSource;
    engineConfig: TerrainRenderSettings;
    planetConfig: TerrainPlanetSettings;
    textureManager?: TerrainTextureProvider | null;
    uniformManager?: TerrainUniformProvider | null;
    terrainAODefaults: TerrainAOSettings;
    groundFieldDefaults: GroundFieldSettings;
    tileCategories: TerrainTileCategory[];
}
/** Reads TerrainSource buffers and textures; it neither generates terrain nor owns its source. */
export class QuadtreeTerrainRenderer implements TerrainDraw {
    constructor(options: QuadtreeTerrainRendererOptions);
    readonly geometries: Map<number, Geometry>;
    readonly maxGeomLOD: number;
    readonly lodIndexCounts: number[];
    initialize(): Promise<void>;
    render(camera: RenderCamera, view: RenderCamera['matrixWorldInverse'], projection: RenderCamera['projectionMatrix']): void;
    setWaterData(data: TerrainWaterData | null): void;
    setAtmosphereLUT(lut: { transmittanceLUT: Texture | null } | null): void;
    setShadowRenderer(renderer: object | null): void;
    setTerrainLayerViewMode(mode: 'micro' | 'macro' | 'all' | 0 | 1 | 2): void;
    setTerrainHoverOverlay(overlay: { face: number; microRect?: TerrainRect; macroRect?: TerrainRect } | null): void;
    rebuildMaterials(): Promise<void>;
    dispose(): void;
}
export interface TerrainRect { minX: number; minY: number; maxX: number; maxY: number }
