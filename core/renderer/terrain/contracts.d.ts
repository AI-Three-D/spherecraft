import type { RenderCamera, RenderContext, RenderFrame } from '../contracts.js';
import type { Texture } from '../resources/texture.js';

/** Texture slots used by the production terrain shaders. Fixtures can provide just their needed slots. */
export interface TerrainTextures {
    height?: Texture;
    normal?: Texture;
    tile?: Texture;
    splatData?: Texture;
    splatIndex?: Texture;
    splatValid?: Texture;
    macro?: Texture;
    resolvedColor?: Texture;
    coarseColor?: Texture;
    terrainAO?: Texture;
    groundField?: Texture;
}

/** World owns selection, generation and residency. Rendering reads these resources. */
export interface TerrainSource {
    readonly maxGeomLOD: number;
    initialize?(): void | Promise<void>;
    isReady(): boolean;
    update?(camera: RenderCamera, encoder: GPUCommandEncoder): void;
    getInstanceBuffer(): GPUBuffer;
    getIndirectArgsBuffer(): GPUBuffer;
    getIndirectArgsOffsetBytes(lod: number): number;
    getArrayTextures(): TerrainTextures;
    updateLodIndexCounts(counts: readonly number[]): void;
    getTierFadeParameters?(): { lodFactor: number; faceSize: number; maxDepth: number; lodErrorThreshold: number } | null;
    resolveFeedbackReadback?(): void;
    dispose?(): void;
}

/** A terrain draw implementation may use the existing quadtree shaders or a fixture-specific material. */
export interface TerrainDraw {
    initialize(): void | Promise<void>;
    render(camera: RenderCamera, view: RenderCamera['matrixWorldInverse'], projection: RenderCamera['projectionMatrix']): void;
    setWaterData?(data: TerrainWaterData | null): void;
    dispose(): void;
}

export interface TerrainWaterResources {
    readonly index: GPUBuffer;
    readonly lakes: GPUBuffer;
    readonly rivers: GPUBuffer;
    readonly params: GPUBuffer;
    readonly masks: GPUTextureView;
}

/** Shared GPU water inputs are borrowed, never destroyed by the terrain module. */
export interface TerrainWaterData { readonly resources: TerrainWaterResources }

/** Adapt a river, lake, ocean or simulation surface without requiring a planetary world. */
export interface TerrainWaterLayer {
    initialize?(context: RenderContext): void | Promise<void>;
    update?(frame: RenderFrame): void;
    compute?(frame: RenderFrame, encoder: GPUCommandEncoder): void;
    render(frame: RenderFrame): void;
    setWaterData?(data: TerrainWaterData | null): void;
    dispose?(): void;
}

export interface TerrainModuleOptions {
    readonly id?: string;
    readonly source: TerrainSource;
    readonly renderer: TerrainDraw;
    readonly waterLayers?: readonly TerrainWaterLayer[];
    /** Defaults to false: sources can be shared by multiple views. */
    readonly ownsSource?: boolean;
    /** Defaults to false: initialize fixture sources outside the module, or opt in for owned worlds. */
    readonly initializeSource?: boolean;
}

/** A finite cube-face tile's address; no whole-world state is needed. */
export interface TerrainTileAddress { readonly face: 0 | 1 | 2 | 3 | 4 | 5; readonly depth: number; readonly x: number; readonly y: number }
