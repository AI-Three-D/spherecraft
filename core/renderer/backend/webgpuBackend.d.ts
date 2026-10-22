import type { RendererBackend } from '../contracts.js';
import type { Geometry } from '../resources/geometry.js';
import type { Material } from '../resources/material.js';
import type { RenderTarget } from '../resources/renderTarget.js';
/** Public WebGPU boundary. Implementation remains JavaScript. */
export class WebGPUBackend implements RendererBackend {
    constructor(canvas: HTMLCanvasElement);
    readonly device: GPUDevice | null;
    readonly deviceLoss: GPUDeviceLostInfo | null;
    readonly format: GPUTextureFormat | null;
    sceneFormat: GPUTextureFormat | null;
    initialize(): Promise<void>;
    setViewport(x: number, y: number, width: number, height: number): void;
    setRenderTarget(target: RenderTarget | null): void;
    setClearColor(r: number, g: number, b: number, a: number): void;
    clear(color: boolean, depth: boolean, stencil: boolean): void;
    getCommandEncoder(): GPUCommandEncoder;
    getRenderPassEncoder(): GPURenderPassEncoder | null;
    endRenderPassForCompute(): void;
    resumeRenderPass(options?: { depthReadOnly?: boolean }): void;
    getDepthTextureView(): GPUTextureView | null;
    submitCommands(): void;
    discardCommands(): void;
    draw(geometry: Geometry, material: Material): void;
    drawIndexedIndirect(geometry: Geometry, material: Material, buffer: GPUBuffer, offset: number): void;
    destroyMaterial(material: Material): void;
    compileShader(material: Material): unknown;
    getAPIName(): 'webgpu';
    dispose(): void;
}
