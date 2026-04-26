// js/renderer/mesh/SkinnedMeshRenderer.js
// Renders GLTFAsset instances with actor-focused lighting and shadowing.

import { Vector3, Quaternion, Matrix4 } from '../../../shared/math/index.js';
import { Logger } from '../../../shared/Logger.js';

import { AnimationSampler } from '../../../shared/gltf/AnimationSampler.js';
import { SkeletonPose } from '../../../shared/gltf/SkeletonPose.js';

const UBO_FLOATS = 96;
const UBO_BYTES = UBO_FLOATS * 4;
const UBO_ALIGN = Math.ceil(UBO_BYTES / 256) * 256;
const SHADOW_CASCADE_COUNT = 3;

const DEFAULT_MATERIAL_TUNING = Object.freeze({
    decodeBaseColorSRGB: true,
    decodeEmissiveSRGB: true,
    metallicScale: 0.05,
    metallicMax: 0.08,
    roughnessScale: 1.0,
    roughnessMin: 0.65,
    roughnessMax: 1.0,
    specularStrength: 0.16,
    ambientStrength: 0.35,
    sunStrength: 1.0,
    localLightStrength: 1.0,
    normalScaleMultiplier: 0.8,
});

const DEFAULT_SHADOW_TUNING = Object.freeze({
    castCascaded: true,
    receiveCascaded: true,
    shadowStrength: 1.0,
});

const DEFAULT_BLOOM_TUNING = Object.freeze({
    enabled: true,
    bloomWeight: 1.0,
    sourceScale: 4.0,
});

function finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function clampNumber(value, fallback, min = -Infinity, max = Infinity) {
    const next = finiteOr(value, fallback);
    return Math.min(max, Math.max(min, next));
}

function boolOr(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

export class SkinnedMeshRenderer {
    constructor({ backend, uniformManager }) {
        this.backend = backend;
        this.device = backend?.device;
        this.uniformManager = uniformManager;

        this._instances = [];
        this._pipelineCull = null;
        this._pipelineNoCull = null;
        this._pipelineSkinCull = null;
        this._pipelineSkinNoCull = null;
        this._pipelineBloomCull = null;
        this._pipelineBloomNoCull = null;
        this._pipelineBloomSkinCull = null;
        this._pipelineBloomSkinNoCull = null;
        this._shadowPipelineCull = null;
        this._shadowPipelineNoCull = null;
        this._shadowPipelineSkinCull = null;
        this._shadowPipelineSkinNoCull = null;
        this._uboBGL = null;
        this._texBGL = null;
        this._jointBGL = null;
        this._lightingBGL = null;
        this._shadowDrawBGL = null;
        this._shadowCascadeBGL = null;
        this._dummyJointBuf = null;
        this._dummyJointBG = null;
        this._dummyStorageBuffer = null;
        this._dummyUniformBuffer = null;
        this._dummyDepthTexture = null;
        this._dummyDepthTextureView = null;
        this._shadowCompareSampler = null;
        this._whiteTexture = null;
        this._whiteTextureView = null;
        this._linearSampler = null;
        this._lightingBindGroup = null;
        this._lightingBindGroupKey = '';
        this._clusterLightBuffers = null;
        this._shadowRenderer = null;
        this._shadowCascadeSelectBuffers = [];
        this._shadowCascadeBindGroups = [];
        this._shadowCascadeBindGroupsRenderer = null;
        this._ready = false;

        this._tmpModel = new Matrix4();
        this._tmpUbo = new Float32Array(UBO_FLOATS);
        this._tmpShadowUbo = new Float32Array(16);
        this._tmpShadowSelect = new Uint32Array(4);
        this._fallbackSun = new Vector3(0.4, 0.8, 0.4).normalize();
    }

    async initialize() {
        if (!this.device) throw new Error('[SkinnedMeshRenderer] WebGPU backend required');
        this._buildPipeline();
        this._ready = true;
        Logger.info('[SkinnedMeshRenderer] ready');
    }

    isReady() {
        return this._ready;
    }

    setClusterLightBuffers(buffers) {
        if (this._clusterLightBuffers === buffers) return;
        this._clusterLightBuffers = buffers || null;
        this._lightingBindGroupKey = '';
        this._lightingBindGroup = null;
    }

    setShadowRenderer(renderer) {
        if (this._shadowRenderer === renderer) return;
        this._shadowRenderer = renderer || null;
        this._lightingBindGroupKey = '';
        this._lightingBindGroup = null;
        this._shadowCascadeBindGroupsRenderer = null;
        this._shadowCascadeBindGroups = [];
    }

    async addInstance(asset, worldMatrix = null, options = {}) {
        const inst = {
            asset,
            worldMatrix: worldMatrix ? worldMatrix.clone() : new Matrix4(),
            draws: [],
            _imageMap: null,
            _skinStates: new Map(),
            renderOptions: options || {},
            materialTuning: this._resolveMaterialTuning(options),
            shadowTuning: this._resolveShadowTuning(options),
            bloomTuning: this._resolveBloomTuning(options),
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

    setInstancePose(instance, pose) {
        instance._externalPose = pose;
    }

    removeInstance(inst) {
        const i = this._instances.indexOf(inst);
        if (i === -1) return;
        for (const d of inst.draws) this._destroyDraw(d);
        if (inst._imageMap) {
            for (const e of inst._imageMap.values()) e.texture.destroy();
        }
        if (inst._skinStates) {
            for (const s of inst._skinStates.values()) s.gpuBuffer?.destroy();
        }
        this._instances.splice(i, 1);
    }

    setInstanceTransform(inst, worldMatrix) {
        inst.worldMatrix.copy(worldMatrix);
    }

    render(camera, viewMatrix, projectionMatrix) {
        if (!this._ready || !this._instances.length) return;
        const pass = this.backend._renderPassEncoder;
        if (!pass) return;

        this._ensureLightingBindGroup();
        const lighting = this._getLightingState();
        const camPos = camera?.position;
        let curPL = null;

        for (const inst of this._instances) {
            for (const d of inst.draws) {
                if (d.pipeline !== curPL) {
                    curPL = d.pipeline;
                    pass.setPipeline(curPL);
                }

                this._tmpModel.multiplyMatrices(inst.worldMatrix, d.nodeMatrix);
                this._packUbo(this._tmpModel, viewMatrix, projectionMatrix, lighting, camPos, d);
                this.device.queue.writeBuffer(d.ubo, 0, this._tmpUbo);

                pass.setBindGroup(0, d.uboBindGroup);
                pass.setBindGroup(1, d.matBindGroup);
                pass.setBindGroup(2, d.skinBindGroup || this._dummyJointBG);
                pass.setBindGroup(3, this._lightingBindGroup);

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

    renderBloom(camera, viewMatrix, projectionMatrix) {
        if (!this._ready || !this._instances.length) return;
        const pass = this.backend._renderPassEncoder;
        if (!pass) return;

        const lighting = this._getLightingState();
        const camPos = camera?.position;
        let curPL = null;

        for (const inst of this._instances) {
            for (const d of inst.draws) {
                if (!d.hasBloom) continue;
                if (d.bloomPipeline !== curPL) {
                    curPL = d.bloomPipeline;
                    pass.setPipeline(curPL);
                }

                this._tmpModel.multiplyMatrices(inst.worldMatrix, d.nodeMatrix);
                this._packUbo(this._tmpModel, viewMatrix, projectionMatrix, lighting, camPos, d);
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

    renderShadowPasses(encoder, shadowRenderer = this._shadowRenderer) {
        if (!this._ready || !this._instances.length || !encoder || !shadowRenderer) return;

        this._ensureShadowCascadeBindGroups(shadowRenderer);

        for (let cascade = 0; cascade < SHADOW_CASCADE_COUNT; cascade++) {
            const shadowView = shadowRenderer.getShadowDepthView?.(cascade);
            if (!shadowView) continue;

            const mapSize = shadowRenderer.shadowMapSizes?.[cascade] || 1024;
            const pass = encoder.beginRenderPass({
                label: `ActorShadowDepth-Cascade${cascade}`,
                colorAttachments: [],
                depthStencilAttachment: {
                    view: shadowView,
                    depthClearValue: 1.0,
                    depthLoadOp: 'load',
                    depthStoreOp: 'store',
                },
            });

            pass.setViewport(0, 0, mapSize, mapSize, 0, 1);
            let curPL = null;

            for (const inst of this._instances) {
                for (const d of inst.draws) {
                    if (!d.castShadow) continue;
                    if (d.shadowPipeline !== curPL) {
                        curPL = d.shadowPipeline;
                        pass.setPipeline(curPL);
                    }

                    this._tmpModel.multiplyMatrices(inst.worldMatrix, d.nodeMatrix);
                    this._packShadowUbo(this._tmpModel);
                    this.device.queue.writeBuffer(d.shadowUbo, 0, this._tmpShadowUbo);

                    pass.setBindGroup(0, d.shadowUboBindGroup);
                    pass.setBindGroup(1, this._shadowCascadeBindGroups[cascade]);
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

            pass.end();
        }
    }

    /**
     * Apply a pre-blended pose (from ActorAnimationController.currentPose)
     * to the render instance's joint matrices.
     *
     * @param {object} instance
     * @param {import('../assets/gltf/GLTFModel.js').GLTFAsset} asset
     * @param {Float32Array} pose
     */
    applyPose(instance, asset, pose) {
        if (!instance || !asset || !pose) return;

        const nodeCount = asset.nodes.length;
        if (pose.length < nodeCount * 10) {
            Logger.warn(
                `[SkinnedMeshRenderer] applyPose ignored for "${asset.name}": ` +
                `pose length ${pose.length} < expected ${nodeCount * 10}`
            );
            return;
        }
        const overrides = new Map();

        for (let i = 0; i < nodeCount; i++) {
            const base = i * 10;
            overrides.set(i, {
                translation: [pose[base], pose[base + 1], pose[base + 2]],
                rotation: [pose[base + 3], pose[base + 4], pose[base + 5], pose[base + 6]],
                scale: [pose[base + 7], pose[base + 8], pose[base + 9]],
            });
        }

        this._updateJointMatrices(instance, asset, overrides);
    }

    dispose() {
        for (const inst of this._instances) {
            for (const d of inst.draws) this._destroyDraw(d);
            if (inst._imageMap) {
                for (const e of inst._imageMap.values()) e.texture.destroy();
            }
            if (inst._skinStates) {
                for (const s of inst._skinStates.values()) s.gpuBuffer?.destroy();
            }
        }
        this._instances.length = 0;

        this._whiteTexture?.destroy();
        this._dummyJointBuf?.destroy();
        this._dummyStorageBuffer?.destroy();
        this._dummyUniformBuffer?.destroy();
        this._dummyDepthTexture?.destroy();
        for (const buf of this._shadowCascadeSelectBuffers) {
            buf?.destroy();
        }
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
                    this._makeDraw(
                        prim,
                        nodeWorld[ni],
                        asset,
                        matBGs.get(mi),
                        skinState,
                        instance.materialTuning,
                        instance.shadowTuning,
                        instance.bloomTuning
                    )
                );
            }
        }
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
            init[i * 16] = 1;
            init[i * 16 + 5] = 1;
            init[i * 16 + 10] = 1;
            init[i * 16 + 15] = 1;
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

    _makeDraw(prim, nodeMatrix, asset, matInfo, skinState, materialTuning, shadowTuning, bloomTuning) {
        const dev = this.device;

        const posBuf = this._vbuf(prim.positions);
        const nrmBuf = this._vbuf(prim.normals || this._upNormals(prim.vertexCount));
        const uvBuf = this._vbuf(prim.uvs0 || new Float32Array(prim.vertexCount * 2));

        const isSkinned = !!(skinState && prim.joints0 && prim.weights0);
        let jointBuf = null;
        let weightBuf = null;
        if (isSkinned) {
            const jd = prim.joints0 instanceof Uint16Array
                ? prim.joints0
                : new Uint16Array(prim.joints0);
            jointBuf = this._vbuf(jd);
            let wd;
            if (prim.weights0 instanceof Float32Array) {
                wd = prim.weights0;
            } else {
                const div = prim.weights0 instanceof Uint8Array ? 255 : 65535;
                wd = new Float32Array(prim.weights0.length);
                for (let i = 0; i < wd.length; i++) wd[i] = prim.weights0[i] / div;
            }
            weightBuf = this._vbuf(wd);
        }

        let idxBuf = null;
        let idxFmt = null;
        let idxCount = 0;
        if (prim.indices) {
            let idx = prim.indices;
            if (idx instanceof Uint8Array) idx = Uint16Array.from(idx);
            idxBuf = this._ibuf(idx);
            idxFmt = idx instanceof Uint32Array ? 'uint32' : 'uint16';
            idxCount = idx.length;
        }

        const ubo = dev.createBuffer({
            size: UBO_ALIGN,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const uboBindGroup = dev.createBindGroup({
            layout: this._uboBGL,
            entries: [{ binding: 0, resource: { buffer: ubo } }],
        });

        const shadowUbo = dev.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const shadowUboBindGroup = dev.createBindGroup({
            layout: this._shadowDrawBGL,
            entries: [{ binding: 0, resource: { buffer: shadowUbo } }],
        });

        const md = prim.materialIndex >= 0 ? asset.materials[prim.materialIndex] : null;
        const ds = md?.doubleSided ?? false;
        const pipeline = isSkinned
            ? (ds ? this._pipelineSkinNoCull : this._pipelineSkinCull)
            : (ds ? this._pipelineNoCull : this._pipelineCull);
        const bloomPipeline = isSkinned
            ? (ds ? this._pipelineBloomSkinNoCull : this._pipelineBloomSkinCull)
            : (ds ? this._pipelineBloomNoCull : this._pipelineBloomCull);
        const shadowPipeline = isSkinned
            ? (ds ? this._shadowPipelineSkinNoCull : this._shadowPipelineSkinCull)
            : (ds ? this._shadowPipelineNoCull : this._shadowPipelineCull);

        const alphaMode = md?.alphaMode ?? 'OPAQUE';
        const alphaCutoff = alphaMode === 'MASK' ? (md?.alphaCutoff ?? 0.5) : 0;
        const emissiveFactor = md?.emissiveFactor ?? [0, 0, 0];
        const hasEmissiveFactor = emissiveFactor[0] > 0 || emissiveFactor[1] > 0 || emissiveFactor[2] > 0;
        const hasBloom = bloomTuning.bloomWeight > 0 && (matInfo.hasEmis || hasEmissiveFactor);

        return {
            posBuf, nrmBuf, uvBuf, jointBuf, weightBuf,
            idxBuf, idxFmt, idxCount,
            vtxCount: prim.vertexCount,
            ubo, uboBindGroup,
            shadowUbo, shadowUboBindGroup,
            matBindGroup: matInfo.bindGroup,
            pipeline,
            bloomPipeline,
            shadowPipeline,
            isSkinned,
            skinBindGroup: isSkinned ? skinState.bindGroup : null,
            nodeMatrix,
            baseColor: md ? md.baseColorFactor : [1, 1, 1, 1],
            metallic: md?.metallicFactor ?? 0,
            roughness: md?.roughnessFactor ?? 1,
            normalScale: (md?.normalScale ?? 1) * materialTuning.normalScaleMultiplier,
            occStrength: md?.occlusionStrength ?? 1,
            emissive: emissiveFactor,
            alphaCutoff,
            hasBloom,
            hasBase: matInfo.hasBase,
            hasNormal: matInfo.hasNormal,
            hasMR: matInfo.hasMR,
            hasEmis: matInfo.hasEmis,
            hasOcc: matInfo.hasOcc,
            decodeBaseColorSRGB: materialTuning.decodeBaseColorSRGB ? 1 : 0,
            decodeEmissiveSRGB: materialTuning.decodeEmissiveSRGB ? 1 : 0,
            metallicScale: materialTuning.metallicScale,
            metallicMax: materialTuning.metallicMax,
            roughnessScale: materialTuning.roughnessScale,
            roughnessMin: materialTuning.roughnessMin,
            roughnessMax: materialTuning.roughnessMax,
            specularStrength: materialTuning.specularStrength,
            ambientStrength: materialTuning.ambientStrength,
            sunStrength: materialTuning.sunStrength,
            localLightStrength: materialTuning.localLightStrength,
            castShadow: shadowTuning.castCascaded,
            shadowStrength: shadowTuning.receiveCascaded ? shadowTuning.shadowStrength : 0,
            bloomWeight: bloomTuning.bloomWeight,
            bloomSourceScale: bloomTuning.sourceScale,
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
        d.shadowUbo?.destroy();
    }

    _vbuf(data) {
        const sz = Math.ceil(data.byteLength / 4) * 4;
        const b = this.device.createBuffer({
            size: sz,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
        new data.constructor(b.getMappedRange()).set(data);
        b.unmap();
        return b;
    }

    _ibuf(data) {
        const sz = Math.ceil(data.byteLength / 4) * 4;
        const b = this.device.createBuffer({
            size: sz,
            usage: GPUBufferUsage.INDEX,
            mappedAtCreation: true,
        });
        new data.constructor(b.getMappedRange()).set(data);
        b.unmap();
        return b;
    }

    _upNormals(n) {
        const a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) a[i * 3 + 1] = 1;
        return a;
    }

    update(deltaTime) {
        for (const inst of this._instances) {
            if (inst._externalPose) {
                this._updateJointMatrices(inst, inst.asset, inst._externalPose);
                continue;
            }

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
            ss.time = options.startTime ?? 0;
            ss.speed = options.speed ?? 1;
            ss.playing = true;
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

    _updateJointMatrices(instance, asset, overrides = null) {
        if (!instance?._skinStates?.size) return;

        for (const [, ss] of instance._skinStates) {
            const jm = SkeletonPose.compute(
                asset,
                ss.skeleton,
                ss.meshNodeIndex,
                overrides
            );
            ss.jointMatrices = jm;
            this.device.queue.writeBuffer(ss.gpuBuffer, 0, jm);
        }
    }

    _nodeWorldMatrices(asset) {
        const world = new Array(asset.nodes.length).fill(null);
        const I = new Matrix4();

        const visit = (idx, parent) => {
            const local = this._localMatrix(asset.nodes[idx]);
            const w = new Matrix4().multiplyMatrices(parent, local);
            world[idx] = w;
            for (const c of asset.nodes[idx].childIndices) visit(c, w);
        };

        for (const r of asset.rootNodes) visit(r, I);
        for (let i = 0; i < world.length; i++) {
            if (!world[i]) world[i] = new Matrix4();
        }
        return world;
    }

    _localMatrix(node) {
        const m = new Matrix4();
        if (node.hasMatrix) {
            m.fromArray(node.matrix);
        } else {
            const t = new Vector3().fromArray(node.translation);
            const r = new Quaternion().fromArray(node.rotation);
            const s = new Vector3().fromArray(node.scale);
            m.compose(t, r, s);
        }
        return m;
    }

    _packUbo(model, view, proj, lighting, camPos, d) {
        const f = this._tmpUbo;
        f.fill(0);
        f.set(model.elements, 0);
        f.set(view.elements, 16);
        f.set(proj.elements, 32);

        const c = d.baseColor;
        f[48] = c[0];
        f[49] = c[1];
        f[50] = c[2];
        f[51] = c[3];

        f[52] = lighting.sunDirection.x;
        f[53] = lighting.sunDirection.y;
        f[54] = lighting.sunDirection.z;
        f[55] = d.metallic;

        f[56] = camPos?.x ?? 0;
        f[57] = camPos?.y ?? 0;
        f[58] = camPos?.z ?? 0;
        f[59] = d.roughness;

        const e = d.emissive;
        f[60] = e[0];
        f[61] = e[1];
        f[62] = e[2];
        f[63] = d.normalScale;

        f[64] = d.hasBase;
        f[65] = d.hasNormal;
        f[66] = d.hasMR;
        f[67] = d.hasEmis;

        f[68] = d.hasOcc;
        f[69] = d.occStrength;
        f[70] = d.alphaCutoff;
        f[71] = d.decodeBaseColorSRGB;

        f[72] = lighting.sunColor.r;
        f[73] = lighting.sunColor.g;
        f[74] = lighting.sunColor.b;
        f[75] = lighting.sunIntensity;

        f[76] = lighting.ambientColor.r;
        f[77] = lighting.ambientColor.g;
        f[78] = lighting.ambientColor.b;
        f[79] = lighting.ambientIntensity;

        f[80] = d.metallicScale;
        f[81] = d.metallicMax;
        f[82] = d.roughnessScale;
        f[83] = d.roughnessMin;

        f[84] = d.roughnessMax;
        f[85] = d.specularStrength;
        f[86] = d.ambientStrength;
        f[87] = d.sunStrength;

        f[88] = d.localLightStrength;
        f[89] = d.decodeEmissiveSRGB;
        f[90] = d.shadowStrength;
        f[91] = d.bloomWeight;
        f[92] = d.bloomSourceScale;
        f[93] = lighting.planetCenter.x;
        f[94] = lighting.planetCenter.y;
        f[95] = lighting.planetCenter.z;
    }

    _packShadowUbo(model) {
        this._tmpShadowUbo.set(model.elements);
    }

    _createMaterialBindGroup(matDef, imageMap, asset) {
        const resolve = (texIdx) => {
            if (texIdx < 0 || !asset.textures) return { view: this._whiteTextureView, has: 0 };
            const td = asset.textures[texIdx];
            if (!td) return { view: this._whiteTextureView, has: 0 };
            const e = imageMap.get(td.imageIndex);
            return e ? { view: e.view, has: 1 } : { view: this._whiteTextureView, has: 0 };
        };

        const base = resolve(matDef?.baseColorTextureIndex ?? -1);
        const normal = resolve(matDef?.normalTextureIndex ?? -1);
        const mr = resolve(matDef?.metallicRoughnessTexture ?? -1);
        const emis = resolve(matDef?.emissiveTextureIndex ?? -1);
        const occ = resolve(matDef?.occlusionTextureIndex ?? -1);

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
            hasBase: base.has,
            hasNormal: normal.has,
            hasMR: mr.has,
            hasEmis: emis.has,
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
                const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
                const tex = this.device.createTexture({
                    label: img.name || `glTFImage_${i}`,
                    size: [bmp.width, bmp.height],
                    format: 'rgba8unorm',
                    usage: GPUTextureUsage.TEXTURE_BINDING |
                           GPUTextureUsage.COPY_DST |
                           GPUTextureUsage.RENDER_ATTACHMENT,
                });
                this.device.queue.copyExternalImageToTexture(
                    { source: bmp },
                    { texture: tex },
                    { width: bmp.width, height: bmp.height, depthOrArrayLayers: 1 }
                );
                bmp.close();
                map.set(i, { texture: tex, view: tex.createView() });
                Logger.info(
                    `[SkinnedMeshRenderer] decoded image[${i}] "${img.name}" ` +
                    `${bmp.width}×${bmp.height}`
                );
            } catch (e) {
                Logger.warn(`[SkinnedMeshRenderer] image[${i}] decode failed: ${e.message}`);
            }
        }
        return map;
    }

    _ensureLightingBindGroup() {
        const clusterBuffers = this._clusterLightBuffers;
        const shadowRenderer = this._shadowRenderer;
        const key = `${clusterBuffers ? 'cluster' : 'dummy'}_${shadowRenderer ? 'shadow' : 'noshadow'}`;
        if (this._lightingBindGroup && this._lightingBindGroupKey === key) return;

        const dummyStorage = this._getOrCreateDummyStorageBuffer();
        const dummyUniform = this._getOrCreateDummyUniformBuffer();
        const dummyDepthView = this._getOrCreateDummyDepthTextureView();

        const lightBuf = clusterBuffers?.lightBuffer || dummyStorage;
        const clusterBuf = clusterBuffers?.clusterBuffer || dummyStorage;
        const indexBuf = clusterBuffers?.lightIndexBuffer || dummyStorage;
        const paramBuf = clusterBuffers?.paramBuffer || dummyUniform;

        const shadowCascade0 = shadowRenderer?.getShadowDepthView?.(0) || dummyDepthView;
        const shadowCascade1 = shadowRenderer?.getShadowDepthView?.(1) || dummyDepthView;
        const shadowCascade2 = shadowRenderer?.getShadowDepthView?.(2) || dummyDepthView;
        const shadowSampler = shadowRenderer?.getComparisonSampler?.() || this._getOrCreateDefaultComparisonSampler();
        const shadowUniformBuf = shadowRenderer?.getCascadeUniformBuffer?.() || dummyUniform;

        this._lightingBindGroup = this.device.createBindGroup({
            layout: this._lightingBGL,
            entries: [
                { binding: 0, resource: { buffer: lightBuf } },
                { binding: 1, resource: { buffer: clusterBuf } },
                { binding: 2, resource: { buffer: indexBuf } },
                { binding: 3, resource: { buffer: paramBuf } },
                { binding: 4, resource: shadowCascade0 },
                { binding: 5, resource: shadowCascade1 },
                { binding: 6, resource: shadowCascade2 },
                { binding: 7, resource: shadowSampler },
                { binding: 8, resource: { buffer: shadowUniformBuf } },
            ],
        });
        this._lightingBindGroupKey = key;
    }

    _ensureShadowCascadeBindGroups(shadowRenderer) {
        if (!shadowRenderer) return;
        if (this._shadowCascadeBindGroupsRenderer === shadowRenderer && this._shadowCascadeBindGroups.length === SHADOW_CASCADE_COUNT) {
            return;
        }

        this._shadowCascadeBindGroups = [];
        for (let cascade = 0; cascade < SHADOW_CASCADE_COUNT; cascade++) {
            this._tmpShadowSelect.fill(0);
            this._tmpShadowSelect[0] = cascade;
            this.device.queue.writeBuffer(
                this._shadowCascadeSelectBuffers[cascade],
                0,
                this._tmpShadowSelect
            );

            this._shadowCascadeBindGroups.push(this.device.createBindGroup({
                layout: this._shadowCascadeBGL,
                entries: [
                    { binding: 0, resource: { buffer: this._shadowCascadeSelectBuffers[cascade] } },
                    { binding: 1, resource: { buffer: shadowRenderer.getCascadeUniformBuffer() } },
                ],
            }));
        }
        this._shadowCascadeBindGroupsRenderer = shadowRenderer;
    }

    _getLightingState() {
        const uniforms = this.uniformManager?.uniforms;
        const sunDirection = uniforms?.sunLightDirection?.value || this._fallbackSun;
        const sunColor = uniforms?.sunLightColor?.value || { r: 1, g: 1, b: 1 };
        const ambientColor = uniforms?.ambientLightColor?.value || { r: 0.6, g: 0.65, b: 0.7 };

        return {
            sunDirection,
            sunColor,
            sunIntensity: finiteOr(uniforms?.sunLightIntensity?.value, 1.0),
            ambientColor,
            ambientIntensity: finiteOr(uniforms?.ambientLightIntensity?.value, 0.8),
            planetCenter: uniforms?.planetCenter?.value || { x: 0, y: 0, z: 0 },
        };
    }

    _resolveMaterialTuning(options = {}) {
        const source =
            options.materialTuning ||
            options.rendering?.materialTuning ||
            options.modelDescriptor?.rendering?.materialTuning ||
            {};

        return {
            decodeBaseColorSRGB: boolOr(source.decodeBaseColorSRGB, DEFAULT_MATERIAL_TUNING.decodeBaseColorSRGB),
            decodeEmissiveSRGB: boolOr(source.decodeEmissiveSRGB, DEFAULT_MATERIAL_TUNING.decodeEmissiveSRGB),
            metallicScale: clampNumber(source.metallicScale, DEFAULT_MATERIAL_TUNING.metallicScale, 0, 1),
            metallicMax: clampNumber(source.metallicMax, DEFAULT_MATERIAL_TUNING.metallicMax, 0, 1),
            roughnessScale: clampNumber(source.roughnessScale, DEFAULT_MATERIAL_TUNING.roughnessScale, 0, 4),
            roughnessMin: clampNumber(source.roughnessMin, DEFAULT_MATERIAL_TUNING.roughnessMin, 0.04, 1),
            roughnessMax: clampNumber(source.roughnessMax, DEFAULT_MATERIAL_TUNING.roughnessMax, 0.04, 1),
            specularStrength: clampNumber(source.specularStrength, DEFAULT_MATERIAL_TUNING.specularStrength, 0, 4),
            ambientStrength: clampNumber(source.ambientStrength, DEFAULT_MATERIAL_TUNING.ambientStrength, 0, 4),
            sunStrength: clampNumber(source.sunStrength, DEFAULT_MATERIAL_TUNING.sunStrength, 0, 4),
            localLightStrength: clampNumber(source.localLightStrength, DEFAULT_MATERIAL_TUNING.localLightStrength, 0, 4),
            normalScaleMultiplier: clampNumber(source.normalScaleMultiplier, DEFAULT_MATERIAL_TUNING.normalScaleMultiplier, 0, 4),
        };
    }

    _resolveShadowTuning(options = {}) {
        const source =
            options.shadows ||
            options.rendering?.shadows ||
            options.modelDescriptor?.rendering?.shadows ||
            {};

        return {
            castCascaded: boolOr(source.castCascaded, DEFAULT_SHADOW_TUNING.castCascaded),
            receiveCascaded: boolOr(source.receiveCascaded, DEFAULT_SHADOW_TUNING.receiveCascaded),
            shadowStrength: clampNumber(source.shadowStrength, DEFAULT_SHADOW_TUNING.shadowStrength, 0, 1),
        };
    }

    _resolveBloomTuning(options = {}) {
        const source =
            options.bloom ||
            options.rendering?.bloom ||
            options.modelDescriptor?.rendering?.bloom ||
            {};

        const enabled = boolOr(source.enabled, DEFAULT_BLOOM_TUNING.enabled);
        const bloomWeight = clampNumber(
            source.bloomWeight ?? source.weight,
            DEFAULT_BLOOM_TUNING.bloomWeight,
            0,
            16
        );
        const sourceScale = clampNumber(
            source.sourceScale ?? source.strength ?? source.sourceStrength,
            DEFAULT_BLOOM_TUNING.sourceScale,
            0,
            32
        );

        return {
            bloomWeight: enabled ? bloomWeight : 0,
            sourceScale: enabled ? sourceScale : 0,
        };
    }

    _getOrCreateDummyStorageBuffer() {
        if (!this._dummyStorageBuffer) {
            this._dummyStorageBuffer = this.device.createBuffer({
                label: 'SMR-DummyStorage',
                size: 256,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
        }
        return this._dummyStorageBuffer;
    }

    _getOrCreateDummyUniformBuffer() {
        if (!this._dummyUniformBuffer) {
            this._dummyUniformBuffer = this.device.createBuffer({
                label: 'SMR-DummyUniform',
                size: 256,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }
        return this._dummyUniformBuffer;
    }

    _getOrCreateDummyDepthTextureView() {
        if (!this._dummyDepthTextureView) {
            this._dummyDepthTexture = this.device.createTexture({
                label: 'SMR-DummyShadowDepth',
                size: [1, 1],
                format: 'depth32float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this._dummyDepthTextureView = this._dummyDepthTexture.createView();
        }
        return this._dummyDepthTextureView;
    }

    _getOrCreateDefaultComparisonSampler() {
        if (!this._shadowCompareSampler) {
            this._shadowCompareSampler = this.device.createSampler({
                compare: 'less',
                magFilter: 'linear',
                minFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
            });
        }
        return this._shadowCompareSampler;
    }

    _buildPipeline() {
        const dev = this.device;

        const code = /* wgsl */`
struct U {
    model: mat4x4<f32>,
    view: mat4x4<f32>,
    proj: mat4x4<f32>,
    baseColor: vec4<f32>,
    sunMetallic: vec4<f32>,
    cameraRoughness: vec4<f32>,
    emissiveNormalScale: vec4<f32>,
    texFlags: vec4<f32>,
    texFlags2: vec4<f32>,
    sunColorIntensity: vec4<f32>,
    ambientColorIntensity: vec4<f32>,
    materialTuning0: vec4<f32>,
    materialTuning1: vec4<f32>,
    materialTuning2: vec4<f32>,
    materialTuning3: vec4<f32>,
};

struct ClLight {
    position: vec3<f32>,
    radius: f32,
    color: vec3<f32>,
    intensity: f32,
    direction: vec3<f32>,
    lightType: f32,
    angle: f32,
    penumbra: f32,
    decay: f32,
    castShadow: f32,
}

struct ClCluster {
    lightCount: u32,
    lightOffset: u32,
    _pad0: u32,
    _pad1: u32,
}

struct ClParams {
    dims: vec3<f32>,
    numLights: f32,
    near: f32,
    far: f32,
    maxPerCluster: f32,
    _pad0: f32,
    invTanHalfFovX: f32,
    invTanHalfFovY: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32,
    _pad4: f32,
    _pad5: f32,
    _pad6: f32,
    _pad7: f32,
    _pad8: f32,
}

struct ShadowUniforms {
    cascadeVP0: mat4x4<f32>,
    cascadeVP1: mat4x4<f32>,
    cascadeVP2: mat4x4<f32>,
    splits: vec4<f32>,
    params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> u: U;

@group(1) @binding(0) var tBase: texture_2d<f32>;
@group(1) @binding(1) var tNormal: texture_2d<f32>;
@group(1) @binding(2) var tMR: texture_2d<f32>;
@group(1) @binding(3) var tEmis: texture_2d<f32>;
@group(1) @binding(4) var tOcc: texture_2d<f32>;
@group(1) @binding(5) var samp: sampler;

@group(2) @binding(0) var<storage, read> jointMats: array<mat4x4<f32>>;

@group(3) @binding(0) var<storage, read> clLights: array<ClLight>;
@group(3) @binding(1) var<storage, read> clClusters: array<ClCluster>;
@group(3) @binding(2) var<storage, read> clIndices: array<u32>;
@group(3) @binding(3) var<uniform> clParams: ClParams;
@group(3) @binding(4) var shadowCascade0: texture_depth_2d;
@group(3) @binding(5) var shadowCascade1: texture_depth_2d;
@group(3) @binding(6) var shadowCascade2: texture_depth_2d;
@group(3) @binding(7) var shadowCompSampler: sampler_comparison;
@group(3) @binding(8) var<uniform> shadowUniforms: ShadowUniforms;

struct VSOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) wnrm: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) wpos: vec3<f32>,
}

struct StaticIn {
    @location(0) pos: vec3<f32>,
    @location(1) nrm: vec3<f32>,
    @location(2) uv: vec2<f32>,
}

struct SkinnedIn {
    @location(0) pos: vec3<f32>,
    @location(1) nrm: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) joints: vec4<u32>,
    @location(4) weights: vec4<f32>,
}

fn xform(pos: vec4<f32>, nrm: vec3<f32>, uv: vec2<f32>) -> VSOut {
    var o: VSOut;
    let wp = u.model * pos;
    o.wpos = wp.xyz;
    o.clip = u.proj * u.view * wp;
    let nm = mat3x3<f32>(u.model[0].xyz, u.model[1].xyz, u.model[2].xyz);
    o.wnrm = normalize(nm * nrm);
    o.uv = uv;
    return o;
}

@vertex
fn vs_static(i: StaticIn) -> VSOut {
    return xform(vec4<f32>(i.pos, 1.0), i.nrm, i.uv);
}

@vertex
fn vs_skinned(i: SkinnedIn) -> VSOut {
    let j = i.joints;
    let w = i.weights;
    let skin = w.x * jointMats[j.x] + w.y * jointMats[j.y]
             + w.z * jointMats[j.z] + w.w * jointMats[j.w];
    let sp = skin * vec4<f32>(i.pos, 1.0);
    let sn = normalize((skin * vec4<f32>(i.nrm, 0.0)).xyz);
    return xform(sp, sn, i.uv);
}

const PI = 3.14159265;

fn decodeSRGB(color: vec3<f32>, enabled: f32) -> vec3<f32> {
    if (enabled > 0.5) {
        return pow(max(color, vec3<f32>(0.0, 0.0, 0.0)), vec3<f32>(2.2, 2.2, 2.2));
    }
    return color;
}

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
    let dp1 = dpdx(p);
    let dp2 = dpdy(p);
    let duv1 = dpdx(uv);
    let duv2 = dpdy(uv);
    let det = duv1.x * duv2.y - duv1.y * duv2.x;
    if (abs(det) < 1e-8) {
        return mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), N);
    }
    let inv = 1.0 / det;
    var T = normalize((dp1 * duv2.y - dp2 * duv1.y) * inv);
    T = normalize(T - N * dot(N, T));
    let B = cross(N, T);
    return mat3x3<f32>(T, B, N);
}

fn cl_getClusterIndex(vp: vec3<f32>) -> i32 {
    let vz = -vp.z;
    if (vz <= 0.0 || vz >= clParams.far) { return -1; }
    let lr = log(max(vz, clParams.near) / clParams.near) / log(clParams.far / clParams.near);
    let iz = u32(clamp(lr * clParams.dims.z, 0.0, clParams.dims.z - 1.0));
    let nx = clamp(vp.x / (-vp.z) * clParams.invTanHalfFovX, -1.0, 1.0);
    let ny = clamp(vp.y / (-vp.z) * clParams.invTanHalfFovY, -1.0, 1.0);
    let ix = u32(clamp((nx * 0.5 + 0.5) * clParams.dims.x, 0.0, clParams.dims.x - 1.0));
    let iy = u32(clamp((ny * 0.5 + 0.5) * clParams.dims.y, 0.0, clParams.dims.y - 1.0));
    return i32(iz * u32(clParams.dims.x * clParams.dims.y) + iy * u32(clParams.dims.x) + ix);
}

fn cl_point(L: ClLight, wp: vec3<f32>, N: vec3<f32>, a: vec3<f32>) -> vec3<f32> {
    let tl = L.position - wp;
    let d2 = dot(tl, tl);
    if (d2 > L.radius * L.radius) { return vec3<f32>(0.0, 0.0, 0.0); }
    let d = sqrt(d2);
    let ld = tl / max(d, 0.0001);
    let nl = max(dot(N, ld), 0.0);
    var at = 1.0 / (1.0 + L.decay * d2);
    let fd = L.radius * 0.8;
    if (d > fd) {
        at *= 1.0 - smoothstep(fd, L.radius, d);
    }
    return a * L.color * L.intensity * nl * at;
}

fn cl_spot(L: ClLight, wp: vec3<f32>, N: vec3<f32>, a: vec3<f32>) -> vec3<f32> {
    let tl = L.position - wp;
    let d = length(tl);
    if (d > L.radius) { return vec3<f32>(0.0, 0.0, 0.0); }
    let ld = tl / max(d, 0.0001);
    let ca = dot(-ld, normalize(L.direction));
    let oc = cos(L.angle);
    if (ca < oc) { return vec3<f32>(0.0, 0.0, 0.0); }
    let ic = cos(L.angle * (1.0 - L.penumbra));
    let sp = smoothstep(oc, ic, ca);
    let nl = max(dot(N, ld), 0.0);
    var at = 1.0 / (1.0 + L.decay * d * d);
    at *= 1.0 - smoothstep(L.radius * 0.75, L.radius, d);
    return a * L.color * L.intensity * nl * at * sp;
}

fn evalClustered(wp: vec3<f32>, vp: vec3<f32>, n: vec3<f32>, a: vec3<f32>) -> vec3<f32> {
    var total = vec3<f32>(0.0, 0.0, 0.0);
    if (clParams.numLights < 0.5) { return total; }
    let ci = cl_getClusterIndex(vp);
    if (ci < 0) { return total; }
    let cl = clClusters[u32(ci)];
    let cnt = min(cl.lightCount, u32(clParams.maxPerCluster));
    for (var i = 0u; i < cnt; i++) {
        let li = clIndices[cl.lightOffset + i];
        if (li >= u32(clParams.numLights)) { continue; }
        let L = clLights[li];
        if (L.lightType < 0.5) {
        } else if (L.lightType < 1.5) {
            total += cl_point(L, wp, n, a);
        } else if (L.lightType < 2.5) {
            total += cl_spot(L, wp, n, a);
        }
    }
    return total;
}

fn samplePCF9(cascade: i32, uv: vec2<f32>, cmp: f32, texelSize: f32) -> f32 {
    let offsets = array<vec2<f32>, 9>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(0.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );
    let weights = array<f32, 9>(
        0.25,
        0.0625, 0.125, 0.0625,
        0.125, 0.125,
        0.0625, 0.125, 0.0625
    );
    var s0 = 0.0;
    var s1 = 0.0;
    var s2 = 0.0;
    for (var i = 0u; i < 9u; i++) {
        let su = uv + offsets[i] * texelSize;
        let wi = weights[i];
        s0 += textureSampleCompare(shadowCascade0, shadowCompSampler, su, cmp) * wi;
        s1 += textureSampleCompare(shadowCascade1, shadowCompSampler, su, cmp) * wi;
        s2 += textureSampleCompare(shadowCascade2, shadowCompSampler, su, cmp) * wi;
    }
    return select(select(s2, s1, cascade == 1), s0, cascade == 0);
}

fn computeShadow(wp: vec3<f32>, vp: vec3<f32>, n: vec3<f32>) -> f32 {
    if (shadowUniforms.params.w < 0.5 || u.materialTuning2.z <= 0.001) {
        return 1.0;
    }
    let vz = -vp.z;
    let bias = shadowUniforms.params.x;
    let normalBias = shadowUniforms.params.y;
    let mapSize = shadowUniforms.params.z;
    var ci: i32 = 2;
    if (vz < shadowUniforms.splits.x) {
        ci = 0;
    } else if (vz < shadowUniforms.splits.y) {
        ci = 1;
    }
    var m = shadowUniforms.cascadeVP2;
    if (ci == 0) {
        m = shadowUniforms.cascadeVP0;
    } else if (ci == 1) {
        m = shadowUniforms.cascadeVP1;
    }
    let bp = wp + n * normalBias;
    let cl = m * vec4<f32>(bp, 1.0);
    let w = max(abs(cl.w), 0.0001);
    let ndc = cl.xyz / w;
    let uvRaw = ndc.xy * 0.5 + 0.5;
    let uv = vec2<f32>(uvRaw.x, 1.0 - uvRaw.y);
    let compareDepth = ndc.z - bias;
    let oob = uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0;
    let raw = select(samplePCF9(ci, uv, compareDepth, 1.0 / mapSize), 1.0, oob);
    return mix(1.0, raw, u.materialTuning2.z);
}

fn computeLocalDayVisibility(wp: vec3<f32>, sunDir: vec3<f32>) -> f32 {
    let rel = wp - u.materialTuning3.yzw;
    let lenSq = dot(rel, rel);
    if (lenSq < 1e-8) {
        return 1.0;
    }

    let localUp = normalize(rel);
    let sunDotUp = dot(localUp, sunDir);
    return smoothstep(-0.14, 0.04, sunDotUp);
}

@fragment
fn fs(i: VSOut, @builtin(front_facing) ff: bool) -> @location(0) vec4<f32> {
    var albedo = u.baseColor;
    if (u.texFlags.x > 0.5) {
        let tc = textureSample(tBase, samp, i.uv);
        let baseRgb = decodeSRGB(tc.rgb, u.texFlags2.w);
        albedo = vec4<f32>(albedo.rgb * baseRgb, albedo.a * tc.a);
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
        let sn = vec3<f32>(tn.xy * u.emissiveNormalScale.w, tn.z);
        let TBN = cotangentFrame(N, i.wpos, i.uv);
        N = normalize(TBN * sn);
    }

    var metallic = u.sunMetallic.w;
    var roughness = u.cameraRoughness.w;
    if (u.texFlags.z > 0.5) {
        let mr = textureSample(tMR, samp, i.uv);
        roughness *= mr.g;
        metallic *= mr.b;
    }
    metallic = clamp(metallic * u.materialTuning0.x, 0.0, u.materialTuning0.y);
    roughness = clamp(
        roughness * u.materialTuning0.z,
        u.materialTuning0.w,
        u.materialTuning1.x
    );

    var ao = 1.0;
    if (u.texFlags2.x > 0.5) {
        ao = mix(1.0, textureSample(tOcc, samp, i.uv).r, u.texFlags2.y);
    }

    let viewPos = (u.view * vec4<f32>(i.wpos, 1.0)).xyz;
    let V = normalize(u.cameraRoughness.xyz - i.wpos);
    let L = normalize(u.sunMetallic.xyz);
    let dayVisibility = computeLocalDayVisibility(i.wpos, L);
    let H = normalize(V + L);
    let NdL = max(dot(N, L), 0.0);
    let NdV = max(dot(N, V), 0.001);
    let NdH = max(dot(N, H), 0.0);
    let VdH = max(dot(V, H), 0.0);

    let F0 = mix(vec3<f32>(0.04, 0.04, 0.04), albedo.rgb, metallic);
    let F = fresnelSchlick(VdH, F0);

    let a = roughness * roughness;
    let a2 = a * a;
    let D = distributionGGX(NdH, a2);
    let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    let G = geometrySmith(NdV, NdL, k);

    let spec = ((D * G * F) / (4.0 * NdV * NdL + 0.001)) * u.materialTuning1.y;
    let kD = (1.0 - F) * (1.0 - metallic);
    let diffuse = kD * albedo.rgb / PI;

    let shadowF = computeShadow(i.wpos, viewPos, N);
    let sunRadiance = u.sunColorIntensity.rgb * u.sunColorIntensity.w * u.materialTuning1.w;
    let direct = (diffuse + spec) * NdL * shadowF * sunRadiance * dayVisibility;

    let hemi = mix(0.55, 1.0, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
    let ambientNightScale = mix(0.3, 1.0, dayVisibility);
    let ambient = albedo.rgb * ao
        * u.ambientColorIntensity.rgb
        * (u.ambientColorIntensity.w * hemi * u.materialTuning1.z * ambientNightScale);

    let localLights = evalClustered(i.wpos, viewPos, N, albedo.rgb) * u.materialTuning2.x;

    var color = ambient + direct + localLights;

    var emis = u.emissiveNormalScale.xyz;
    if (u.texFlags.w > 0.5) {
        let eTex = textureSample(tEmis, samp, i.uv).rgb;
        emis *= decodeSRGB(eTex, u.materialTuning2.y);
    }
    color += emis;

    return vec4<f32>(color, albedo.a);
}

@fragment
fn fs_bloom(i: VSOut) -> @location(0) vec4<f32> {
    var alpha = u.baseColor.a;
    if (u.texFlags.x > 0.5) {
        let tc = textureSample(tBase, samp, i.uv);
        alpha = alpha * tc.a;
    }

    let cutoff = u.texFlags2.z;
    if (cutoff > 0.0) {
        let fw = fwidth(alpha) * 0.5;
        if (alpha < cutoff - fw) { discard; }
    }

    var emis = u.emissiveNormalScale.xyz;
    if (u.texFlags.w > 0.5) {
        let eTex = textureSample(tEmis, samp, i.uv).rgb;
        emis *= decodeSRGB(eTex, u.materialTuning2.y);
    }

    let bloom = emis * u.materialTuning2.w * u.materialTuning3.x;
    if (max(max(bloom.r, bloom.g), bloom.b) <= 1e-5) {
        discard;
    }

    return vec4<f32>(bloom, alpha);
}`;

        const shadowCode = /* wgsl */`
struct ShadowDrawU {
    model: mat4x4<f32>,
}

struct ShadowCascadeSelect {
    cascadeIndex: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

struct ShadowUniforms {
    cascadeVP0: mat4x4<f32>,
    cascadeVP1: mat4x4<f32>,
    cascadeVP2: mat4x4<f32>,
    splits: vec4<f32>,
    params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> drawU: ShadowDrawU;
@group(1) @binding(0) var<uniform> shadowSelect: ShadowCascadeSelect;
@group(1) @binding(1) var<storage, read> shadowUniforms: ShadowUniforms;
@group(2) @binding(0) var<storage, read> jointMats: array<mat4x4<f32>>;

struct VSOut {
    @builtin(position) clip: vec4<f32>,
}

struct StaticIn {
    @location(0) pos: vec3<f32>,
    @location(1) _nrm: vec3<f32>,
    @location(2) _uv: vec2<f32>,
}

struct SkinnedIn {
    @location(0) pos: vec3<f32>,
    @location(1) _nrm: vec3<f32>,
    @location(2) _uv: vec2<f32>,
    @location(3) joints: vec4<u32>,
    @location(4) weights: vec4<f32>,
}

fn getCascadeVP(idx: u32) -> mat4x4<f32> {
    switch (idx) {
        case 0u { return shadowUniforms.cascadeVP0; }
        case 1u { return shadowUniforms.cascadeVP1; }
        case 2u { return shadowUniforms.cascadeVP2; }
        default { return shadowUniforms.cascadeVP0; }
    }
}

fn xform(pos: vec4<f32>) -> VSOut {
    var out: VSOut;
    let worldPos = drawU.model * pos;
    out.clip = getCascadeVP(shadowSelect.cascadeIndex) * worldPos;
    return out;
}

@vertex
fn vs_static(i: StaticIn) -> VSOut {
    return xform(vec4<f32>(i.pos, 1.0));
}

@vertex
fn vs_skinned(i: SkinnedIn) -> VSOut {
    let j = i.joints;
    let w = i.weights;
    let skin = w.x * jointMats[j.x] + w.y * jointMats[j.y]
             + w.z * jointMats[j.z] + w.w * jointMats[j.w];
    return xform(skin * vec4<f32>(i.pos, 1.0));
}

@fragment
fn fs() {}
`;

        const module = dev.createShaderModule({ label: 'SkinnedMesh-PBR', code });
        const shadowModule = dev.createShaderModule({ label: 'SkinnedMesh-Shadow', code: shadowCode });

        this._uboBGL = dev.createBindGroupLayout({
            label: 'SMR-UBO',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        });

        this._texBGL = dev.createBindGroupLayout({
            label: 'SMR-Tex',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            ],
        });

        this._jointBGL = dev.createBindGroupLayout({
            label: 'SMR-Joints',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'read-only-storage' },
            }],
        });

        this._lightingBGL = dev.createBindGroupLayout({
            label: 'SMR-LightingShadow',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
                { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
                { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        this._shadowDrawBGL = dev.createBindGroupLayout({
            label: 'SMR-ShadowDraw',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
            }],
        });

        this._shadowCascadeBGL = dev.createBindGroupLayout({
            label: 'SMR-ShadowCascade',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            ],
        });

        for (let i = 0; i < SHADOW_CASCADE_COUNT; i++) {
            this._shadowCascadeSelectBuffers.push(dev.createBuffer({
                label: `SMR-ShadowCascadeSelect-${i}`,
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }));
        }

        const pLayout = dev.createPipelineLayout({
            bindGroupLayouts: [this._uboBGL, this._texBGL, this._jointBGL, this._lightingBGL],
        });
        const bloomLayout = dev.createPipelineLayout({
            bindGroupLayouts: [this._uboBGL, this._texBGL, this._jointBGL],
        });
        const shadowLayout = dev.createPipelineLayout({
            bindGroupLayouts: [this._shadowDrawBGL, this._shadowCascadeBGL, this._jointBGL],
        });

        const staticBufs = [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
            { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
        ];
        const skinnedBufs = [
            ...staticBufs,
            { arrayStride: 8, attributes: [{ shaderLocation: 3, offset: 0, format: 'uint16x4' }] },
            { arrayStride: 16, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }] },
        ];

        const frag = {
            module,
            entryPoint: 'fs',
            targets: [{ format: this.backend.sceneFormat || this.backend.format }],
        };
        const depth = {
            format: 'depth24plus',
            depthWriteEnabled: true,
            depthCompare: 'less',
        };
        const bloomDepth = {
            format: 'depth24plus',
            depthWriteEnabled: false,
            depthCompare: 'less-equal',
        };
        const shadowDepth = {
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'less',
        };

        const mk = (ep, bufs, cull) => dev.createRenderPipeline({
            label: `SMR-${ep}-${cull}`,
            layout: pLayout,
            vertex: { module, entryPoint: ep, buffers: bufs },
            fragment: frag,
            primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
            depthStencil: depth,
        });
        const mkBloom = (ep, bufs, cull) => dev.createRenderPipeline({
            label: `SMR-Bloom-${ep}-${cull}`,
            layout: bloomLayout,
            vertex: { module, entryPoint: ep, buffers: bufs },
            fragment: {
                module,
                entryPoint: 'fs_bloom',
                targets: [{ format: this.backend.sceneFormat || this.backend.format }],
            },
            primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
            depthStencil: bloomDepth,
        });
        const mkShadow = (ep, bufs, cull) => dev.createRenderPipeline({
            label: `SMR-Shadow-${ep}-${cull}`,
            layout: shadowLayout,
            vertex: { module: shadowModule, entryPoint: ep, buffers: bufs },
            fragment: { module: shadowModule, entryPoint: 'fs', targets: [] },
            primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
            depthStencil: shadowDepth,
        });

        this._pipelineCull = mk('vs_static', staticBufs, 'back');
        this._pipelineNoCull = mk('vs_static', staticBufs, 'none');
        this._pipelineSkinCull = mk('vs_skinned', skinnedBufs, 'back');
        this._pipelineSkinNoCull = mk('vs_skinned', skinnedBufs, 'none');
        this._pipelineBloomCull = mkBloom('vs_static', staticBufs, 'back');
        this._pipelineBloomNoCull = mkBloom('vs_static', staticBufs, 'none');
        this._pipelineBloomSkinCull = mkBloom('vs_skinned', skinnedBufs, 'back');
        this._pipelineBloomSkinNoCull = mkBloom('vs_skinned', skinnedBufs, 'none');

        this._shadowPipelineCull = mkShadow('vs_static', staticBufs, 'back');
        this._shadowPipelineNoCull = mkShadow('vs_static', staticBufs, 'none');
        this._shadowPipelineSkinCull = mkShadow('vs_skinned', skinnedBufs, 'back');
        this._shadowPipelineSkinNoCull = mkShadow('vs_skinned', skinnedBufs, 'none');

        this._dummyJointBuf = dev.createBuffer({
            size: 64,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        dev.queue.writeBuffer(this._dummyJointBuf, 0,
            new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
        this._dummyJointBG = dev.createBindGroup({
            layout: this._jointBGL,
            entries: [{ binding: 0, resource: { buffer: this._dummyJointBuf } }],
        });

        this._whiteTexture = dev.createTexture({
            size: [1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        dev.queue.writeTexture(
            { texture: this._whiteTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 },
            { width: 1, height: 1, depthOrArrayLayers: 1 }
        );
        this._whiteTextureView = this._whiteTexture.createView();

        this._linearSampler = dev.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
        });
    }
}
