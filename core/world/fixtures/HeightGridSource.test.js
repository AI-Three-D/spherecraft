import { describe, it, expect, vi, afterEach } from 'vitest';
import { HeightGridSource } from './HeightGridSource.js';
import { HeightGridTerrainRenderer } from '../../renderer/terrain/HeightGridTerrainRenderer.js';
import { TerrainModule } from '../../renderer/terrain/TerrainModule.js';
import { Renderer } from '../../renderer/Renderer.js';
import { camera, recordingBackend } from '../../../tests/helpers/recordingBackend.js';

afterEach(() => vi.unstubAllGlobals());

function deviceFixture() {
    vi.stubGlobal('GPUBufferUsage', { VERTEX: 32, COPY_DST: 8, INDIRECT: 256 });
    const uploads = new Map();
    const device = {
        createBuffer: vi.fn(options => ({ ...options, destroy: vi.fn() })),
        queue: { writeBuffer: vi.fn((buffer, offset, data) => uploads.set(buffer, new data.constructor(data))) },
    };
    const grid = { width: 3, height: 2, spacing: 2, origin: { x: 10, y: 20, z: 30 }, heights: new Float32Array([0, 1, 2, 3, 4, 5]) };
    return { device, grid, uploads };
}

describe('finite terrain fixture', () => {
    it('uploads just one patch and renders through the real module and draw contracts', async () => {
        const { device, grid, uploads } = deviceFixture();
        const { backend } = recordingBackend();
        backend.device = device;
        const renderer = new Renderer({ backend });
        await renderer.initialize();
        const source = new HeightGridSource(device, grid);
        const draw = new HeightGridTerrainRenderer({ backend, source });
        await renderer.addModule(new TerrainModule({ source, renderer: draw, ownsSource: true, initializeSource: true }));
        const vertices = source.getInstanceBuffer(), args = source.getIndirectArgsBuffer();
        expect(Array.from(uploads.get(vertices))).toEqual([10, 20, 30, 12, 21, 30, 14, 22, 30, 10, 23, 32, 12, 24, 32, 14, 25, 32]);
        expect(Array.from(uploads.get(args))).toEqual([12, 1, 0, 0, 0]);
        expect(source.indices).toHaveLength(12);
        expect(Math.max(...source.indices)).toBe(5);
        expect(source.getArrayTextures()).toEqual({});
        renderer.renderFrame({ camera, deltaTime: 0 });
        expect(backend.drawIndexedIndirect).toHaveBeenCalledWith(draw.geometry, draw.material, args, 0);
        renderer.dispose();
        expect(vertices.destroy).toHaveBeenCalledTimes(1);
        expect(args.destroy).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed height grids before allocating GPU resources', () => {
        const { device, grid } = deviceFixture();
        for (const bad of [{ width: 1 }, { spacing: 0 }, { heights: new Float32Array(2) }, { heights: new Float32Array([0, 1, NaN, 3, 4, 5]) }]) {
            expect(() => new HeightGridSource(device, { ...grid, ...bad }).initialize()).toThrow();
        }
        expect(device.createBuffer).not.toHaveBeenCalled();
    });
});
