export interface TextureOptions {
    width?: number; height?: number; depth?: number;
    format?: string; minFilter?: string; magFilter?: string;
    wrapS?: string; wrapT?: string; generateMipmaps?: boolean;
    data?: ArrayBufferView | null; image?: ImageBitmap | HTMLImageElement | HTMLCanvasElement | null;
    _isArray?: boolean;
}
export class Texture {
    constructor(options?: TextureOptions);
    readonly id: number;
    width: number; height: number; depth: number;
    format: string; minFilter: string; magFilter: string;
    wrapS: string; wrapT: string; generateMipmaps: boolean;
    data: ArrayBufferView | null;
    image: TextureOptions['image'];
    _isArray: boolean;
    _gpuTexture: { texture: GPUTexture; view: GPUTextureView } | null;
    _gpuFormat?: GPUTextureFormat;
    _isFilterable?: boolean;
    setData(data: ArrayBufferView, width: number, height: number): void;
    setImage(image: NonNullable<TextureOptions['image']>): void;
    dispose(): void;
}
export const TextureFormat: Readonly<Record<'RGBA8' | 'R8UNORM' | 'RGBA16F' | 'RGBA32F' | 'R8' | 'R16F' | 'R32F' | 'DEPTH24' | 'DEPTH32F' | 'RGBA32UINT', string>>;
export const TextureFilter: Readonly<Record<'NEAREST' | 'LINEAR' | 'NEAREST_MIPMAP_NEAREST' | 'LINEAR_MIPMAP_LINEAR' | 'NEAREST_MIPMAP_LINEAR' | 'LINEAR_MIPMAP_NEAREST', string>>;
export const TextureWrap: Readonly<Record<'REPEAT' | 'CLAMP' | 'MIRROR', string>>;
export function gpuFormatBytesPerTexel(format: GPUTextureFormat): number;
export function gpuFormatIsFilterable(format: GPUTextureFormat): boolean;
export function gpuFormatSampleType(format: GPUTextureFormat): GPUTextureSampleType;
export function gpuFormatToWrapperFormat(format: GPUTextureFormat): string;
