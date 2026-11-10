export type GeometryArray = Float32Array | Uint16Array | Uint32Array | Int32Array;
export interface GeometryAttribute {
    data: GeometryArray | null;
    itemSize: number;
    normalized: boolean;
    count: number;
    stepMode: GPUVertexStepMode;
    slot?: number;
    gpuBuffer?: GPUBuffer;
    gpuBufferOffset?: number;
}
export class Geometry {
    readonly id: number;
    readonly attributes: Map<string, GeometryAttribute>;
    index: { data: Uint16Array | Uint32Array; count: number } | null;
    instanceCount: number;
    drawRange: { start: number; count: number };
    userData: Record<string, unknown>;
    setAttribute(name: string, data: GeometryArray | null, itemSize: number, normalized?: boolean, options?: { count?: number; stepMode?: GPUVertexStepMode; slot?: number; gpuBuffer?: GPUBuffer; gpuBufferOffset?: number }): this;
    getAttribute(name: string): GeometryAttribute | undefined;
    setIndex(data: Uint16Array | Uint32Array): this;
    getIndex(): Geometry['index'];
    setDrawRange(start: number, count: number): void;
    computeBoundingSphere(): void;
    dispose(): void;
}
