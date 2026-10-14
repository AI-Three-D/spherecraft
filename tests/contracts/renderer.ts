import { Renderer, type RenderCamera, type RenderModule, type RendererBackend } from 't0/renderer';
import { TerrainModule, QuadtreeTerrainRenderer,
    type TerrainSource, type TerrainDraw, type TerrainWaterLayer, type TerrainWaterData,
    type QuadtreeTerrainRendererOptions } from 't0/terrain';

declare const backend: RendererBackend;
declare const camera: RenderCamera;
declare const terrainSource: TerrainSource;
declare const terrainDraw: TerrainDraw;
declare const quadtreeOptions: QuadtreeTerrainRendererOptions;

const renderer = new Renderer({ backend, width: 64, height: 64 });
const module: RenderModule = {
    id: 'mesh',
    compute(frame, encoder) {
        const gpu: GPUDevice = frame.device;
        const command: GPUCommandEncoder = encoder;
        void gpu; void command;
        // @ts-expect-error FrameContext intentionally excludes game/terrain dependencies.
        frame.terrainGenerator;
    },
};
void renderer.addModule(module);
renderer.renderFrame({ camera, deltaTime: 0.016, time: 5 });

// @ts-expect-error Renderer does not accept terrain or game configuration.
new Renderer({ engineConfig: {} });
// @ts-expect-error Frame time is a number in seconds.
renderer.renderFrame({ camera, deltaTime: '16ms' });
// @ts-expect-error A camera requires view and projection matrices.
renderer.renderFrame({ camera: { position: { x: 0, y: 1, z: 2 } }, deltaTime: 0 });
// @ts-expect-error Modules require a stable id.
renderer.addModule({ render() {} });
// @ts-expect-error No concrete planetary world leaks through the source contract.
terrainSource.quadtreeGPU;

const water: TerrainWaterLayer = { render(frame) { void frame.camera; } };
const terrain: RenderModule = new TerrainModule({ source: terrainSource, renderer: terrainDraw, waterLayers: [water] });
void renderer.addModule(terrain);
const draw: TerrainDraw = new QuadtreeTerrainRenderer(quadtreeOptions);
draw.setWaterData?.(null);
// @ts-expect-error Strong water resource types reject invalid buffer values.
const invalidWater: TerrainWaterData = { resources: { index: 5, lakes: 5, rivers: 5, masks: 5, params: 5 } };
void invalidWater;
// @ts-expect-error Terrain module requires its source and draw implementation.
new TerrainModule({ source: terrainSource });
// @ts-expect-error Sources must supply the complete buffer/texture consumer contract.
new TerrainModule({ source: { isReady: () => true }, renderer: terrainDraw });
// @ts-expect-error A production draw requires terrain material defaults and configuration.
new QuadtreeTerrainRenderer({ backend, tileManager: terrainSource });
// @ts-expect-error Terrain render configuration is strongly typed.
new QuadtreeTerrainRenderer({ ...quadtreeOptions, engineConfig: { chunkSegments: 'sixteen', chunkSizeMeters: 16 } });

void renderer.addModule(new TerrainModule({ source: terrainSource, renderer: terrainDraw, ownsSource: true, initializeSource: true }));
