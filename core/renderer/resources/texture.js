// js/renderer/resources/texture.js
// CHANGES: Add RGBA32UINT to TextureFormat, update utility functions

export const TextureFormat = {
    RGBA8: 'rgba8',
    R8UNORM: 'r8unorm',
    RGBA16F: 'rgba16f',
    RGBA32F: 'rgba32f',
    R8: 'r8',
    R16F: 'r16f',
    R32F: 'r32f',
    DEPTH24: 'depth24',
    DEPTH32F: 'depth32f',
    RGBA32UINT: 'rgba32uint',       // NEW
};

export const TextureFilter = {
    NEAREST: 'nearest',
    LINEAR: 'linear',
    NEAREST_MIPMAP_NEAREST: 'nearest_mipmap_nearest',
    LINEAR_MIPMAP_LINEAR: 'linear_mipmap_linear',
    NEAREST_MIPMAP_LINEAR: 'nearest_mipmap_linear',
    LINEAR_MIPMAP_NEAREST: 'linear_mipmap_nearest'
};
export const TextureWrap = {
    REPEAT: 'repeat',
    CLAMP: 'clamp',
    MIRROR: 'mirror'
};

export class Texture {
    constructor(options = {}) {
        this.id = Texture._nextId++;

        this.width = options.width || 1;
        this.height = options.height || 1;
        this.depth = options.depth || 1;

        this.format = options.format || TextureFormat.RGBA8;
        this.minFilter = options.minFilter || TextureFilter.LINEAR;
        this.magFilter = options.magFilter || TextureFilter.LINEAR;
        this.wrapS = options.wrapS || TextureWrap.CLAMP;
        this.wrapT = options.wrapT || TextureWrap.CLAMP;

        this.generateMipmaps = options.generateMipmaps !== false;

        this.data = options.data || null;
        this.image = options.image || null;

        this._isArray = options._isArray || false;

        this._gpuTexture = null;
        this._needsUpload = true;
    }

    static _nextId = 0;

    setData(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
        this._needsUpload = true;
    }

    setImage(image) {
        this.image = image;
        this.width = image.width;
        this.height = image.height;
        this._needsUpload = true;
    }

    dispose() {
        this.data = null;
        this.image = null;
        this._gpuTexture = null;
    }
}

export function gpuFormatBytesPerTexel(format) {
    switch (format) {
        case 'r8unorm':      return 1;
        case 'rg8unorm':     return 2;
        case 'r16float':     return 2;
        case 'rg16float':    return 4;
        case 'r32float':     return 4;
        case 'rgba8unorm':   return 4;
        case 'bgra8unorm':   return 4;
        case 'rgba16float':  return 8;
        case 'rgba32float':  return 16;
        case 'rgba32uint':   return 16; 
        default:             return 16;
    }
}

export function gpuFormatIsFilterable(format) {
    switch (format) {
        case 'r8unorm':
        case 'rg8unorm':
        case 'rgba8unorm':
        case 'bgra8unorm':
        case 'r16float':
        case 'rg16float':
        case 'rgba16float':
            return true;
        default:
            return false;
    }
}

export function gpuFormatSampleType(format) {
    switch (format) {
        case 'rgba32uint':
            return 'uint';              // NEW: integer textures need 'uint'
        default:
            return gpuFormatIsFilterable(format) ? 'float' : 'unfilterable-float';
    }
}

export function gpuFormatToWrapperFormat(gpuFormat) {
    switch (gpuFormat) {
        case 'r8unorm':     return TextureFormat.R8UNORM;
        case 'r16float':    return TextureFormat.R16F;
        case 'r32float':    return TextureFormat.R32F;
        case 'rgba8unorm':  return TextureFormat.RGBA8;
        case 'rgba16float': return TextureFormat.RGBA16F;
        case 'rgba32float': return TextureFormat.RGBA32F;
        case 'rgba32uint':  return TextureFormat.RGBA32UINT;  // NEW
        default:            return TextureFormat.RGBA32F;
    }
}