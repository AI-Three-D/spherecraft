// js/renderer/mesh/SkinnedMeshRenderer.js
// Renders GLTFAsset instances. Phase 1: static geometry, solid‑shaded.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { Logger } from '../../config/Logger.js';

import { AnimationSampler } from '../../assets/gltf/AnimationSampler.js';
import { SkeletonPose } from '../../assets/gltf/SkeletonPose.js';

const UBO_FLOATS = 72;
const UBO_BYTES  = UBO_FLOATS * 4;
const UBO_ALIGN  = Math.ceil(UBO_BYTES / 256) * 256;

export class SkinnedMeshRenderer {
    constructor({ backend, uniformManager }) {
        this.backend        = backend;
        this.device         = backend?.device;
        this.uniformManager = uniformManager;
    
        this._instances = [];
        this._pipelineCull       = null;
        this._pipelineNoCull     = null;
        this._pipelineSkinCull   = null;
        this._pipelineSkinNoCull = null;
        this._uboBGL    = null;
        this._texBGL    = null;
        this._jointBGL  = null;
        this._dummyJointBuf = null;
        this._dummyJointBG  = null;
        this._whiteTexture     = null;
        this._whiteTextureView = null;
        this._linearSampler    = null;
        this._ready = false;
    
        this._tmpModel = new THREE.Matrix4();
        this._tmpUbo   = new Float32Array(UBO_FLOATS);
        this._fallbackSun = new THREE.Vector3(0.4, 0.8, 0.4).normalize();
    }
    async initialize() {
        if (!this.device) throw new Error('[SkinnedMeshRenderer] WebGPU backend required');
        this._buildPipeline();
        this._ready = true;
        Logger.info('[SkinnedMeshRenderer] ready');
    }

    isReady() { return this._ready; }

    async addInstance(asset, worldMatrix = null) {
        const inst = {
            asset,
            worldMatrix: worldMatrix ? worldMatrix.clone() : new THREE.Matrix4(),
            draws: [],
            _imageMap: null,
            _skinStates: new Map(),
        };
        await this._buildDraws(asset, inst);
        this._instances.push(inst);
    
        const skinCount = inst._skinStates.size;
        const animCount = asset.animations.length;
        Logger.info(
            `[SkinnedMeshRenderer] +instance "${asset.name}" ` +
            `draws=${inst.draws.length} skins=${skinCount} anims=${animCount}`
        );
        return inst;
    }
    removeInstance(inst) {
        const i = this._instances.indexOf(inst);
        if (i === -1) return;
        for (const d of inst.draws) this._destroyDraw(d);
        if (inst._imageMap) for (const e of inst._imageMap.values()) e.texture.destroy();
        if (inst._skinStates) for (const s of inst._skinStates.values()) s.gpuBuffer?.destroy();
        this._instances.splice(i, 1);
    }
    setInstanceTransform(inst, worldMatrix) {
        inst.worldMatrix.copy(worldMatrix);
    }

    render(camera, viewMatrix, projectionMatrix) {
        if (!this._ready || !this._instances.length) return;
        const pass = this.backend._renderPassEncoder;
        if (!pass) return;
    
        const sun    = this.uniformManager?.uniforms?.sunLightDirection?.value || this._fallbackSun;
        const camPos = camera?.position;
        let curPL = null;
    
        for (const inst of this._instances) {
            for (const d of inst.draws) {
                if (d.pipeline !== curPL) { curPL = d.pipeline; pass.setPipeline(curPL); }
    
                this._tmpModel.multiplyMatrices(inst.worldMatrix, d.nodeMatrix);
                this._packUbo(this._tmpModel, viewMatrix, projectionMatrix, sun, camPos, d);
                this.device.queue.writeBuffer(d.ubo, 0, this._tmpUbo);
    
                pass.setBindGroup(0, d.uboBindGroup);
                pass.setBindGroup(1, d.matBindGroup);
                pass.setBindGroup(2, d.skinBindGroup || this._dummyJointBG);
    
                pass.setVertexBuffer(0, d.posBuf);
                pass.setVertexBuffer(1, d.nrmBuf);
                pass.setVertexBuffer(2, d.uvBuf);
                if (d.isSkinned) {
                    pass.setVertexBuffer(3, d.jointBuf);
                    pass.setVertexBuffer(4, d.weightBuf);
                }
    
                if (d.idxBuf) {
                    pass.setIndexBuffer(d.idxBuf, d.idxFmt);
                    pass.drawIndexed(d.idxCount);
                } else {
                    pass.draw(d.vtxCount);
                }
            }
        }
    }
    dispose() {
        for (const inst of this._instances) {
            for (const d of inst.draws) this._destroyDraw(d);
            if (inst._imageMap) for (const e of inst._imageMap.values()) e.texture.destroy();
            if (inst._skinStates) for (const s of inst._skinStates.values()) s.gpuBuffer?.destroy();
        }
        this._instances.length = 0;
        this._whiteTexture?.destroy();
        this._dummyJointBuf?.destroy();
    }
    async _buildDraws(asset, instance) {
        const imageMap = await this._decodeAssetImages(asset);
        instance._imageMap = imageMap;
    
        const matBGs = new Map();
        const nodeWorld = this._nodeWorldMatrices(asset);
    
        for (let ni = 0; ni < asset.nodes.length; ni++) {
            const node = asset.nodes[ni];
            if (node.meshIndex < 0) continue;
            const mesh = asset.meshes[node.meshIndex];
    
            let skinState = null;
            if (node.skinIndex >= 0 && node.skinIndex < asset.skins.length) {
                if (!instance._skinStates.has(node.skinIndex)) {
                    instance._skinStates.set(
                        node.skinIndex,
                        this._createSkinState(asset.skins[node.skinIndex], ni)
                    );
                }
                skinState = instance._skinStates.get(node.skinIndex);
            }
    
            for (const prim of mesh.primitives) {
                const mi = prim.materialIndex;
                if (!matBGs.has(mi)) {
                    const md = mi >= 0 ? asset.materials[mi] : null;
                    matBGs.set(mi, this._createMaterialBindGroup(md, imageMap, asset));
                }
                instance.draws.push(
                    this._makeDraw(prim, nodeWorld[ni], asset, matBGs.get(mi), skinState)
                );
            }
        }
    }

    _uploadBitmap(bitmap) {
        const w = bitmap.width, h = bitmap.height;
        const mips = Math.floor(Math.log2(Math.max(w, h))) + 1;
    
        const tex = this.device.createTexture({
            label: `glTF_${w}x${h}`,
            size: [w, h],
            format: 'rgba8unorm',
            mipLevelCount: mips,
            usage: GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT,
        });
    
        this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: tex, mipLevel: 0 },
            [w, h]
        );
    
        if (mips > 1 && this.backend._generateMipmaps) {
            this.backend._generateMipmaps(tex, 'rgba8unorm', w, h, mips, 1);
        }
    
        return { texture: tex, view: tex.createView() };
    }
    _createSkinState(skeleton, meshNodeIndex) {
        const jc = skeleton.jointCount;
        const bytes = Math.max(64, jc * 64);
        const gpuBuf = this.device.createBuffer({
            label: `JointMats-${skeleton.name}`,
            size: bytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    
        const init = new Float32Array(jc * 16);
        for (let i = 0; i < jc; i++) {
            init[i * 16] = 1; init[i * 16 + 5] = 1;
            init[i * 16 + 10] = 1; init[i * 16 + 15] = 1;
        }
        this.device.queue.writeBuffer(gpuBuf, 0, init);
    
        return {
            skeleton,
            meshNodeIndex,
            jointMatrices: init,
            gpuBuffer: gpuBuf,
            bindGroup: this.device.createBindGroup({
                layout: this._jointBGL,
                entries: [{ binding: 0, resource: { buffer: gpuBuf } }],
            }),
            animIndex: -1,
            time: 0,
            playing: false,
            speed: 1,
        };
    }
    
    _makeDraw(prim, nodeMatrix, asset, matInfo, skinState) {
        const dev = this.device;
    
        const posBuf = this._vbuf(prim.positions);
        const nrmBuf = this._vbuf(prim.normals || this._upNormals(prim.vertexCount));
        const uvBuf  = this._vbuf(prim.uvs0 || new Float32Array(prim.vertexCount * 2));
    
        const isSkinned = !!(skinState && prim.joints0 && prim.weights0);
        let jointBuf = null, weightBuf = null;
        if (isSkinned) {
            const jd = prim.joints0 instanceof Uint16Array
                ? prim.joints0 : new Uint16Array(prim.joints0);
            jointBuf = this._vbuf(jd);
            let wd;
            if (prim.weights0 instanceof Float32Array) { wd = prim.weights0; }
            else {
                const div = prim.weights0 instanceof Uint8Array ? 255 : 65535;
                wd = new Float32Array(prim.weights0.length);
                for (let i = 0; i < wd.length; i++) wd[i] = prim.weights0[i] / div;
            }
            weightBuf = this._vbuf(wd);
        }
    
        let idxBuf = null, idxFmt = null, idxCount = 0;
        if (prim.indices) {
            let idx = prim.indices;
            if (idx instanceof Uint8Array) idx = Uint16Array.from(idx);
            idxBuf   = this._ibuf(idx);
            idxFmt   = idx instanceof Uint32Array ? 'uint32' : 'uint16';
            idxCount = idx.length;
        }
    
        const ubo = dev.createBuffer({ size: UBO_ALIGN, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const uboBindGroup = dev.createBindGroup({
            layout: this._uboBGL,
            entries: [{ binding: 0, resource: { buffer: ubo } }],
        });
    
        const md = prim.materialIndex >= 0 ? asset.materials[prim.materialIndex] : null;
        const ds = md?.doubleSided ?? false;
        const pipeline = isSkinned
            ? (ds ? this._pipelineSkinNoCull : this._pipelineSkinCull)
            : (ds ? this._pipelineNoCull     : this._pipelineCull);
    
        const alphaMode = md?.alphaMode ?? 'OPAQUE';
        const alphaCutoff = alphaMode === 'MASK' ? (md?.alphaCutoff ?? 0.5) : 0;
    
        return {
            posBuf, nrmBuf, uvBuf, jointBuf, weightBuf,
            idxBuf, idxFmt, idxCount,
            vtxCount: prim.vertexCount,
            ubo, uboBindGroup,
            matBindGroup: matInfo.bindGroup,
            pipeline, isSkinned,
            skinBindGroup: isSkinned ? skinState.bindGroup : null,
            nodeMatrix,
            baseColor:    md ? md.baseColorFactor : [1, 1, 1, 1],
            metallic:     md?.metallicFactor  ?? 0,
            roughness:    md?.roughnessFactor ?? 1,
            normalScale:  md?.normalScale     ?? 1,
            occStrength:  md?.occlusionStrength ?? 1,
            emissive:     md?.emissiveFactor  ?? [0, 0, 0],
            alphaCutoff,
            hasBase:   matInfo.hasBase,
            hasNormal: matInfo.hasNormal,
            hasMR:     matInfo.hasMR,
            hasEmis:   matInfo.hasEmis,
            hasOcc:    matInfo.hasOcc,
        };
    }
    _destroyDraw(d) {
        d.posBuf?.destroy();
        d.nrmBuf?.destroy();
        d.uvBuf?.destroy();
        d.jointBuf?.destroy();
        d.weightBuf?.destroy();
        d.idxBuf?.destroy();
        d.ubo?.destroy();
    }
    _vbuf(data) {
        const sz = Math.ceil(data.byteLength / 4) * 4;
        const b = this.device.createBuffer({
            size: sz, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true,
        });
        new data.constructor(b.getMappedRange()).set(data);
        b.unmap();
        return b;
    }

    _ibuf(data) {
        const sz = Math.ceil(data.byteLength / 4) * 4;
        const b = this.device.createBuffer({
            size: sz, usage: GPUBufferUsage.INDEX, mappedAtCreation: true,
        });
        new data.constructor(b.getMappedRange()).set(data);
        b.unmap();
        return b;
    }

    _upNormals(n) {
        const a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) a[i*3+1] = 1;
        return a;
    }

    update(deltaTime) {
        for (const inst of this._instances) {
            for (const [, ss] of inst._skinStates) {
                if (!ss.playing || ss.animIndex < 0) continue;
                const anim = inst.asset.animations[ss.animIndex];
                if (!anim || anim.duration <= 0) continue;
    
                ss.time += deltaTime * ss.speed;
                if (ss.time > anim.duration) ss.time %= anim.duration;
    
                const overrides = AnimationSampler.sample(anim, ss.time);
                const jm = SkeletonPose.compute(
                    inst.asset, ss.skeleton, ss.meshNodeIndex, overrides
                );
                ss.jointMatrices = jm;
                this.device.queue.writeBuffer(ss.gpuBuffer, 0, jm);
            }
        }
    }
    playAnimation(instance, animIndex, options = {}) {
        for (const [, ss] of instance._skinStates) {
            ss.animIndex = animIndex;
            ss.time      = options.startTime ?? 0;
            ss.speed     = options.speed ?? 1;
            ss.playing   = true;
        }
    }
    setAnimationSpeed(instance, speed = 1) {
        for (const [, ss] of instance._skinStates) {
            ss.speed = speed;
        }
    }
    stopAnimation(instance) {
        for (const [, ss] of instance._skinStates) {
            ss.playing = false;
        }
    }

    _nodeWorldMatrices(asset) {
        const world = new Array(asset.nodes.length).fill(null);
        const I = new THREE.Matrix4();

        const visit = (idx, parent) => {
            const local = this._localMatrix(asset.nodes[idx]);
            const w = new THREE.Matrix4().multiplyMatrices(parent, local);
            world[idx] = w;
            for (const c of asset.nodes[idx].childIndices) visit(c, w);
        };

        for (const r of asset.rootNodes) visit(r, I);
        for (let i = 0; i < world.length; i++) if (!world[i]) world[i] = new THREE.Matrix4();
        return world;
    }

    _localMatrix(node) {
        const m = new THREE.Matrix4();
        if (node.hasMatrix) {
            m.fromArray(node.matrix);
        } else {
            const t = new THREE.Vector3().fromArray(node.translation);
            const r = new THREE.Quaternion().fromArray(node.rotation);
            const s = new THREE.Vector3().fromArray(node.scale);
            m.compose(t, r, s);
        }
        return m;
    }

    _packUbo(model, view, proj, sun, camPos, d) {
        const f = this._tmpUbo;
        f.set(model.elements, 0);
        f.set(view.elements, 16);
        f.set(proj.elements, 32);
        const c = d.baseColor;
        f[48]=c[0]; f[49]=c[1]; f[50]=c[2]; f[51]=c[3];
        f[52]=sun.x; f[53]=sun.y; f[54]=sun.z; f[55]=d.metallic;
        f[56]=camPos?.x??0; f[57]=camPos?.y??0; f[58]=camPos?.z??0; f[59]=d.roughness;
        const e = d.emissive;
        f[60]=e[0]; f[61]=e[1]; f[62]=e[2]; f[63]=d.normalScale;
        f[64]=d.hasBase; f[65]=d.hasNormal; f[66]=d.hasMR; f[67]=d.hasEmis;
        f[68]=d.hasOcc; f[69]=d.occStrength; f[70]=d.alphaCutoff; f[71]=0;
    }

    _createMaterialBindGroup(matDef, imageMap, asset) {
        const resolve = (texIdx) => {
            if (texIdx < 0 || !asset.textures) return { view: this._whiteTextureView, has: 0 };
            const td = asset.textures[texIdx];
            if (!td) return { view: this._whiteTextureView, has: 0 };
            const e = imageMap.get(td.imageIndex);
            return e ? { view: e.view, has: 1 } : { view: this._whiteTextureView, has: 0 };
        };
    
        const base    = resolve(matDef?.baseColorTextureIndex    ?? -1);
        const normal  = resolve(matDef?.normalTextureIndex       ?? -1);
        const mr      = resolve(matDef?.metallicRoughnessTexture ?? -1);
        const emis    = resolve(matDef?.emissiveTextureIndex     ?? -1);
        const occ     = resolve(matDef?.occlusionTextureIndex    ?? -1);
    
        return {
            bindGroup: this.device.createBindGroup({
                layout: this._texBGL,
                entries: [
                    { binding: 0, resource: base.view },
                    { binding: 1, resource: normal.view },
                    { binding: 2, resource: mr.view },
                    { binding: 3, resource: emis.view },
                    { binding: 4, resource: occ.view },
                    { binding: 5, resource: this._linearSampler },
                ],
            }),
            hasBase: base.has, hasNormal: normal.has,
            hasMR: mr.has,     hasEmis: emis.has,
            hasOcc: occ.has,
        };
    }
    async _decodeAssetImages(asset) {
        const map = new Map();
        for (let i = 0; i < asset.images.length; i++) {
            const img = asset.images[i];
            if (!img.data) continue;
            try {
                const blob = new Blob([img.data], { type: img.mimeType || 'image/png' });
                const bmp  = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
                const tex  = this.device.createTexture({
                    label: img.name || `glTFImage_${i}`,
                    size: [bmp.width, bmp.height],
                    format: 'rgba8unorm',
                    usage: GPUTextureUsage.TEXTURE_BINDING |
                           GPUTextureUsage.COPY_DST |
                           GPUTextureUsage.RENDER_ATTACHMENT,
                });
                this.device.queue.copyExternalImageToTexture(
                    { source: bmp }, { texture: tex }, [bmp.width, bmp.height]
                );
                bmp.close();
                map.set(i, { texture: tex, view: tex.createView() });
                Logger.info(`[SkinnedMeshRenderer] decoded image[${i}] "${img.name}" ${bmp.width}×${bmp.height}`);
            } catch (e) {
                Logger.warn(`[SkinnedMeshRenderer] image[${i}] decode failed: ${e.message}`);
            }
        }
        return map;
    }
    _buildPipeline() {
        const dev = this.device;
    
        const code = /* wgsl */`
    struct U {
        model       : mat4x4<f32>,
        view        : mat4x4<f32>,
        proj        : mat4x4<f32>,
        baseColor   : vec4<f32>,
        sun         : vec3<f32>,
        metallic    : f32,
        cameraPos   : vec3<f32>,
        roughness   : f32,
        emissive    : vec3<f32>,
        normalScale : f32,
        texFlags    : vec4<f32>,
        texFlags2   : vec4<f32>,
    };
    
    @group(0) @binding(0) var<uniform> u : U;
    
    @group(1) @binding(0) var tBase   : texture_2d<f32>;
    @group(1) @binding(1) var tNormal : texture_2d<f32>;
    @group(1) @binding(2) var tMR     : texture_2d<f32>;
    @group(1) @binding(3) var tEmis   : texture_2d<f32>;
    @group(1) @binding(4) var tOcc    : texture_2d<f32>;
    @group(1) @binding(5) var samp    : sampler;
    
    @group(2) @binding(0) var<storage, read> jointMats : array<mat4x4<f32>>;
    
    struct VSOut {
        @builtin(position) clip : vec4<f32>,
        @location(0) wnrm : vec3<f32>,
        @location(1) uv   : vec2<f32>,
        @location(2) wpos : vec3<f32>,
    };
    struct StaticIn  { @location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) uv: vec2<f32> };
    struct SkinnedIn { @location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) uv: vec2<f32>,
                       @location(3) joints: vec4<u32>, @location(4) weights: vec4<f32> };
    
    fn xform(pos: vec4<f32>, nrm: vec3<f32>, uv: vec2<f32>) -> VSOut {
        var o : VSOut;
        let wp = u.model * pos;
        o.wpos = wp.xyz;
        o.clip = u.proj * u.view * wp;
        let nm = mat3x3<f32>(u.model[0].xyz, u.model[1].xyz, u.model[2].xyz);
        o.wnrm = normalize(nm * nrm);
        o.uv = uv;
        return o;
    }
    
    @vertex fn vs_static(i: StaticIn) -> VSOut {
        return xform(vec4<f32>(i.pos, 1.0), i.nrm, i.uv);
    }
    @vertex fn vs_skinned(i: SkinnedIn) -> VSOut {
        let j = i.joints; let w = i.weights;
        let skin = w.x * jointMats[j.x] + w.y * jointMats[j.y]
                 + w.z * jointMats[j.z] + w.w * jointMats[j.w];
        let sp = skin * vec4<f32>(i.pos, 1.0);
        let sn = normalize((skin * vec4<f32>(i.nrm, 0.0)).xyz);
        return xform(sp, sn, i.uv);
    }
    
    const PI = 3.14159265;
    
    fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
        return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
    }
    
    fn distributionGGX(NdH: f32, a2: f32) -> f32 {
        let d = NdH * NdH * (a2 - 1.0) + 1.0;
        return a2 / (PI * d * d + 1e-7);
    }
    
    fn geometrySmith(NdV: f32, NdL: f32, k: f32) -> f32 {
        let gv = NdV / (NdV * (1.0 - k) + k);
        let gl = NdL / (NdL * (1.0 - k) + k);
        return gv * gl;
    }
    
    fn cotangentFrame(N: vec3<f32>, p: vec3<f32>, uv: vec2<f32>) -> mat3x3<f32> {
        let dp1 = dpdx(p);   let dp2 = dpdy(p);
        let duv1 = dpdx(uv); let duv2 = dpdy(uv);
        let det = duv1.x * duv2.y - duv1.y * duv2.x;
        if (abs(det) < 1e-8) { return mat3x3<f32>(vec3(1,0,0), vec3(0,1,0), N); }
        let inv = 1.0 / det;
        var T = normalize((dp1 * duv2.y - dp2 * duv1.y) * inv);
        T = normalize(T - N * dot(N, T));
        let B = cross(N, T);
        return mat3x3<f32>(T, B, N);
    }
    
    @fragment fn fs(i: VSOut, @builtin(front_facing) ff: bool) -> @location(0) vec4<f32> {
        var albedo = u.baseColor;
        if (u.texFlags.x > 0.5) {
            let tc = textureSample(tBase, samp, i.uv);
            albedo = vec4<f32>(albedo.rgb * tc.rgb, albedo.a * tc.a);
        }
    
        let cutoff = u.texFlags2.z;
        if (cutoff > 0.0) {
            let fw = fwidth(albedo.a) * 0.5;
            if (albedo.a < cutoff - fw) { discard; }
        }
    
        var N = normalize(i.wnrm);
        if (!ff) { N = -N; }
        if (u.texFlags.y > 0.5) {
            let tn = textureSample(tNormal, samp, i.uv).xyz * 2.0 - 1.0;
            let sn = vec3<f32>(tn.xy * u.normalScale, tn.z);
            let TBN = cotangentFrame(N, i.wpos, i.uv);
            N = normalize(TBN * sn);
        }
    
        var metallic  = u.metallic;
        var roughness = u.roughness;
        if (u.texFlags.z > 0.5) {
            let mr = textureSample(tMR, samp, i.uv);
            roughness *= mr.g;
            metallic  *= mr.b;
        }
        roughness = clamp(roughness, 0.04, 1.0);
    
        var ao = 1.0;
        if (u.texFlags2.x > 0.5) {
            ao = mix(1.0, textureSample(tOcc, samp, i.uv).r, u.texFlags2.y);
        }
    
        let V = normalize(u.cameraPos - i.wpos);
        let L = normalize(u.sun);
        let H = normalize(V + L);
        let NdL = max(dot(N, L), 0.0);
        let NdV = max(dot(N, V), 0.001);
        let NdH = max(dot(N, H), 0.0);
        let VdH = max(dot(V, H), 0.0);
    
        let F0 = mix(vec3<f32>(0.04), albedo.rgb, metallic);
        let F  = fresnelSchlick(VdH, F0);
    
        let a  = roughness * roughness;
        let a2 = a * a;
        let D  = distributionGGX(NdH, a2);
        let k  = (roughness + 1.0) * (roughness + 1.0) / 8.0;
        let G  = geometrySmith(NdV, NdL, k);
    
        let spec    = (D * G * F) / (4.0 * NdV * NdL + 0.001);
        let kD      = (1.0 - F) * (1.0 - metallic);
        let diffuse = kD * albedo.rgb / PI;
    
        let Lo = (diffuse + spec) * NdL;
    
        let skyCol = vec3<f32>(0.10, 0.12, 0.18);
        let gndCol = vec3<f32>(0.06, 0.05, 0.04);
        let hemi   = mix(gndCol, skyCol, N.y * 0.5 + 0.5);
        let ambient = hemi * albedo.rgb * ao;
    
        var color = ambient + Lo;
    
        var emis = u.emissive;
        if (u.texFlags.w > 0.5) {
            emis *= textureSample(tEmis, samp, i.uv).rgb;
        }
        color += emis;
    
        return vec4<f32>(color, 1.0);
    }`;
    
        const module = dev.createShaderModule({ label: 'SkinnedMesh-PBR', code });
    
        this._uboBGL = dev.createBindGroupLayout({
            label: 'SMR-UBO', entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        });
    
        this._texBGL = dev.createBindGroupLayout({
            label: 'SMR-Tex', entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            ],
        });
    
        this._jointBGL = dev.createBindGroupLayout({
            label: 'SMR-Joints', entries: [{
                binding: 0, visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'read-only-storage' },
            }],
        });
    
        const pLayout = dev.createPipelineLayout({
            bindGroupLayouts: [this._uboBGL, this._texBGL, this._jointBGL],
        });
    
        const staticBufs = [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
            { arrayStride: 8,  attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
        ];
        const skinnedBufs = [
            ...staticBufs,
            { arrayStride: 8,  attributes: [{ shaderLocation: 3, offset: 0, format: 'uint16x4' }] },
            { arrayStride: 16, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }] },
        ];
    
        const frag  = { module, entryPoint: 'fs', targets: [{ format: this.backend.format }] };
        const depth = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
    
        const mk = (ep, bufs, cull) => dev.createRenderPipeline({
            label: `SMR-${ep}-${cull}`, layout: pLayout,
            vertex:   { module, entryPoint: ep, buffers: bufs },
            fragment: frag,
            primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
            depthStencil: depth,
        });
    
        this._pipelineCull       = mk('vs_static',  staticBufs,  'back');
        this._pipelineNoCull     = mk('vs_static',  staticBufs,  'none');
        this._pipelineSkinCull   = mk('vs_skinned', skinnedBufs, 'back');
        this._pipelineSkinNoCull = mk('vs_skinned', skinnedBufs, 'none');
    
        this._dummyJointBuf = dev.createBuffer({
            size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        dev.queue.writeBuffer(this._dummyJointBuf, 0,
            new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]));
        this._dummyJointBG = dev.createBindGroup({
            layout: this._jointBGL,
            entries: [{ binding: 0, resource: { buffer: this._dummyJointBuf } }],
        });
    
        this._whiteTexture = dev.createTexture({
            size: [1, 1], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        dev.queue.writeTexture(
            { texture: this._whiteTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 }, [1, 1]
        );
        this._whiteTextureView = this._whiteTexture.createView();
    
        this._linearSampler = dev.createSampler({
            magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
            addressModeU: 'repeat', addressModeV: 'repeat',
        });
    }
}
