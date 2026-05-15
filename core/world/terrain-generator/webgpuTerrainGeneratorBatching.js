import { Logger } from '../../../shared/Logger.js';
import { requireNumber, requireObject } from './webgpuTerrainGeneratorDebugUtils.js';

const SPLAT_STEP_PREFIX = '[TerrainStep] [SplatStep]';

export function installWebGPUTerrainGeneratorBatchMethods(WebGPUTerrainGenerator) {
    Object.defineProperties(
        WebGPUTerrainGenerator.prototype,
        Object.getOwnPropertyDescriptors({
        _runBatchedLODTerrainPasses({
                gpuHeightBase, gpuHeight, gpuNormal, gpuTile, gpuMacro,
                gpuSmoothSplatData = null, gpuSmoothSplatIndex = null,
                chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize,
                face, textureSize,
                formats = {}
            }) {
                if (this._lodPassLogCount === undefined) this._lodPassLogCount = 0;
                if (this._lodPassLogCount < 3) {
                    this._lodPassLogCount++;
                    const u = this._getTerrainShaderUniforms();
                    console.log(
                        `[TerrainDebug] _runBatchedLODTerrainPasses: ` +
                        `chunkSizeTex=${chunkSizeTex}, chunkGridSize=${chunkGridSize}, ` +
                        `textureSize=${textureSize}, face=${face}, ` +
                        `chunkCoord=(${chunkCoordX},${chunkCoordY})`
                    );
                    console.log(
                        `[TerrainDebug] noiseProfileA=${JSON.stringify(u.noiseProfileA)}, ` +
                        `noiseRefRadius=${this.noiseReferenceRadiusM}, ` +
                        `worldScale=${this.worldScale}`
                    );
                }
                if (this._logUniformsOnNextPass) {
                    this._logUniformsOnNextPass = false;
                    const u = this._getTerrainShaderUniforms();
                    console.log(
                        `[TerrainDebug] Uniforms: chunkCoord=(${chunkCoordX},${chunkCoordY}), ` +
                        `chunkSize=${chunkSizeTex}, chunkGridSize=${chunkGridSize}, face=${face}`
                    );
                    console.log(
                        `[TerrainDebug] noiseProfileA=[${u.noiseProfileA}], ` +
                        `noiseProfileB=[${u.noiseProfileB}]`
                    );
                }

                const scratchView = this._fillTerrainUniformScratch(
                    chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize, face
                );

                const fmt = (name) => formats[name] || 'rgba32float';
                const heightFmt = fmt('height');
                const tileFmt   = fmt('tile');

                // heightBase is scratch and now carries stable slope in G — force rgba32float.
                // (The final height texture keeps whatever format the pool wants.)
                const heightBaseFmt = 'rgba32float';

                const passes = [
                    { type: 0, outTex: gpuHeightBase, format: heightBaseFmt },
                    { type: 2, outTex: gpuTile,   format: tileFmt,
                      heightTex: gpuHeightBase, heightFormat: heightBaseFmt },
                    { type: 4, outTex: gpuHeight, format: heightFmt,
                      heightTex: gpuHeightBase, tileTex: gpuTile,
                      heightFormat: heightBaseFmt, tileFormat: tileFmt },
                    { type: 1, outTex: gpuNormal, format: fmt('normal'),
                      heightTex: gpuHeight, heightFormat: heightFmt },
                    { type: 3, outTex: gpuMacro,  format: fmt('macro') }
                ];

                if (gpuSmoothSplatData && gpuSmoothSplatIndex) {
                    passes.push(
                        { type: 7, outTex: gpuSmoothSplatData, format: 'rgba8unorm',
                          heightTex: gpuHeightBase, heightFormat: heightBaseFmt },
                        { type: 8, outTex: gpuSmoothSplatIndex, format: 'rgba8unorm',
                          heightTex: gpuHeightBase, heightFormat: heightBaseFmt }
                    );
                }


                // ── 2. Encode all passes into one command buffer ───────────
                const enc = this.device.createCommandEncoder({
                    label: 'LODTerrainBatch'
                });

                const wgX = Math.ceil(textureSize / 8);
                const wgY = wgX;

                for (let i = 0; i < passes.length; i++) {
                    const p = passes[i];
                    scratchView.setInt32(48, p.type, true);
                    scratchView.setFloat32(64, 0.0, true);
                    scratchView.setFloat32(68, 0.0, true);
                    this.device.queue.writeBuffer(
                        this._batchTerrainUniforms[i],
                        0,
                        this._terrainUniformScratch
                    );

                    const isMicroPass = (p.type === 4 || p.type === 5 || p.type === 6) && p.heightTex && p.tileTex;
                    const isHeightInputPass =
                        !isMicroPass &&
                        (p.type === 1 || p.type === 2 || p.type === 7 || p.type === 8) &&
                        p.heightTex;

                    let pipeline, bindGroupLayout, entries;

                    if (isMicroPass) {
                        ({ pipeline, bindGroupLayout } =
                            this._getMicroPipelineForFormat(
                                p.format,
                                p.heightFormat,
                                p.tileFormat
                            ));
                        entries = [
                            { binding: 0, resource: { buffer: this._batchTerrainUniforms[i] } },
                            { binding: 1, resource: p.outTex.createView() },
                            { binding: 2, resource: p.heightTex.createView() },
                            { binding: 3, resource: p.tileTex.createView() }
                        ];
                    } else if (isHeightInputPass) {
                        ({ pipeline, bindGroupLayout } =
                            this._getHeightInputPipelineForFormat(
                                p.format,
                                p.heightFormat
                            ));
                        entries = [
                            { binding: 0, resource: { buffer: this._batchTerrainUniforms[i] } },
                            { binding: 1, resource: p.outTex.createView() },
                            { binding: 2, resource: p.heightTex.createView() }
                        ];
                    } else {
                        ({ pipeline, bindGroupLayout } =
                            this._getTerrainPipelineForFormat(p.format));
                        entries = [
                            { binding: 0, resource: { buffer: this._batchTerrainUniforms[i] } },
                            { binding: 1, resource: p.outTex.createView() }
                        ];
                    }

                    const pass = enc.beginComputePass();
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: bindGroupLayout,
                        entries
                    }));
                    this._setTerrainBiomeBindGroup(pass);
                    pass.dispatchWorkgroups(wgX, wgY);
                    pass.end();
                }

                // ── 3. Single submit ────────────────────────────────────────
                this.device.queue.submit([enc.finish()]);
            },

        _getTerrainShaderUniforms() {
                const uniforms = requireObject(this.terrainConfig, 'terrainConfig').toShaderUniforms();
                if (!this._continentsEnabled && Array.isArray(uniforms.continentParams)) {
                    uniforms.continentParams[0] = 0.0;
                }
                return uniforms;
            },

        _writeTerrainPaddingUniforms(v, uniforms) {
                const profileA = Array.isArray(uniforms.noiseProfileA) ? uniforms.noiseProfileA : [1.0, 1.0, 1.0, 1.0];
                const profileB = Array.isArray(uniforms.noiseProfileB) ? uniforms.noiseProfileB : [1.0, 1.0, 1.0, 1.0];
                const surfaceParams = Array.isArray(uniforms.surfaceParams) ? uniforms.surfaceParams : [0.05, 0.25, 0.25, 0.60];
                const pA0 = Number.isFinite(profileA[0]) ? profileA[0] : 1.0;
                const pA1 = Number.isFinite(profileA[1]) ? profileA[1] : 1.0;
                const pA2 = Number.isFinite(profileA[2]) ? profileA[2] : 1.0;
                const pA3 = Number.isFinite(profileA[3]) ? profileA[3] : 1.0;
                const pB0 = Number.isFinite(profileB[0]) ? profileB[0] : 1.0;
                const pB1 = Number.isFinite(profileB[1]) ? profileB[1] : 1.0;
                const pB2 = Number.isFinite(profileB[2]) ? profileB[2] : 1.0;
                const pB3 = Number.isFinite(profileB[3]) ? profileB[3] : 1.0;
                const sP0 = Number.isFinite(surfaceParams[0]) ? surfaceParams[0] : 0.05;
                const sP1 = Number.isFinite(surfaceParams[1]) ? surfaceParams[1] : 0.25;
                const sP2 = Number.isFinite(surfaceParams[2]) ? surfaceParams[2] : 0.25;
                const sP3 = Number.isFinite(surfaceParams[3]) ? surfaceParams[3] : 0.60;

                v.setFloat32(176, requireNumber(this.noiseReferenceRadiusM, 'noiseReferenceRadiusM'), true);
                v.setFloat32(180, this._useSmallPlanetMode ? 1.0 : 0.0, true);
                v.setFloat32(184, this.planetConfig?.maxTerrainHeight ?? 2000.0, true);
                v.setFloat32(188, 0.0, true);

                v.setFloat32(192, pA0, true);
                v.setFloat32(196, pA1, true);
                v.setFloat32(200, pA2, true);
                v.setFloat32(204, pA3, true);

                v.setFloat32(208, pB0, true);
                v.setFloat32(212, pB1, true);
                v.setFloat32(216, pB2, true);
                v.setFloat32(220, pB3, true);

                v.setFloat32(224, sP0, true);
                v.setFloat32(228, sP1, true);
                v.setFloat32(232, sP2, true);
                v.setFloat32(236, sP3, true);
            },

        _writeClimateZoneUniforms(v, uniforms) {
                const z0 = Array.isArray(uniforms.climateZone0) ? uniforms.climateZone0 : [0.0, 0.0, 0.0, 0.0];
                const z0e = Array.isArray(uniforms.climateZone0Extra) ? uniforms.climateZone0Extra : [0.0, 0.0, 0.0, 0.0];
                const z1 = Array.isArray(uniforms.climateZone1) ? uniforms.climateZone1 : [0.0, 0.0, 0.0, 0.0];
                const z1e = Array.isArray(uniforms.climateZone1Extra) ? uniforms.climateZone1Extra : [0.0, 0.0, 0.0, 0.0];
                const z2 = Array.isArray(uniforms.climateZone2) ? uniforms.climateZone2 : [0.0, 0.0, 0.0, 0.0];
                const z2e = Array.isArray(uniforms.climateZone2Extra) ? uniforms.climateZone2Extra : [0.0, 0.0, 0.0, 0.0];
                const z3 = Array.isArray(uniforms.climateZone3) ? uniforms.climateZone3 : [0.0, 0.0, 0.0, 0.0];
                const z3e = Array.isArray(uniforms.climateZone3Extra) ? uniforms.climateZone3Extra : [0.0, 0.0, 0.0, 0.0];
                const z4 = Array.isArray(uniforms.climateZone4) ? uniforms.climateZone4 : [0.0, 0.0, 0.0, 0.0];
                const z4e = Array.isArray(uniforms.climateZone4Extra) ? uniforms.climateZone4Extra : [0.0, 0.0, 0.0, 0.0];

                v.setFloat32(240, Number.isFinite(z0[0]) ? z0[0] : 0.0, true);
                v.setFloat32(244, Number.isFinite(z0[1]) ? z0[1] : 0.0, true);
                v.setFloat32(248, Number.isFinite(z0[2]) ? z0[2] : 0.0, true);
                v.setFloat32(252, Number.isFinite(z0[3]) ? z0[3] : 0.0, true);

                v.setFloat32(256, Number.isFinite(z0e[0]) ? z0e[0] : 0.0, true);
                v.setFloat32(260, Number.isFinite(z0e[1]) ? z0e[1] : 0.0, true);
                v.setFloat32(264, Number.isFinite(z0e[2]) ? z0e[2] : 0.0, true);
                v.setFloat32(268, Number.isFinite(z0e[3]) ? z0e[3] : 0.0, true);

                v.setFloat32(272, Number.isFinite(z1[0]) ? z1[0] : 0.0, true);
                v.setFloat32(276, Number.isFinite(z1[1]) ? z1[1] : 0.0, true);
                v.setFloat32(280, Number.isFinite(z1[2]) ? z1[2] : 0.0, true);
                v.setFloat32(284, Number.isFinite(z1[3]) ? z1[3] : 0.0, true);

                v.setFloat32(288, Number.isFinite(z1e[0]) ? z1e[0] : 0.0, true);
                v.setFloat32(292, Number.isFinite(z1e[1]) ? z1e[1] : 0.0, true);
                v.setFloat32(296, Number.isFinite(z1e[2]) ? z1e[2] : 0.0, true);
                v.setFloat32(300, Number.isFinite(z1e[3]) ? z1e[3] : 0.0, true);

                v.setFloat32(304, Number.isFinite(z2[0]) ? z2[0] : 0.0, true);
                v.setFloat32(308, Number.isFinite(z2[1]) ? z2[1] : 0.0, true);
                v.setFloat32(312, Number.isFinite(z2[2]) ? z2[2] : 0.0, true);
                v.setFloat32(316, Number.isFinite(z2[3]) ? z2[3] : 0.0, true);

                v.setFloat32(320, Number.isFinite(z2e[0]) ? z2e[0] : 0.0, true);
                v.setFloat32(324, Number.isFinite(z2e[1]) ? z2e[1] : 0.0, true);
                v.setFloat32(328, Number.isFinite(z2e[2]) ? z2e[2] : 0.0, true);
                v.setFloat32(332, Number.isFinite(z2e[3]) ? z2e[3] : 0.0, true);

                v.setFloat32(336, Number.isFinite(z3[0]) ? z3[0] : 0.0, true);
                v.setFloat32(340, Number.isFinite(z3[1]) ? z3[1] : 0.0, true);
                v.setFloat32(344, Number.isFinite(z3[2]) ? z3[2] : 0.0, true);
                v.setFloat32(348, Number.isFinite(z3[3]) ? z3[3] : 0.0, true);

                v.setFloat32(352, Number.isFinite(z3e[0]) ? z3e[0] : 0.0, true);
                v.setFloat32(356, Number.isFinite(z3e[1]) ? z3e[1] : 0.0, true);
                v.setFloat32(360, Number.isFinite(z3e[2]) ? z3e[2] : 0.0, true);
                v.setFloat32(364, Number.isFinite(z3e[3]) ? z3e[3] : 0.0, true);

                v.setFloat32(368, Number.isFinite(z4[0]) ? z4[0] : 0.0, true);
                v.setFloat32(372, Number.isFinite(z4[1]) ? z4[1] : 0.0, true);
                v.setFloat32(376, Number.isFinite(z4[2]) ? z4[2] : 0.0, true);
                v.setFloat32(380, Number.isFinite(z4[3]) ? z4[3] : 0.0, true);

                v.setFloat32(384, Number.isFinite(z4e[0]) ? z4e[0] : 0.0, true);
                v.setFloat32(388, Number.isFinite(z4e[1]) ? z4e[1] : 0.0, true);
                v.setFloat32(392, Number.isFinite(z4e[2]) ? z4e[2] : 0.0, true);
                v.setFloat32(396, Number.isFinite(z4e[3]) ? z4e[3] : 0.0, true);
            },

        _computeSplatPaddingTexels() {
                const kernelRadius = Math.max(0.5, 0.5 * Math.max(this.splatKernelSize, 1));
                const slotExpansion = Math.max(0.0, this.splatSlotSupportExpansionTexels ?? 0.0);
                return Math.ceil(kernelRadius + slotExpansion) + 1;
            },

        _getSplatPaletteDimensions(innerWidth, innerHeight, chunkSizeTex) {
                const chunkSpan = Math.max(1, chunkSizeTex | 0);
                return {
                    width: Math.max(1, Math.ceil(Math.max(1, innerWidth | 0) / chunkSpan)),
                    height: Math.max(1, Math.ceil(Math.max(1, innerHeight | 0) / chunkSpan))
                };
            },

        _fillTerrainUniformScratch(chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize, face) {
                const buf = this._terrainUniformScratch;
                const v = new DataView(buf);

                v.setInt32(0, chunkCoordX | 0, true);
                v.setInt32(4, chunkCoordY | 0, true);
                v.setInt32(8, chunkSizeTex | 0, true);
                v.setInt32(12, chunkGridSize | 0, true);
                v.setInt32(16, this.seed, true);

                v.setFloat32(20, this.macroConfig.biomeScale, true);
                v.setFloat32(24, this.macroConfig.regionScale, true);
                v.setFloat32(28, this.detailScale, true);
                v.setFloat32(32, this.ridgeScale, true);
                v.setFloat32(36, this.valleyScale, true);
                v.setFloat32(40, this.plateauScale, true);
                v.setFloat32(44, this.worldScale, true);

                // outputType (offset 48) left for caller to patch per pass
                v.setInt32(48, 0, true);
                v.setInt32(52, face !== null && face !== undefined ? (face | 0) : -1, true);

                v.setInt32(56, this.debugMode, true);
                v.setInt32(60, 0, true);
                v.setFloat32(64, 0.0, true);
                v.setFloat32(68, 0.0, true);

                const uniforms = this._getTerrainShaderUniforms();

                v.setFloat32(80, uniforms.continentParams[0], true);
                v.setFloat32(84, uniforms.continentParams[1], true);
                v.setFloat32(88, uniforms.continentParams[2], true);
                v.setFloat32(92, uniforms.continentParams[3], true);

                v.setFloat32(96, uniforms.tectonicParams[0], true);
                v.setFloat32(100, uniforms.tectonicParams[1], true);
                v.setFloat32(104, uniforms.tectonicParams[2], true);
                v.setFloat32(108, uniforms.tectonicParams[3], true);

                v.setFloat32(112, uniforms.waterParams[0], true);
                v.setFloat32(116, uniforms.waterParams[1], true);
                v.setFloat32(120, uniforms.waterParams[2], true);
                v.setFloat32(124, uniforms.waterParams[3], true);

                v.setFloat32(128, uniforms.erosionParams[0], true);
                v.setFloat32(132, uniforms.erosionParams[1], true);
                v.setFloat32(136, uniforms.erosionParams[2], true);
                v.setFloat32(140, uniforms.erosionParams[3], true);

                v.setFloat32(144, uniforms.volcanicParams[0], true);
                v.setFloat32(148, uniforms.volcanicParams[1], true);
                v.setFloat32(152, uniforms.volcanicParams[2], true);
                v.setFloat32(156, uniforms.volcanicParams[3], true);

                v.setFloat32(160, uniforms.climateParams[0], true);
                v.setFloat32(164, uniforms.climateParams[1], true);
                v.setFloat32(168, uniforms.climateParams[2], true);
                v.setFloat32(172, uniforms.climateParams[3], true);

                this._writeTerrainPaddingUniforms(v, uniforms);
                this._writeClimateZoneUniforms(v, uniforms);

                return v;
            },

        _runPaddedQuadtreeSplatPass(
                splatPass, chunkCoordX, chunkCoordY, chunkGridSize, face
            ) {
                const innerSize = Math.max(1, splatPass.textureSize | 0);
                const padding = this._computeSplatPaddingTexels();
                const paddedSize = innerSize + padding * 2;
                const splatIndexTex = splatPass.splatIndexTex;
                const splatValidTex = splatPass.splatValidTex;
                if (!splatIndexTex) {
                    throw new Error('Splat pass requires splatIndexTex for top-4 sparse splat output');
                }
                if (!splatValidTex) {
                    throw new Error('Splat pass requires splatValidTex for bilinear-valid mask output');
                }

                const shouldPrimeSplat = (this._quadtreeSplatPrimeCount ?? 0) < 3;
                const shouldRunProbePasses = (this._quadtreeSplatProbePassCount ?? 0) < 3;
                const shouldCaptureValidationError = shouldRunProbePasses && typeof this.device.pushErrorScope === 'function';
                const splatPrimePattern = [17, 34, 51, 68];
                if (shouldPrimeSplat) {
                    this._quadtreeSplatPrimeCount = (this._quadtreeSplatPrimeCount ?? 0) + 1;
                    this._fillTextureRGBA8Unorm(
                        splatPass.splatTex,
                        innerSize,
                        innerSize,
                        splatPrimePattern
                    );
                    this._fillTextureRGBA8Unorm(
                        splatIndexTex,
                        innerSize,
                        innerSize,
                        [255, 255, 255, 255]
                    );
                    this._fillTextureRGBA8Unorm(
                        splatValidTex,
                        innerSize,
                        innerSize,
                        [0, 0, 0, 255]
                    );
                }

                if (this._quadtreePaddedSplatLogCount === undefined) {
                    this._quadtreePaddedSplatLogCount = 0;
                }
                if (this._quadtreePaddedSplatLogCount < 4) {
                    this._quadtreePaddedSplatLogCount++;
                    Logger.info(
                        `${SPLAT_STEP_PREFIX} [SplatDebug] padded quadtree splat: inner=${innerSize}, ` +
                        `padding=${padding}, padded=${paddedSize}, kernel=${this.splatKernelSize}`
                    );
                }

                const paddedTileMap = this.createGPUTexture(paddedSize, paddedSize, 'rgba8unorm');
                const paddedSmoothSplatData = this.createGPUTexture(paddedSize, paddedSize, 'rgba8unorm');
                const paddedSmoothSplatIndex = this.createGPUTexture(paddedSize, paddedSize, 'rgba8unorm');
                const paletteSize = this._getSplatPaletteDimensions(
                    innerSize,
                    innerSize,
                    splatPass.chunkSizeTex
                );
                const splatPaletteTex = this.createGPUTexture(
                    paletteSize.width,
                    paletteSize.height,
                    'rgba8unorm'
                );
                let debugProbeTextures = null;
                if (shouldRunProbePasses) {
                    this._quadtreeSplatProbePassCount = (this._quadtreeSplatProbePassCount ?? 0) + 1;
                    debugProbeTextures = {
                        constantWrite: this.createGPUTexture(innerSize, innerSize, 'rgba8unorm'),
                        tileEcho: this.createGPUTexture(innerSize, innerSize, 'rgba8unorm'),
                        categoryEcho: this.createGPUTexture(innerSize, innerSize, 'rgba8unorm')
                    };
                }
                // _padTileUniformBuffer is still used by debug probe passes (tileEcho/categoryEcho)
                // when debugProbeTextures is active — keep the write unconditionally as it is cheap.
                const padTileParams = new Uint32Array([
                    padding >>> 0,
                    innerSize >>> 0,
                    innerSize >>> 0,
                    0
                ]);
                this.device.queue.writeBuffer(this._padTileUniformBuffer, 0, padTileParams);

                this._writeSplatUniformBuffer({
                    chunkCoordX,
                    chunkCoordY,
                    chunkSizeTex: splatPass.chunkSizeTex,
                    inputPadding: padding,
                });

                // Build the padded tileMap by running the terrain generation shader over
                // the extended region (innerSize + padding on each side) instead of
                // edge-replicating the tile's own border.  The uvOffset shifts the
                // pixel→faceUV mapping so that pixel `padding` maps to the tile origin
                // and pixels 0..(padding-1) map to the genuine neighbouring tile area.
                const uvShift = -padding / Math.max(innerSize - 1, 1) / Math.max(chunkGridSize, 1);
                this._fillTerrainUniformScratch(chunkCoordX, chunkCoordY, innerSize, chunkGridSize, face);
                {
                    const v = new DataView(this._terrainUniformScratch);
                    v.setInt32(48, 2, true);        // outputType = 2 (tile IDs)
                    v.setFloat32(64, uvShift, true); // uvOffset.x
                    v.setFloat32(68, uvShift, true); // uvOffset.y
                }
                if (!this._paddedTileGenUniformBuffer) {
                    this._paddedTileGenUniformBuffer = this.device.createBuffer({
                        label: 'PaddedTileGenUniform',
                        size: this._terrainUniformScratch.byteLength,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                    });
                }
                this.device.queue.writeBuffer(this._paddedTileGenUniformBuffer, 0, this._terrainUniformScratch);

                this._fillTerrainUniformScratch(chunkCoordX, chunkCoordY, innerSize, chunkGridSize, face);
                {
                    const v = new DataView(this._terrainUniformScratch);
                    v.setInt32(48, 7, true);
                    v.setFloat32(64, uvShift, true);
                    v.setFloat32(68, uvShift, true);
                }
                if (!this._paddedSmoothSplatDataUniformBuffer) {
                    this._paddedSmoothSplatDataUniformBuffer = this.device.createBuffer({
                        label: 'PaddedSmoothSplatDataUniform',
                        size: this._terrainUniformScratch.byteLength,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                    });
                }
                this.device.queue.writeBuffer(
                    this._paddedSmoothSplatDataUniformBuffer,
                    0,
                    this._terrainUniformScratch
                );

                this._fillTerrainUniformScratch(chunkCoordX, chunkCoordY, innerSize, chunkGridSize, face);
                {
                    const v = new DataView(this._terrainUniformScratch);
                    v.setInt32(48, 8, true);
                    v.setFloat32(64, uvShift, true);
                    v.setFloat32(68, uvShift, true);
                }
                if (!this._paddedSmoothSplatIndexUniformBuffer) {
                    this._paddedSmoothSplatIndexUniformBuffer = this.device.createBuffer({
                        label: 'PaddedSmoothSplatIndexUniform',
                        size: this._terrainUniformScratch.byteLength,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
                    });
                }
                this.device.queue.writeBuffer(
                    this._paddedSmoothSplatIndexUniformBuffer,
                    0,
                    this._terrainUniformScratch
                );

                const { pipeline: tileGenPipeline, bindGroupLayout: tileGenBindGroupLayout } =
                    this._getTerrainPipelineForFormat('rgba8unorm');
                const { pipeline: smoothSourcePipeline, bindGroupLayout: smoothSourceBindGroupLayout } =
                    this._getTerrainPipelineForFormat('rgba8unorm');
                const { pipeline: splatPalettePipeline, bindGroupLayout: splatPaletteBindGroupLayout } =
                    this._getSplatPalettePipelineForFormat('rgba8unorm');
                const { pipeline: splatPipeline, bindGroupLayout: splatBindGroupLayout } =
                    this._getSplatPipelineForFormats(
                        splatPass.heightFormat || 'r32float',
                        'rgba8unorm'
                    );
                const { pipeline: splatValidityPipeline, bindGroupLayout: splatValidityBindGroupLayout } =
                    this._getSplatValidityPipelineForFormats('rgba8unorm', 'rgba8unorm');
                const constantProbePipeline = debugProbeTextures
                    ? this._getSplatDebugProbePipeline('constantWrite')
                    : null;
                const tileEchoProbePipeline = debugProbeTextures
                    ? this._getSplatDebugProbePipeline('tileEcho')
                    : null;
                const categoryEchoProbePipeline = debugProbeTextures
                    ? this._getSplatDebugProbePipeline('categoryEcho')
                    : null;

                if (shouldCaptureValidationError) {
                    this.device.pushErrorScope('validation');
                }

                const enc = this.device.createCommandEncoder({ label: 'PaddedQuadtreeSplat' });

                {
                    const pass = enc.beginComputePass({ label: 'GenPaddedTileMap' });
                    pass.setPipeline(tileGenPipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: tileGenBindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this._paddedTileGenUniformBuffer } },
                            { binding: 1, resource: paddedTileMap.createView() }
                        ]
                    }));
                    this._setTerrainBiomeBindGroup(pass);
                    pass.dispatchWorkgroups(
                        Math.ceil(paddedSize / 8),
                        Math.ceil(paddedSize / 8)
                    );
                    pass.end();
                }

                {
                    const pass = enc.beginComputePass({ label: 'GenPaddedSmoothSplatWeights' });
                    pass.setPipeline(smoothSourcePipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: smoothSourceBindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this._paddedSmoothSplatDataUniformBuffer } },
                            { binding: 1, resource: paddedSmoothSplatData.createView() }
                        ]
                    }));
                    this._setTerrainBiomeBindGroup(pass);
                    pass.dispatchWorkgroups(
                        Math.ceil(paddedSize / 8),
                        Math.ceil(paddedSize / 8)
                    );
                    pass.end();
                }

                {
                    const pass = enc.beginComputePass({ label: 'GenPaddedSmoothSplatIds' });
                    pass.setPipeline(smoothSourcePipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: smoothSourceBindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this._paddedSmoothSplatIndexUniformBuffer } },
                            { binding: 1, resource: paddedSmoothSplatIndex.createView() }
                        ]
                    }));
                    this._setTerrainBiomeBindGroup(pass);
                    pass.dispatchWorkgroups(
                        Math.ceil(paddedSize / 8),
                        Math.ceil(paddedSize / 8)
                    );
                    pass.end();
                }

                {
                    const pass = enc.beginComputePass({ label: 'ComputePaddedSplatPalette' });
                    pass.setPipeline(splatPalettePipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: splatPaletteBindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                            { binding: 1, resource: paddedTileMap.createView() },
                            { binding: 2, resource: splatPaletteTex.createView() },
                            { binding: 3, resource: paddedSmoothSplatData.createView() },
                            { binding: 4, resource: paddedSmoothSplatIndex.createView() }
                        ]
                    }));
                    pass.dispatchWorkgroups(
                        Math.ceil(paletteSize.width / 8),
                        Math.ceil(paletteSize.height / 8)
                    );
                    pass.end();
                }

                {
                    const pass = enc.beginComputePass({ label: 'ComputePaddedSplat' });
                    pass.setPipeline(splatPipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: splatBindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this.splatUniformBuffer } },
                            { binding: 1, resource: splatPass.heightTex.createView() },
                            { binding: 2, resource: paddedTileMap.createView() },
                            { binding: 3, resource: splatPass.splatTex.createView() },
                            { binding: 4, resource: splatIndexTex.createView() },
                            { binding: 5, resource: splatPaletteTex.createView() },
                            { binding: 6, resource: paddedSmoothSplatData.createView() },
                            { binding: 7, resource: paddedSmoothSplatIndex.createView() }
                        ]
                    }));
                    pass.dispatchWorkgroups(
                        Math.ceil(innerSize / 8),
                        Math.ceil(innerSize / 8)
                    );
                    pass.end();
                }

                {
                    const pass = enc.beginComputePass({ label: 'ComputePaddedSplatValidity' });
                    pass.setPipeline(splatValidityPipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: splatValidityBindGroupLayout,
                        entries: [
                            { binding: 0, resource: splatIndexTex.createView() },
                            { binding: 1, resource: splatValidTex.createView() }
                        ]
                    }));
                    pass.dispatchWorkgroups(
                        Math.ceil(innerSize / 8),
                        Math.ceil(innerSize / 8)
                    );
                    pass.end();
                }

                if (
                    splatPass.resolvedColorTex &&
                    splatPass.tileTex &&
                    splatPass.atlasTexture &&
                    splatPass.tileTypeLookup
                ) {
                    this._writeResolvedColorUniformBuffer({
                        chunkCoordX,
                        chunkCoordY,
                        chunkSizeTex: innerSize,
                        chunkGridSize,
                        face,
                        season: splatPass.resolvedColorSeason ?? 0,
                        atlasSampleLod: splatPass.resolvedColorAtlasSampleLod ?? 1.0
                    });
                    const pass = enc.beginComputePass({ label: 'ComputeResolvedTerrainColor' });
                    pass.setPipeline(this.resolvedColorPipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({
                        layout: this.resolvedColorBindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: this.resolvedColorUniformBuffer } },
                            { binding: 1, resource: splatPass.resolvedColorTex.createView() },
                            { binding: 2, resource: splatPass.splatTex.createView() },
                            { binding: 3, resource: splatIndexTex.createView() },
                            { binding: 4, resource: splatPass.tileTex.createView() },
                            { binding: 5, resource: splatPass.atlasTexture.createView({ dimension: '2d-array' }) },
                            { binding: 6, resource: splatPass.tileTypeLookup.createView() },
                            { binding: 7, resource: this.resolvedColorAtlasSampler }
                        ]
                    }));
                    pass.dispatchWorkgroups(
                        Math.ceil(innerSize / 8),
                        Math.ceil(innerSize / 8)
                    );
                    pass.end();

                    if (splatPass.resolvedColorResolveToTexture && splatPass.resolvedColorResolveToFormat) {
                        this.resolveTexture2D(
                            enc,
                            splatPass.resolvedColorTex,
                            'rgba8unorm',
                            splatPass.resolvedColorResolveToTexture,
                            splatPass.resolvedColorResolveToFormat,
                            innerSize,
                            innerSize
                        );
                    }
                }


                if (debugProbeTextures) {
                    {
                        const pass = enc.beginComputePass({ label: 'DebugSplatConstantWrite' });
                        pass.setPipeline(constantProbePipeline.pipeline);
                        pass.setBindGroup(0, this.device.createBindGroup({
                            layout: constantProbePipeline.bindGroupLayout,
                            entries: [
                                { binding: 0, resource: debugProbeTextures.constantWrite.createView() }
                            ]
                        }));
                        pass.dispatchWorkgroups(
                            Math.ceil(innerSize / 8),
                            Math.ceil(innerSize / 8)
                        );
                        pass.end();
                    }

                    {
                        const pass = enc.beginComputePass({ label: 'DebugSplatTileEcho' });
                        pass.setPipeline(tileEchoProbePipeline.pipeline);
                        pass.setBindGroup(0, this.device.createBindGroup({
                            layout: tileEchoProbePipeline.bindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: this._padTileUniformBuffer } },
                                { binding: 1, resource: paddedTileMap.createView() },
                                { binding: 2, resource: debugProbeTextures.tileEcho.createView() }
                            ]
                        }));
                        pass.dispatchWorkgroups(
                            Math.ceil(innerSize / 8),
                            Math.ceil(innerSize / 8)
                        );
                        pass.end();
                    }

                    {
                        const pass = enc.beginComputePass({ label: 'DebugSplatCategoryEcho' });
                        pass.setPipeline(categoryEchoProbePipeline.pipeline);
                        pass.setBindGroup(0, this.device.createBindGroup({
                            layout: categoryEchoProbePipeline.bindGroupLayout,
                            entries: [
                                { binding: 0, resource: { buffer: this._padTileUniformBuffer } },
                                { binding: 1, resource: paddedTileMap.createView() },
                                { binding: 2, resource: debugProbeTextures.categoryEcho.createView() }
                            ]
                        }));
                        pass.dispatchWorkgroups(
                            Math.ceil(innerSize / 8),
                            Math.ceil(innerSize / 8)
                        );
                        pass.end();
                    }
                }

                this.device.queue.submit([enc.finish()]);
                const validationErrorPromise = shouldCaptureValidationError
                    ? this.device.popErrorScope().catch(() => null)
                    : Promise.resolve(null);

                Promise.all([
                    this.device.queue.onSubmittedWorkDone().catch(() => null),
                    validationErrorPromise
                ])
                    .then(async ([, validationError]) => {
                        try {
                            await this._debugAnalyzeQuadtreeSplatPass(
                                splatPass,
                                paddedTileMap,
                                innerSize,
                                paddedSize,
                                padding,
                                chunkCoordX,
                                chunkCoordY,
                                chunkGridSize,
                                face,
                                shouldPrimeSplat ? splatPrimePattern : null,
                                debugProbeTextures,
                                validationError
                            );
                        } catch (err) {
                            Logger.warn(`${SPLAT_STEP_PREFIX} [SplatDebug] quadtree splat diagnostics failed: ${err?.message || err}`);
                        }
                        try { paddedTileMap.destroy(); } catch { /* ignore cleanup failure */ }
                        try { paddedSmoothSplatData.destroy(); } catch { /* ignore cleanup failure */ }
                        try { paddedSmoothSplatIndex.destroy(); } catch { /* ignore cleanup failure */ }
                        try { splatPaletteTex.destroy(); } catch { /* ignore cleanup failure */ }
                        if (debugProbeTextures) {
                            try { debugProbeTextures.constantWrite.destroy(); } catch { /* ignore cleanup failure */ }
                            try { debugProbeTextures.tileEcho.destroy(); } catch { /* ignore cleanup failure */ }
                            try { debugProbeTextures.categoryEcho.destroy(); } catch { /* ignore cleanup failure */ }
                        }
                    })
                    .catch(() => {});
            },

        runBatchedTilePasses(config) {
                const {
                    chunkCoordX, chunkCoordY, chunkSizeTex,
                    chunkGridSize, face, terrainPasses, splatPass
                } = config;

                this._writeBatchedTerrainUniforms(
                    terrainPasses,
                    chunkCoordX,
                    chunkCoordY,
                    chunkSizeTex,
                    chunkGridSize,
                    face
                );
                const enc = this.device.createCommandEncoder({ label: 'TerrainBatch' });
                for (let i = 0; i < terrainPasses.length; i++) {
                    this._encodeBatchedTerrainPass(enc, terrainPasses[i], this._batchTerrainUniforms[i]);
                }
                this.device.queue.submit([enc.finish()]);

                if (splatPass) {
                    this._runPaddedQuadtreeSplatPass(
                        splatPass,
                        chunkCoordX,
                        chunkCoordY,
                        chunkGridSize,
                        face
                    );
                }
            },

        _writeBatchedTerrainUniforms(terrainPasses, chunkCoordX, chunkCoordY, chunkSizeTex, chunkGridSize, face) {
                const scratchView = this._fillTerrainUniformScratch(
                    chunkCoordX,
                    chunkCoordY,
                    chunkSizeTex,
                    chunkGridSize,
                    face
                );

                for (let i = 0; i < terrainPasses.length; i++) {
                    scratchView.setInt32(48, terrainPasses[i].outputType, true);
                    this.device.queue.writeBuffer(
                        this._batchTerrainUniforms[i],
                        0,
                        this._terrainUniformScratch
                    );
                }
            },

        _encodeBatchedTerrainPass(enc, terrainPass, uniformBuffer) {
                const { pipeline, bindGroupLayout, entries } =
                    this._createBatchedTerrainPassResources(terrainPass, uniformBuffer);
                const pass = enc.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this.device.createBindGroup({ layout: bindGroupLayout, entries }));
                this._setTerrainBiomeBindGroup(pass);
                pass.dispatchWorkgroups(
                    Math.ceil(terrainPass.textureSize / 8),
                    Math.ceil(terrainPass.textureSize / 8)
                );
                pass.end();

                if (terrainPass.resolveToTexture && terrainPass.resolveToFormat) {
                    this.resolveTexture2D(
                        enc,
                        terrainPass.texture,
                        terrainPass.format,
                        terrainPass.resolveToTexture,
                        terrainPass.resolveToFormat,
                        terrainPass.textureSize,
                        terrainPass.textureSize
                    );
                }
            },

        _createBatchedTerrainPassResources(terrainPass, uniformBuffer) {
                if (this._isMicroTerrainPass(terrainPass)) {
                    const { pipeline, bindGroupLayout } = this._getMicroPipelineForFormat(
                        terrainPass.format,
                        terrainPass.heightTextureFormat,
                        terrainPass.tileTextureFormat
                    );
                    return {
                        pipeline,
                        bindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: uniformBuffer } },
                            { binding: 1, resource: terrainPass.texture.createView() },
                            { binding: 2, resource: terrainPass.heightTexture.createView() },
                            { binding: 3, resource: terrainPass.tileTexture.createView() }
                        ]
                    };
                }

                if (this._isHeightInputTerrainPass(terrainPass)) {
                    const { pipeline, bindGroupLayout } = this._getHeightInputPipelineForFormat(
                        terrainPass.format,
                        terrainPass.heightTextureFormat
                    );
                    return {
                        pipeline,
                        bindGroupLayout,
                        entries: [
                            { binding: 0, resource: { buffer: uniformBuffer } },
                            { binding: 1, resource: terrainPass.texture.createView() },
                            { binding: 2, resource: terrainPass.heightTexture.createView() }
                        ]
                    };
                }

                const { pipeline, bindGroupLayout } = this._getTerrainPipelineForFormat(terrainPass.format);
                return {
                    pipeline,
                    bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: uniformBuffer } },
                        { binding: 1, resource: terrainPass.texture.createView() }
                    ]
                };
            },

        _isMicroTerrainPass(terrainPass) {
                return (terrainPass.outputType === 4 || terrainPass.outputType === 5 || terrainPass.outputType === 6)
                    && terrainPass.heightTexture
                    && terrainPass.tileTexture;
            },

        _isHeightInputTerrainPass(terrainPass) {
                return !this._isMicroTerrainPass(terrainPass)
                    && (
                        terrainPass.outputType === 1 ||
                        terrainPass.outputType === 2 ||
                        terrainPass.outputType === 7 ||
                        terrainPass.outputType === 8
                    )
                    && terrainPass.heightTexture;
            },

        _writeSplatUniformBuffer({
                chunkCoordX = 0,
                chunkCoordY = 0,
                chunkSizeTex,
                inputPadding = 0,
            }) {
                const data = new ArrayBuffer(80);
                const view = new DataView(data);
                view.setInt32(0, chunkCoordX | 0, true);
                view.setInt32(4, chunkCoordY | 0, true);
                view.setInt32(8, chunkSizeTex | 0, true);
                view.setInt32(12, this.seed, true);
                view.setInt32(16, this.splatDensity, true);
                view.setInt32(20, this.splatKernelSize, true);
                view.setInt32(24, inputPadding | 0, true);
                view.setInt32(
                    28,
                    this.splatChunkPaletteEnabled ? (this.splatChunkPaletteBorderTexels | 0) : 0,
                    true
                );
                view.setFloat32(32, this.splatTransitionSharpness, true);
                view.setFloat32(36, this.splatTransitionDominanceStart, true);
                view.setFloat32(40, this.splatTransitionDominanceEnd, true);
                view.setFloat32(44, this.splatCenterCategoryBias, true);
                view.setFloat32(48, this.splatTransitionBreakupScale, true);
                view.setFloat32(52, this.splatTransitionBreakupWarpScale, true);
                view.setFloat32(56, this.splatTransitionBreakupWarpStrength, true);
                view.setFloat32(60, this.splatTransitionBreakupStrength, true);
                view.setFloat32(
                    64,
                    this.splatChunkPaletteEnabled ? this.splatChunkPaletteMinCoverage : 2.0,
                    true
                );
                view.setFloat32(68, this.splatSlotSupportExpansionTexels, true);
                view.setFloat32(72, 0.0, true);
                view.setFloat32(76, 0.0, true);
                this.device.queue.writeBuffer(this.splatUniformBuffer, 0, data);
            },

        _writeResolvedColorUniformBuffer({
                chunkCoordX = 0,
                chunkCoordY = 0,
                chunkSizeTex = 1,
                chunkGridSize = 1,
                face = 0,
                season = 0,
                atlasSampleLod = 1.0,
            } = {}) {
                const data = new ArrayBuffer(64);
                const view = new DataView(data);
                view.setInt32(0, chunkCoordX | 0, true);
                view.setInt32(4, chunkCoordY | 0, true);
                view.setInt32(8, Math.max(1, chunkSizeTex | 0), true);
                view.setInt32(12, Math.max(1, chunkGridSize | 0), true);
                view.setInt32(16, this.seed | 0, true);
                view.setInt32(20, face | 0, true);
                view.setInt32(24, season | 0, true);
                view.setInt32(28, 0, true);
                view.setFloat32(32, Number.isFinite(this.worldScale) ? this.worldScale : 1.0, true);
                view.setFloat32(36, Math.max(0.0, atlasSampleLod), true);
                this.device.queue.writeBuffer(this.resolvedColorUniformBuffer, 0, data);
            }
        })
    );
}
