// js/assets/gltf/GLTFLoader.js

import { GLBParser } from './GLBParser.js';
import {
    GLTFAsset, GLTFNode, GLTFMesh, GLTFPrimitive,
    GLTFSkeleton, GLTFAnimation, GLTFAnimationChannel,
    GLTFMaterialDef, GLTFTextureDef, GLTFImage,
} from './GLTFModel.js';
import { Logger } from '../../config/Logger.js';

export class GLTFLoader {
    constructor(options = {}) {
        this.verbose = options.verbose !== false;
        this._parser = new GLBParser({ verbose: this.verbose });
    }

    async loadFromURL(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`[GLTFLoader] fetch ${url} → ${res.status}`);
        const buf = await res.arrayBuffer();
        return this.loadFromBuffer(buf, url);
    }

    loadFromBuffer(arrayBuffer, name = '') {
        const { json, bin } = this._parser.parse(arrayBuffer);
        return this._build(json, bin, name);
    }

    // ---------------------------------------------------------------------

    _build(json, bin, name) {
        const asset = new GLTFAsset();
        asset.name = name;

        this._images   (json, bin, asset);
        this._textures (json,      asset);
        this._materials(json,      asset);
        this._meshes   (json, bin, asset);
        this._nodes    (json,      asset);
        this._skins    (json, bin, asset);
        this._anims    (json, bin, asset);

        const scene = json.scenes?.[json.scene ?? 0];
        asset.rootNodes = scene ? [...(scene.nodes || [])] : [];

        if (this.verbose) Logger.info(`[GLTFLoader] built "${name}"`);
        return asset;
    }

    _nodes(json, asset) {
        for (const [i, src] of (json.nodes || []).entries()) {
            const n = new GLTFNode();
            n.name         = src.name || `Node_${i}`;
            n.childIndices = [...(src.children || [])];
            n.meshIndex    = src.mesh ?? -1;
            n.skinIndex    = src.skin ?? -1;

            if (src.matrix) {
                n.hasMatrix = true;
                n.matrix    = new Float32Array(src.matrix);
            } else {
                if (src.translation) n.translation = [...src.translation];
                if (src.rotation)    n.rotation    = [...src.rotation];
                if (src.scale)       n.scale       = [...src.scale];
            }
            asset.nodes.push(n);
        }
        // Back‑link parents
        for (let i = 0; i < asset.nodes.length; i++) {
            for (const c of asset.nodes[i].childIndices) {
                asset.nodes[c].parentIndex = i;
            }
        }
    }

    _meshes(json, bin, asset) {
        for (const [i, src] of (json.meshes || []).entries()) {
            const mesh = new GLTFMesh();
            mesh.name = src.name || `Mesh_${i}`;

            for (const sp of src.primitives) {
                const p = new GLTFPrimitive();
                p.materialIndex = sp.material ?? -1;
                const a = sp.attributes;

                if (a.POSITION !== undefined) {
                    p.positions = GLBParser.readAccessor(json, bin, a.POSITION);
                    const info = GLBParser.accessorInfo(json, a.POSITION);
                    p.vertexCount = info.count;
                    if (info.min) p.aabbMin = [...info.min];
                    if (info.max) p.aabbMax = [...info.max];
                }
                if (a.NORMAL     !== undefined) p.normals  = GLBParser.readAccessor(json, bin, a.NORMAL);
                if (a.TEXCOORD_0 !== undefined) p.uvs0     = GLBParser.readAccessor(json, bin, a.TEXCOORD_0);
                if (a.JOINTS_0   !== undefined) p.joints0  = GLBParser.readAccessor(json, bin, a.JOINTS_0);
                if (a.WEIGHTS_0  !== undefined) p.weights0 = GLBParser.readAccessor(json, bin, a.WEIGHTS_0);

                if (sp.indices !== undefined) {
                    p.indices    = GLBParser.readAccessor(json, bin, sp.indices);
                    p.indexCount = p.indices.length;
                }
                mesh.primitives.push(p);
            }
            asset.meshes.push(mesh);
        }
    }

    _skins(json, bin, asset) {
        for (const [i, src] of (json.skins || []).entries()) {
            const s = new GLTFSkeleton();
            s.name             = src.name || `Skin_${i}`;
            s.jointNodeIndices = [...src.joints];
            s.rootNodeIndex    = src.skeleton ?? -1;

            if (src.inverseBindMatrices !== undefined) {
                s.inverseBindMatrices = GLBParser.readAccessor(json, bin, src.inverseBindMatrices);
            } else {
                const n = src.joints.length;
                const m = new Float32Array(16 * n);
                for (let j = 0; j < n; j++) { m[j*16]=1; m[j*16+5]=1; m[j*16+10]=1; m[j*16+15]=1; }
                s.inverseBindMatrices = m;
            }
            asset.skins.push(s);
        }
    }

    _anims(json, bin, asset) {
        for (const [i, src] of (json.animations || []).entries()) {
            const a = new GLTFAnimation();
            a.name = src.name || `Anim_${i}`;

            for (const ch of src.channels) {
                const smp = src.samplers[ch.sampler];
                const c = new GLTFAnimationChannel();
                c.targetNodeIndex = ch.target.node ?? -1;
                c.targetPath      = ch.target.path;
                c.interpolation   = smp.interpolation || 'LINEAR';
                c.times           = GLBParser.readAccessor(json, bin, smp.input);
                c.values          = GLBParser.readAccessor(json, bin, smp.output);
                a.duration = Math.max(a.duration, c.times[c.times.length - 1] || 0);
                a.channels.push(c);
            }
            asset.animations.push(a);
        }
    }

    _materials(json, asset) {
        for (const [i, src] of (json.materials || []).entries()) {
            const m = new GLTFMaterialDef();
            m.name = src.name || `Material_${i}`;

            const pbr = src.pbrMetallicRoughness || {};
            if (pbr.baseColorFactor) m.baseColorFactor = [...pbr.baseColorFactor];
            m.baseColorTextureIndex    = pbr.baseColorTexture?.index ?? -1;
            m.metallicFactor           = pbr.metallicFactor ?? 1;
            m.roughnessFactor          = pbr.roughnessFactor ?? 1;
            m.metallicRoughnessTexture = pbr.metallicRoughnessTexture?.index ?? -1;

            m.normalTextureIndex    = src.normalTexture?.index ?? -1;
            m.normalScale           = src.normalTexture?.scale ?? 1;
            m.occlusionTextureIndex = src.occlusionTexture?.index ?? -1;
            m.occlusionStrength     = src.occlusionTexture?.strength ?? 1;
            if (src.emissiveFactor) m.emissiveFactor = [...src.emissiveFactor];
            m.emissiveTextureIndex  = src.emissiveTexture?.index ?? -1;
            m.alphaMode   = src.alphaMode || 'OPAQUE';
            m.alphaCutoff = src.alphaCutoff ?? 0.5;
            m.doubleSided = src.doubleSided === true;

            asset.materials.push(m);
        }
    }

    _textures(json, asset) {
        for (const src of (json.textures || [])) {
            const t = new GLTFTextureDef();
            t.imageIndex   = src.source  ?? -1;
            t.samplerIndex = src.sampler ?? -1;
            asset.textures.push(t);
        }
    }

    _images(json, bin, asset) {
        for (const [i, src] of (json.images || []).entries()) {
            const img = new GLTFImage();
            img.name     = src.name || `Image_${i}`;
            img.mimeType = src.mimeType || '';
            if (src.bufferView !== undefined) {
                const bv = json.bufferViews[src.bufferView];
                const o  = bv.byteOffset || 0;
                img.data = new Uint8Array(bin.buffer, bin.byteOffset + o, bv.byteLength);
            } else if (src.uri) {
                img.uri = src.uri; // not fetched yet
            }
            asset.images.push(img);
        }
    }
}