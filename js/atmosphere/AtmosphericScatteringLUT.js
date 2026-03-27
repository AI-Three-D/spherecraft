import { Texture, TextureFormat, TextureFilter, TextureWrap } from
    '../renderer/resources/texture.js';

export class AtmosphericScatteringLUT {
    constructor(backend) {
        this.backend = backend;
        this.transmittanceLUT = null;
        this.multiScatterLUT = null;
        this.dirty = true;
        this.initialized = false;
    }

    async initialize() {
        

        this.transmittanceLUT = new Texture({
            width: 256,
            height: 64,
            format: TextureFormat.RGBA16F,
            minFilter: TextureFilter.LINEAR,
            magFilter: TextureFilter.LINEAR,
            wrapS: TextureWrap.CLAMP,
            wrapT: TextureWrap.CLAMP,
            generateMipmaps: false
        });

        this.backend.createTexture(this.transmittanceLUT);

        if (!this.transmittanceLUT._gpuTexture) {
            
            return;
        }

        

        this.initialized = true;
        this.dirty = false;
    }

    getTransmittanceLUT() {
        return this.transmittanceLUT;
    }

    getMultiScatterLUT() {
        return this.multiScatterLUT;
    }

    markDirty() {
        this.dirty = true;
    }

    isDirty() {
        return this.dirty;
    }

    dispose() {
        if (this.transmittanceLUT && this.transmittanceLUT._gpuTexture) {
            if (this.backend.getAPIName() === 'webgpu') {
                if (this.transmittanceLUT._gpuTexture.texture) {
                    this.transmittanceLUT._gpuTexture.texture.destroy();
                }
            } else {
                if (this.transmittanceLUT._gpuTexture.glTexture) {
                    this.backend.gl.deleteTexture(
                        this.transmittanceLUT._gpuTexture.glTexture
                    );
                }
            }
            this.transmittanceLUT = null;
        }

        if (this.multiScatterLUT && this.multiScatterLUT._gpuTexture) {
            if (this.backend.getAPIName() === 'webgpu') {
                if (this.multiScatterLUT._gpuTexture.texture) {
                    this.multiScatterLUT._gpuTexture.texture.destroy();
                }
            } else {
                if (this.multiScatterLUT._gpuTexture.glTexture) {
                    this.backend.gl.deleteTexture(
                        this.multiScatterLUT._gpuTexture.glTexture
                    );
                }
            }
            this.multiScatterLUT = null;
        }

        this.initialized = false;
        
    }
}
