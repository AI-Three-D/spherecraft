import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebGPUBackend } from './webgpuBackend.js';
import { Material } from '../resources/material.js';

afterEach(() => vi.unstubAllGlobals());

describe('explicit material bindings', () => {
    it('uses a module adapter instead of interpreting material names or shaders', () => {
        const backend = new WebGPUBackend({ width: 1, height: 1 });
        const layouts = [], groups = [];
        const adapter = { createLayouts: vi.fn(() => layouts), createBindGroups: vi.fn(() => groups) };
        const material = new Material({ name: 'SphereShadowDepth', bindingAdapter: adapter });
        expect(backend._createBindGroupLayouts(material)).toBe(layouts);
        expect(backend._createBindGroups(material, {}, null)).toBe(groups);
        expect(adapter.createLayouts).toHaveBeenCalledWith(backend, material);
        expect(adapter.createBindGroups).toHaveBeenCalledWith(backend, material, {}, null);
        expect(() => backend._createBindGroupLayouts(new Material({ name: 'Terrain' }))).toThrow('explicit bindings');
    });

    it('keeps fallback depth textures available to generic binding specifications', () => {
        vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 });
        const backend = new WebGPUBackend({ width: 1, height: 1 });
        const view = {}, sampler = {};
        backend.device = {
            createTexture: vi.fn(() => ({ createView: () => view })),
            createCommandEncoder: () => ({ beginRenderPass: () => ({ end() {} }), finish: () => ({}) }),
            createSampler: vi.fn(() => sampler), queue: { submit: vi.fn() },
        };
        expect(backend._getOrCreateDummyDepthTextureView()).toBe(view);
        expect(backend._getOrCreateDummyDepthTextureView()).toBe(view);
        expect(backend.device.createTexture).toHaveBeenCalledTimes(1);
        expect(backend._getOrCreateDefaultComparisonSampler()).toBe(sampler);
    });

    it('releases only a material’s owned uniforms, preserving shared GPU resources', () => {
        vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8 });
        const backend = new WebGPUBackend({ width: 1, height: 1 });
        backend.device = { createBuffer: () => ({ destroy: vi.fn() }), queue: { writeBuffer: vi.fn() } };
        const first = new Material(), second = new Material();
        const data = new Float32Array(4);
        const firstBuffer = backend._getOrCreateUniformBuffer('first', data, first);
        const secondBuffer = backend._getOrCreateUniformBuffer('second', data, second);
        const sharedBuffer = backend._getOrCreateUniformBuffer('shared', data);
        backend._bindGroupCache.set(first, {});
        backend.destroyMaterial(first);
        expect(backend._bindGroupCache.has(first)).toBe(false);
        expect([...backend._bufferCache.keys()]).toEqual(['second', 'shared']);
        backend.discardCommands();
        expect(firstBuffer.destroy).toHaveBeenCalledTimes(1);
        expect(secondBuffer.destroy).not.toHaveBeenCalled();
        expect(sharedBuffer.destroy).not.toHaveBeenCalled();
    });
});
