    // renderer/resources/RenderTarget.js

    import { Texture, TextureFormat, TextureFilter } from './texture.js';

    export class RenderTarget {
        constructor(width, height, options = {}) {
            this.id = RenderTarget._nextId++;
            
            this.width = width;
            this.height = height;
            
            this.colorAttachments = [];
            this.depthAttachment = null;
            
            const colorCount = options.colorCount || 1;

            const format = options.format || TextureFormat.RGBA8;
            const minFilter = options.minFilter || TextureFilter.NEAREST;
            const magFilter = options.magFilter || TextureFilter.NEAREST;
            
            for (let i = 0; i < colorCount; i++) {
                this.colorAttachments.push(new Texture({
                    width,
                    height,
                    format,
                    minFilter,
                    magFilter,
                    generateMipmaps: false
                }));
            }
            
            if (options.depthBuffer !== false) {
                this.depthAttachment = new Texture({
                    width,
                    height,
                    format: options.depthFormat || TextureFormat.DEPTH24,
                    minFilter: TextureFilter.NEAREST,
                    magFilter: TextureFilter.NEAREST,
                    generateMipmaps: false
                });
            }
            
            this._gpuRenderTarget = null;  // CHANGE: renamed from _gpuFramebuffer for clarity
            this._needsSetup = true;
        }
        
        static _nextId = 0;
        
        get texture() {
            return this.colorAttachments[0];
        }
        
        get textures() {
            return this.colorAttachments;
        }
        
        setSize(width, height) {
            this.width = width;
            this.height = height;
            
            for (const tex of this.colorAttachments) {
                tex.width = width;
                tex.height = height;
                tex._needsUpload = true;
            }
            
            if (this.depthAttachment) {
                this.depthAttachment.width = width;
                this.depthAttachment.height = height;
                this.depthAttachment._needsUpload = true;
            }
            
            this._needsSetup = true;
        }
        
        dispose() {
            for (const tex of this.colorAttachments) {
                tex.dispose();
            }
            if (this.depthAttachment) {
                this.depthAttachment.dispose();
            }
            
            // CHANGE: Clean up WebGPU render target
            if (this._gpuRenderTarget?.depthTexture) {
                this._gpuRenderTarget.depthTexture.destroy();
            }
            this._gpuRenderTarget = null;
        }
    }