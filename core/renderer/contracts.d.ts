/// <reference types="@webgpu/types" />
import type { Geometry } from './resources/geometry.js';
import type { Material } from './resources/material.js';
import type { RenderTarget } from './resources/renderTarget.js';

export interface Vector3Like { readonly x: number; readonly y: number; readonly z: number }
export interface Matrix4Like { readonly elements: ArrayLike<number> }

/** The application supplies matrices, already using WebGPU's [0, 1] depth range. */
export interface RenderCamera {
    readonly position: Vector3Like;
    readonly matrixWorldInverse: Matrix4Like;
    readonly projectionMatrix: Matrix4Like;
}

export interface Viewport { readonly width: number; readonly height: number }

/** Frame and resource operations only. No planet, terrain, weather or game state. */
export interface RendererBackend {
    readonly device: GPUDevice | null;
    readonly deviceLoss?: GPUDeviceLostInfo | null;
    initialize(): Promise<void>;
    setViewport(x: number, y: number, width: number, height: number): void;
    setRenderTarget(target: RenderTarget | null): void;
    setClearColor(r: number, g: number, b: number, a: number): void;
    clear(color: boolean, depth: boolean, stencil: boolean): void;
    getCommandEncoder(): GPUCommandEncoder;
    getRenderPassEncoder(): GPURenderPassEncoder | null;
    endRenderPassForCompute(): void;
    resumeRenderPass(): void;
    submitCommands(): void;
    discardCommands(): void;
    draw(geometry: Geometry, material: Material): void;
    drawIndexedIndirect(geometry: Geometry, material: Material, buffer: GPUBuffer, offset: number): void;
    /** Release material-owned uniform buffers and cached bindings; shared textures/buffers are borrowed. */
    destroyMaterial(material: Material): void;
    dispose(): void;
}

export interface RenderContext {
    readonly backend: RendererBackend;
    readonly device: GPUDevice;
    readonly viewport: Viewport;
}

export interface FrameInput {
    readonly camera: RenderCamera;
    /** Seconds, finite and nonnegative. */
    readonly deltaTime: number;
    /** Seconds; defaults to accumulated deltaTime. Supply this for deterministic fixtures. */
    readonly time?: number;
}

export interface RenderFrame extends RenderContext {
    readonly camera: RenderCamera;
    readonly deltaTime: number;
    readonly time: number;
    readonly index: number;
}

/**
 * Installed modules run in registration order, across the same frame phases.
 * Initialization may await loading; frame callbacks must be synchronous.
 * Compute records into the supplied encoder. Only the renderer submits it.
 * Draw opaque geometry in render and blended surfaces in renderTransparent.
 * Dispose releases module-owned resources; injected/shared resources stay with their owner.
 */
export interface RenderModule {
    readonly id: string;
    initialize?(context: RenderContext): void | Promise<void>;
    update?(frame: RenderFrame): void;
    compute?(frame: RenderFrame, encoder: GPUCommandEncoder): void;
    render?(frame: RenderFrame): void;
    renderTransparent?(frame: RenderFrame): void;
    afterSubmit?(frame: RenderFrame): void;
    resize?(viewport: Viewport): void;
    dispose?(): void;
}

export interface RendererOptions {
    readonly canvas?: HTMLCanvasElement;
    /** Inject a recording backend or an already initialized backend to build isolated tests. */
    readonly backend?: RendererBackend;
    readonly backendInitialized?: boolean;
    /** Defaults to true for a renderer-created backend and false for an injected backend. */
    readonly ownsBackend?: boolean;
    readonly width?: number;
    readonly height?: number;
    readonly clearColor?: readonly [number, number, number, number];
}
