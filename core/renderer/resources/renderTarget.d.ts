import type { Texture } from './texture.js';
export class RenderTarget {
    constructor(width: number, height: number, options?: { format?: string; minFilter?: string; magFilter?: string; depthBuffer?: boolean; depthFormat?: string; colorCount?: number });
    width: number; height: number;
    readonly colorAttachments: Texture[];
    readonly depthAttachment: Texture | null;
    readonly texture: Texture;
    readonly textures: Texture[];
    setSize(width: number, height: number): void;
    dispose(): void;
}
