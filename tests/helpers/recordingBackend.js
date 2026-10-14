import { vi } from 'vitest';

/** No browser or world: records exactly which frame operations would reach the GPU. */
export function recordingBackend(events = []) {
    const encoder = {};
    const backend = {
        device: { queue: { writeBuffer: vi.fn() } },
        initialize: vi.fn(async () => events.push('initialize')),
        setViewport: vi.fn((x, y, width, height) => events.push(`viewport:${width}x${height}`)),
        setRenderTarget: vi.fn(() => events.push('target')),
        setClearColor: vi.fn(),
        clear: vi.fn(() => events.push('clear')),
        getCommandEncoder: vi.fn(() => encoder),
        getRenderPassEncoder: vi.fn(() => ({})),
        endRenderPassForCompute: vi.fn(() => events.push('endPass')),
        resumeRenderPass: vi.fn(() => events.push('resume')),
        submitCommands: vi.fn(() => events.push('submit')),
        discardCommands: vi.fn(() => events.push('discard')),
        draw: vi.fn(),
        drawIndexedIndirect: vi.fn(),
        destroyMaterial: vi.fn(material => material.dispose()),
        dispose: vi.fn(() => events.push('backend.dispose')),
    };
    return { backend, encoder, events };
}

export const camera = {
    position: { x: 0, y: 5, z: 10 },
    matrixWorldInverse: { elements: new Float32Array(16) },
    projectionMatrix: { elements: new Float32Array(16) },
};
