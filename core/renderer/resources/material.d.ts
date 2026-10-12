import type { Geometry } from './geometry.js';
import type { RendererBackend } from '../contracts.js';

/** Material-specific bindings are supplied by their rendering module. */
export interface MaterialBindingAdapter {
    readonly cacheKey: string;
    getCacheKey?(material: Material): string;
    createLayouts(backend: RendererBackend, material: Material): GPUBindGroupLayout[];
    createBindGroups(backend: RendererBackend, material: Material, uniforms: Material['uniforms'], geometry: Geometry | null): GPUBindGroup[];
}
export interface MaterialBindingGroup {
    label?: string;
    entries: Array<{
        binding: number; name?: string; visibility?: GPUShaderStageFlags | string;
        buffer?: GPUBufferBindingLayout; sampler?: GPUSamplerBindingLayout; texture?: GPUTextureBindingLayout;
    }>;
}
export interface MaterialOptions {
    name?: string; vertexShader?: string; fragmentShader?: string;
    uniforms?: Record<string, { value: unknown }>;
    defines?: Record<string, boolean | number | string>;
    storageBuffers?: Record<string, GPUBuffer>;
    vertexLayout?: GPUVertexBufferLayout[] | null;
    side?: 'front' | 'back' | 'double'; transparent?: boolean;
    depthTest?: boolean; depthWrite?: boolean; depthCompare?: GPUCompareFunction;
    blending?: 'normal' | 'additive' | 'premultiplied';
    targetFormat?: GPUTextureFormat | null;
    bindGroupLayoutSpec?: MaterialBindingGroup[] | null;
    bindingAdapter?: MaterialBindingAdapter | null;
}
export class Material {
    constructor(options?: MaterialOptions);
    readonly id: number;
    name: string; vertexShader: string; fragmentShader: string;
    uniforms: Record<string, { value: unknown }>;
    defines: Record<string, boolean | number | string>;
    storageBuffers: Record<string, GPUBuffer>;
    vertexLayout: GPUVertexBufferLayout[] | null;
    bindGroupLayoutSpec: MaterialBindingGroup[] | null;
    bindingAdapter: MaterialBindingAdapter | null;
    setUniform(name: string, value: unknown): void;
    getUniform(name: string): unknown;
    clone(): Material;
    dispose(): void;
}
